import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { EventEmitter, once } from 'events';
import { PassThrough } from 'stream';
import type { IncomingHttpHeaders } from 'http';

type Wfctl = typeof import('../../wfctl.js');

class Response extends PassThrough {
  statusCode = 200;
  headers: IncomingHttpHeaders = {};
  complete = false;
  private reportPipe!: (destination: NodeJS.WritableStream) => void;
  readonly piped = new Promise<NodeJS.WritableStream>(resolve => { this.reportPipe = resolve; });

  override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    this.reportPipe(destination);
    return super.pipe(destination, options);
  }
}

class Request extends EventEmitter {
  response?: Response;
  private timeoutCallback?: () => void;

  setTimeout(_milliseconds: number, callback: () => void): this {
    this.timeoutCallback = callback;
    return this;
  }

  fireTimeout(): void {
    if (!this.timeoutCallback) {
      this.destroy(new Error('Request timeout is not configured'));
      return;
    }
    this.timeoutCallback();
  }

  destroy(error?: Error): this {
    this.response?.destroy(error);
    if (error) this.emit('error', error);
    return this;
  }
}

interface Reply {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string;
  error?: string;
  interrupt?: boolean;
  incomplete?: boolean;
  timeout?: 'before-headers' | 'during-transfer';
  hold?: (response: Response) => void;
}

const release: Reply = { body: JSON.stringify({ tag_name: 'v1.2.3-rc.1' }) };
const oldBytes = 'existing usable wfctl fixture';
const newBytes = 'replacement wfctl fixture';

