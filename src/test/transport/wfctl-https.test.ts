import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex, Readable } from 'node:stream';
import { TLSSocket } from 'node:tls';
import test from 'node:test';
import * as vm from 'node:vm';

type Wfctl = typeof import('../../wfctl.js');
type TransferPhase = 'transfer' | 'peer-close' | 'cleanup';

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function receiveBytes(stream: IncomingMessage, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let resolve!: (bytes: Buffer) => void;
  let reject!: (error: Error) => void;
  const received = new Promise<Buffer>((yes, no) => { resolve = yes; reject = no; });
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= length) resolve(Buffer.concat(chunks));
  };
  const onEnd = () => reject(new Error('Asset ended before the expected partial bytes'));
  stream.on('data', onData).once('error', reject).once('end', onEnd);
  try {
    return await within(received, 'real asset bytes');
  } finally {
    stream.off('data', onData).off('error', reject).off('end', onEnd);
  }
}

// Standalone Node test; intentionally outside the IDE-host suite.
// TLS material belongs to this run. No executable fixture is ever launched.
test('real HTTPS interruption preserves the cache and cleans staging', { timeout: 15000 }, async () => {
  const tlsDir = process.env.WFCTL_TLS_DIR;
  assert.ok(tlsDir && path.isAbsolute(tlsDir), 'WFCTL_TLS_DIR must name the owned TLS fixture directory');
  const certificate = fs.readFileSync(path.join(tlsDir, 'cert.pem'));
  const key = fs.readFileSync(path.join(tlsDir, 'key.pem'));
  const sockets = new Set<Duplex>();
  const requests: ClientRequest[] = [];
  const responses: IncomingMessage[] = [];
  const writes: fs.WriteStream[] = [];
  let phase: TransferPhase = 'transfer';
  const writerErrors: { code: string | undefined; phase: TransferPhase }[] = [];
  let passed = false;
  const requestedUrls: string[] = [];
  let assetResponse: ServerResponse | undefined;
  let assetIncoming: IncomingMessage | undefined;
  let reportPipe!: (source: Readable) => void;
  let reportOpen!: () => void;
  const piped = new Promise<Readable>(resolve => { reportPipe = resolve; });
  const opened = new Promise<void>(resolve => { reportOpen = resolve; });
  const partial = Buffer.from('partial inert text fixture');
  const oldBytes = Buffer.from('existing inert cached fixture');
  const tag = 'v0.0.0-transport-test';
  const server = https.createServer({ key, cert: certificate }, (request, response) => {
    if (request.url === '/metadata') {
      response.end(JSON.stringify({ tag_name: tag }));
    } else if (request.url === '/asset') {
      assetResponse = response;
      response.writeHead(200, { 'Content-Length': partial.length + 100 });
      // Hold the body until the production downloader has attached its pipe.
      response.flushHeaders();
    } else {
      response.writeHead(404).end();
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfctl-https-'));

  try {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await within(listening, 'loopback listener');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `https://127.0.0.1:${address.port}`;
    const metadataUrl = 'https://api.github.com/repos/GoCodeAlone/workflow/releases/latest';
    let assetUrl = '';
    const routedHttps = {
      ...https,
      get(url: string, options: https.RequestOptions, callback: (response: IncomingMessage) => void) {
        // Unknown original URLs fail before a socket is created. Never contact a release endpoint.
        const route = url === metadataUrl ? '/metadata' : url === assetUrl ? '/asset' : undefined;
        assert.ok(route, `Unexpected downloader URL: ${url}`);
        requestedUrls.push(url);
        const request = https.get(`${origin}${route}`, {
          headers: options.headers,
          ca: certificate,
          rejectUnauthorized: true,
          servername: 'localhost',
          agent: false,
        }, response => {
          responses.push(response);
          // Observe discarded-response errors without settling the downloader's promise.
          response.on('error', () => {});
          if (route === '/asset') assetIncoming = response;
          callback(response);
        });
        requests.push(request);
        return request;
      },
    };
    const trackedFs = {
      ...fs,
      createWriteStream(...args: Parameters<typeof fs.createWriteStream>): fs.WriteStream {
        const stream = fs.createWriteStream(...args);
        // Teardown can destroy the original downloader's writer with I/O pending.
        // Record its error without throwing or settling the downloader's promise.
        stream.on('error', (error: NodeJS.ErrnoException) => {
          writerErrors.push({ code: error.code, phase });
        });
        writes.push(stream);
        stream.once('open', reportOpen);
        stream.once('pipe', reportPipe);
        return stream;
      },
    };
    const editor = {
      workspace: { getConfiguration: () => ({ get: () => '' }) },
      window: { showInformationMessage: () => { throw new Error('Unexpected download prompt'); } },
    };
    const filename = path.resolve(process.env.WFCTL_MODULE ?? path.join(__dirname, '../../wfctl.js'));
    const module = { exports: {} as Wfctl };
    const wrapper = new vm.Script(
      `(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`,
      { filename },
    ).runInNewContext({ Buffer, process, URL, setTimeout, clearTimeout, setImmediate, queueMicrotask });
    wrapper((name: string) => {
      if (name === 'vscode') return editor;
      if (name === 'https' || name === 'node:https') return routedHttps;
      if (name === 'fs' || name === 'node:fs') return trackedFs;
      return require(name);
    }, module, module.exports, filename, path.dirname(filename));
    const api = module.exports;
    assetUrl = api.buildDownloadUrl('wfctl', tag);
    const context = { globalStorageUri: { fsPath: root } } as Parameters<Wfctl['downloadWfctl']>[0];
    const output = { appendLine: (_value: string) => {} } as Parameters<Wfctl['downloadWfctl']>[1];
    const destination = api.getDefaultWfctlPath(context);
    const destinationDir = path.dirname(destination);
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.writeFileSync(destination, oldBytes, { mode: 0o755 });
    const oldMode = fs.statSync(destination).mode;
    const outcome = api.downloadWfctl(context, output).then(
      () => ({ ok: true as const }),
      (error: Error & { code?: string }) => ({ ok: false as const, error }),
    );

    const [incoming] = await Promise.all([within(piped, 'production pipe'), within(opened, 'file open')]);
    assert.ok(incoming instanceof IncomingMessage);
    assert.strictEqual(incoming, assetIncoming);
    assert.ok(incoming.socket instanceof TLSSocket);
    assert.equal(incoming.socket.authorized, true, 'fixture TLS certificate must be verified');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request instanceof ClientRequest));
    assert.equal(writes.length, 1);
    assert.ok(assetResponse?.socket);
    const received = receiveBytes(incoming, partial.length);
    assetResponse.write(partial);
    const chunk = await received;
    assert.deepEqual(chunk, partial);
    assert.equal(writerErrors.length, 0, 'writer error before intentional peer close');
    assert.deepEqual(fs.readFileSync(destination), oldBytes, 'cached bytes changed while HTTPS transfer is active');
    assert.equal(fs.statSync(destination).mode, oldMode);

    // Cause the failure here, before cleanup, through the actual peer connection.
    phase = 'peer-close';
    assetResponse.socket.destroy();
    const result = await within(outcome, 'download rejection after peer close');
    assert.equal(result.ok, false, 'incomplete HTTPS transfer must reject');
    if (result.ok) throw new Error('Unreachable successful transfer');
    assert.match(result.error.code ?? '', /^(ECONNRESET|ERR_STREAM_PREMATURE_CLOSE)$/);
    assert.ok(writerErrors.every(error => error.phase === 'peer-close' &&
      /^(ECONNRESET|ERR_STREAM_PREMATURE_CLOSE)$/.test(error.code ?? '')), 'unexpected writer error during peer close');
    assert.equal(incoming.complete, false);
    assert.deepEqual(fs.readFileSync(destination), oldBytes);
    assert.equal(fs.statSync(destination).mode, oldMode);
    assert.deepEqual(fs.readdirSync(destinationDir), [path.basename(destination)]);
    assert.equal(await api.resolveWfctlPath(context, output), destination);
    assert.deepEqual(requestedUrls, [metadataUrl, assetUrl], 'cached resolution must not issue a request');
    passed = true;
  } finally {
    console.log('wfctl fixture cleanup started:', JSON.stringify({ phase, pendingWriteBytes: writes.map(stream => stream.writableLength) }));
    phase = 'cleanup';
    try {
      for (const request of requests) request.destroy();
      for (const response of responses) response.destroy();
      for (const socket of sockets) socket.destroy();
      for (const stream of writes) {
        const closed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once('close', resolve));
        stream.destroy();
        await within(closed, 'owned file close');
      }
      if (server.listening) {
        await within(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 'server close');
      }
      assert.ok(writes.every(stream => stream.closed), 'owned writers must be closed');
      assert.equal(server.listening, false, 'owned server must be closed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'owned fixture directory must be removed');
      console.log('wfctl fixture root absence verified');
    }
    console.log('wfctl fixture writer errors:', JSON.stringify(writerErrors));
    assert.ok(writerErrors.filter(error => error.phase === 'cleanup').every(error =>
      !passed && error.code === 'ERR_STREAM_DESTROYED'), 'unexpected writer error during cleanup');
    console.log('wfctl fixture cleanup: writes closed; server closed; root absent');
  }
});