/** Real module/filesystem with editor/HTTPS substitutes and opt-in local filesystem faults. No binary is executed. */
function fixture(root: string) {
  const replies: Reply[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const responses: Response[] = [];
  const logs: string[] = [];
  let customPath = '';
  let choice = 'Skip';
  let prompts = 0;
  let failChmod = false;
  let failCleanup = false;
  const filesystem = {
    ...fs,
    chmodSync(...args: Parameters<typeof fs.chmodSync>): void {
      if (failChmod) throw new Error('Injected chmod failure');
      fs.chmodSync(...args);
    },
    rmSync(...args: Parameters<typeof fs.rmSync>): void {
      if (failCleanup) throw new Error('Injected cleanup failure');
      fs.rmSync(...args);
    },
  };
  const fakeVscode = {
    workspace: { getConfiguration: () => ({ get: () => customPath }) },
    window: {
      showInformationMessage: async () => { prompts++; return choice; },
      withProgress: async (_options: unknown, task: () => Promise<void>) => task(),
    },
    ProgressLocation: { Notification: 15 },
  };
  const fakeHttps = {
    get(url: string, options: { headers: Record<string, string> }, callback: (res: Response) => void) {
      requests.push({ url, headers: options.headers });
      const request = new Request();
      const reply = replies.shift();
      setImmediate(() => {
        if (!reply || reply.error) {
          request.emit('error', new Error(reply?.error ?? `Unexpected HTTPS request: ${url}`));
          return;
        }
        if (reply.timeout === 'before-headers') {
          request.fireTimeout();
          return;
        }
        const response = new Response();
        responses.push(response);
        request.response = response;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        // Keep old implementations' missing response-error listener from crashing the runner.
        // The download promise still has to reject; this listener does not settle it.
        response.on('error', () => {});
        callback(response);
        if (reply.hold) {
          reply.hold(response);
        } else if (reply.timeout === 'during-transfer') {
          response.write('partial bytes');
          setImmediate(() => request.fireTimeout());
        } else if (reply.interrupt) {
          response.write(reply.body ?? 'partial bytes');
          setImmediate(() => response.destroy(new Error('Transfer interrupted')));
        } else {
          response.complete = !reply.incomplete;
          response.end(reply.body ?? '');
        }
      });
      return request;
    },
  };
  const filename = path.resolve(__dirname, '../../wfctl.js');
  const module = { exports: {} as Wfctl };
  const wrapper = new vm.Script(
    `(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename },
  ).runInNewContext({ Buffer, process, URL, setTimeout, clearTimeout, setImmediate, queueMicrotask });
  wrapper((name: string) => {
    if (name === 'vscode') return fakeVscode;
    if (name === 'https' || name === 'node:https') return fakeHttps;
    if (name === 'fs' || name === 'node:fs') return filesystem;
    return require(name);
  }, module, module.exports, filename, path.dirname(filename));

  const api = module.exports;
  const context = { globalStorageUri: { fsPath: root } } as Parameters<Wfctl['downloadWfctl']>[0];
  const output = { appendLine: (line: string) => { logs.push(line); } } as Parameters<Wfctl['downloadWfctl']>[1];
  const dest = api.getDefaultWfctlPath(context);
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true });
  return {
    api, context, output, replies, requests, logs, dest, destDir,
    setChoice(value: string) { choice = value; },
    setCustomPath(value: string) { customPath = value; },
    failChmod() { failChmod = true; },
    failCleanup() { failCleanup = true; },
    get prompts() { return prompts; },
    seed() { fs.writeFileSync(dest, oldBytes, { mode: 0o755 }); },
    assertClean(hasBinary: boolean) {
      assert.deepStrictEqual(fs.readdirSync(destDir), hasBinary ? [path.basename(dest)] : [], 'no staging files remain');
    },
    close() { for (const response of responses) response.destroy(); },
    download() { return api.downloadWfctl(context, output); },
    resolve() { return api.resolveWfctlPath(context, output); },
  };
}

suite('wfctl download recovery', () => {
  let root: string;
  let f: ReturnType<typeof fixture>;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfctl-download-test-'));
    f = fixture(root);
  });

  teardown(() => {
    f?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const failures: { name: string; replies: Reply[]; error: RegExp }[] = [
    { name: 'HTTP failure', replies: [{ status: 404, body: 'not found' }], error: /status 404/ },
    { name: 'request failure', replies: [{ error: 'Connection failed' }], error: /Connection failed/ },
    { name: 'missing redirect location', replies: [{ status: 302 }], error: /Redirect with no location/ },
    { name: 'redirect limit', replies: Array.from({ length: 5 }, () => ({ status: 302, headers: { location: 'https://downloads.example/loop' } })), error: /Too many redirects/ },
    { name: 'redirected request failure', replies: [{ status: 302, headers: { location: 'https://downloads.example/asset' } }, { error: 'Redirect connection failed' }], error: /Redirect connection failed/ },
    { name: 'interrupted transfer', replies: [{ interrupt: true }], error: /Transfer interrupted/ },
    { name: 'incomplete HTTP message', replies: [{ body: 'partial bytes', incomplete: true }], error: /empty or incomplete/ },
    { name: 'empty response', replies: [{ body: '' }], error: /empty or incomplete/ },
    { name: 'content-length mismatch', replies: [{ body: 'short', headers: { 'content-length': '100' } }], error: /Content-Length/ },
    { name: 'timeout before headers', replies: [{ timeout: 'before-headers' }], error: /Download request timed out/ },
    { name: 'timeout during transfer', replies: [{ timeout: 'during-transfer' }], error: /Download request timed out/ },
  ];

  for (const failure of failures) {
    for (const existing of [true, false]) {
      test(`${failure.name} ${existing ? 'preserves the existing binary' : 'leaves no cached binary'}`, async () => {
        if (existing) f.seed();
        const mode = existing ? fs.statSync(f.dest).mode : undefined;
        f.replies.push(release, ...failure.replies);
        await assert.rejects(f.download(), failure.error);
        if (existing) {
          assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
          assert.strictEqual(fs.statSync(f.dest).mode, mode, 'existing executable mode is preserved');
        } else {
          assert.strictEqual(fs.existsSync(f.dest), false);
        }
        f.assertClean(existing);
        assert.ok(!f.logs.some(line => line.includes('installed to')), 'failure must not announce installation');
      });
    }
  }

  const metadataFailures: { name: string; reply: Reply; error: RegExp }[] = [
    { name: 'HTTP error with a valid tag', reply: { ...release, status: 403 }, error: /status 403/ },
    { name: 'missing tag', reply: { body: '{}' }, error: /No tag_name/ },
    { name: 'empty tag', reply: { body: JSON.stringify({ tag_name: '' }) }, error: /No tag_name/ },
    { name: 'malformed JSON', reply: { body: '{' }, error: /JSON/ },
    { name: 'incomplete message', reply: { ...release, incomplete: true }, error: /Incomplete GitHub release response/ },
  ];
  for (const failure of metadataFailures) {
    test(`release metadata rejects ${failure.name} before requesting an asset`, async () => {
      f.seed();
      f.replies.push(failure.reply);
      await assert.rejects(f.download(), failure.error);
      assert.strictEqual(f.requests.length, 1, 'invalid metadata must not request an asset');
      assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
      f.assertClean(true);
      assert.ok(!f.logs.some(line => line.includes('installed to')));
    });
  }

  test('filesystem write failure preserves the cache and removes staging', async () => {
    f.seed();
    let obstructedStage: string | undefined;
    f.replies.push(release, {
      hold: response => {
        obstructedStage = fs.readdirSync(f.destDir).find(name => name.startsWith('.wfctl-download-'));
        if (obstructedStage) fs.mkdirSync(path.join(f.destDir, obstructedStage, path.basename(f.dest)));
        response.complete = true;
        response.end(newBytes);
      },
    });
    await assert.rejects(f.download(), /EISDIR|EEXIST|EPERM/);
    assert.ok(obstructedStage, 'fixture must obstruct the staged file, never the published cache');
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
    f.assertClean(true);
    assert.ok(!f.logs.some(line => line.includes('installed to')));
  });

  test('failed rename preserves a destination directory and removes staging', async () => {
    fs.mkdirSync(f.dest);
    const sentinel = path.join(f.dest, 'keep');
    fs.writeFileSync(sentinel, oldBytes);
    f.replies.push(release, { body: newBytes });
    await assert.rejects(f.download(), /EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|EPERM/);
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), oldBytes);
    f.assertClean(true);
    assert.ok(!f.logs.some(line => line.includes('installed to')));
  });

  test('chmod failure preserves existing bytes and mode and removes staging', async () => {
    f.seed();
    const mode = fs.statSync(f.dest).mode;
    f.failChmod();
    f.replies.push(release, { body: newBytes });
    await assert.rejects(f.download(), /Injected chmod failure/);
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
    assert.strictEqual(fs.statSync(f.dest).mode, mode);
    f.assertClean(true);
    assert.ok(!f.logs.some(line => line.includes('installed to')));
  });

  test('cleanup failure retains the original HTTP rejection and cached binary', async () => {
    f.seed();
    f.failCleanup();
    f.replies.push(release, { status: 404 });
    await assert.rejects(f.download(), /status 404/);
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
    assert.ok(f.logs.some(line => line.includes('Could not remove download staging directory') && line.includes('Injected cleanup failure')));
    assert.ok(!f.logs.some(line => line.includes('installed to')));
    assert.strictEqual(fs.readdirSync(f.destDir).filter(name => name.startsWith('.wfctl-download-')).length, 1);
  });

  test('cleanup failure retains a successful replacement and logs the cleanup error', async () => {
    f.seed();
    f.failCleanup();
    f.replies.push(release, { body: newBytes });
    assert.strictEqual(await f.download(), undefined);
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), newBytes);
    assert.ok(f.logs.some(line => line.includes('Could not remove download staging directory') && line.includes('Injected cleanup failure')));
    assert.ok(f.logs.some(line => line === `wfctl installed to ${f.dest}`));
    const stages = fs.readdirSync(f.destDir).filter(name => name.startsWith('.wfctl-download-'));
    assert.strictEqual(stages.length, 1);
    assert.deepStrictEqual(fs.readdirSync(path.join(f.destDir, stages[0])), [], 'the installed binary must have left staging');
  });

  test('successful redirected download replaces the cache and preserves release URL behavior', async () => {
    f.seed();
    f.replies.push(release,
      { status: 301, headers: { location: 'https://downloads.example/first' } },
      { status: 302, headers: { location: '/final' } },
      { body: newBytes, headers: { 'content-length': String(Buffer.byteLength(newBytes)) } },
    );
    assert.strictEqual(await f.download(), undefined, 'updater contract remains Promise<void>');
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), newBytes);
    if (os.platform() !== 'win32') assert.strictEqual(fs.statSync(f.dest).mode & 0o777, 0o755);
    f.assertClean(true);
    assert.strictEqual(f.requests[1].url, f.api.buildDownloadUrl('wfctl', 'v1.2.3-rc.1'));
    assert.strictEqual(f.requests[3].url, 'https://downloads.example/final');
    assert.ok(f.requests.every(request => request.headers['User-Agent'] === 'workflow-vscode'));
    assert.ok(f.logs.some(line => line === `wfctl installed to ${f.dest}`));
  });

  test('cache remains usable while an update is still receiving bytes', async () => {
    f.seed();
    let releaseResponse!: (response: Response) => void;
    const receiving = new Promise<Response>(resolve => { releaseResponse = resolve; });
    f.replies.push(release, { hold: releaseResponse });
    const updating = f.download();
    const response = await receiving;
    try {
      const file = await response.piped as fs.WriteStream;
      if (file.pending) await once(file, 'open');
      response.write('replacement ');
      assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
      assert.strictEqual(await f.resolve(), f.dest);
      assert.strictEqual(f.prompts, 0);
      assert.ok(!f.logs.some(line => line.includes('installed to')));
    } finally {
      response.complete = true;
      response.end('wfctl fixture');
      await updating;
    }
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), newBytes);
    f.assertClean(true);
  });

  test('failed first download prompts again and can recover on retry', async () => {
    f.setChoice('Download');
    f.replies.push(release, { status: 503 });
    await assert.rejects(f.resolve(), /status 503/);
    f.assertClean(false);
    f.setChoice('Skip');
    await assert.rejects(f.resolve(), /wfctl not available/);
    assert.strictEqual(f.prompts, 2, 'failed download must not become a cache hit');
    f.setChoice('Download');
    f.replies.push(release, { body: newBytes });
    assert.strictEqual(await f.resolve(), f.dest);
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), newBytes);
    assert.strictEqual(f.prompts, 3);
    f.assertClean(true);
  });

  test('valid cached binary resolves without a prompt or request', async () => {
    f.seed();
    assert.strictEqual(await f.resolve(), f.dest);
    assert.strictEqual(f.prompts, 0);
    assert.deepStrictEqual(f.requests, []);
    assert.strictEqual(fs.readFileSync(f.dest, 'utf8'), oldBytes);
  });

  for (const invalid of ['empty file', 'directory', 'non-executable file']) {
    test(`default cache rejects ${invalid}`, async function () {
      if (invalid === 'non-executable file' && os.platform() === 'win32') this.skip();
      if (invalid === 'directory') fs.mkdirSync(f.dest);
      else fs.writeFileSync(f.dest, invalid === 'empty file' ? '' : oldBytes, { mode: invalid === 'empty file' ? 0o755 : 0o600 });
      await assert.rejects(f.resolve(), /wfctl not available/);
      assert.strictEqual(f.prompts, 1);
      assert.deepStrictEqual(f.requests, []);
    });
  }

  test('explicit custom path keeps its existing resolution contract', async () => {
    const custom = path.join(root, 'custom-wfctl');
    fs.writeFileSync(custom, '');
    f.setCustomPath(custom);
    assert.strictEqual(await f.resolve(), custom);
    assert.strictEqual(f.prompts, 0);
    assert.deepStrictEqual(f.requests, []);
  });
});
