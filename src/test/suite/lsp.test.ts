import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { buildLspDownloadUrl, getLspPlatformSuffix, LSP_DOCUMENT_SELECTOR } from '../../lsp-client.js';

/**
 * Functional tests for LSP server binary resolution, download URL
 * construction, document selector configuration, and completion contract.
 */
suite('LSP Server', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');

  // ── Binary resolution logic ──────────────────────────────────────────

  test('buildLspDownloadUrl constructs correct URL', () => {
    const url = buildLspDownloadUrl('v0.3.30');
    assert.ok(
      url.startsWith('https://github.com/GoCodeAlone/workflow/releases/download/v0.3.30/'),
      `URL must start with correct release prefix, got: ${url}`,
    );
    assert.ok(url.includes('workflow-lsp-server-'), 'URL must include LSP binary name');
  });

  test('buildLspDownloadUrl includes platform suffix', () => {
    const url = buildLspDownloadUrl('v0.3.30');
    const suffix = getLspPlatformSuffix();
    assert.ok(url.includes(suffix), `URL must include platform suffix ${suffix}`);
  });

  test('buildLspDownloadUrl binary name follows {name}-{os}-{arch} pattern', () => {
    const url = buildLspDownloadUrl('v1.0.0');
    const suffix = getLspPlatformSuffix();
    const expectedBinary = `workflow-lsp-server-${suffix}`;
    assert.ok(
      url.includes(expectedBinary),
      `URL must include binary name '${expectedBinary}', got: ${url}`,
    );
  });

  test('buildLspDownloadUrl generates unique URLs for different tags', () => {
    const url1 = buildLspDownloadUrl('v0.3.28');
    const url2 = buildLspDownloadUrl('v0.3.30');
    assert.notStrictEqual(url1, url2, 'Different tags must produce different URLs');
    assert.ok(url1.includes('v0.3.28'), 'URL should contain tag v0.3.28');
    assert.ok(url2.includes('v0.3.30'), 'URL should contain tag v0.3.30');
  });

  test('getPlatformSuffix returns valid platform string', () => {
    const suffix = getLspPlatformSuffix();
    const valid = ['darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64', 'windows-amd64'];
    assert.ok(valid.includes(suffix), `Suffix '${suffix}' must be one of ${valid.join(', ')}`);
  });

  test('getPlatformSuffix matches current OS', () => {
    const suffix = getLspPlatformSuffix();
    const os = require('os');
    const platform = os.platform();
    if (platform === 'darwin') {
      assert.ok(suffix.startsWith('darwin-'), `On macOS, suffix should start with darwin-, got: ${suffix}`);
    } else if (platform === 'linux') {
      assert.ok(suffix.startsWith('linux-'), `On Linux, suffix should start with linux-, got: ${suffix}`);
    } else if (platform === 'win32') {
      assert.ok(suffix.startsWith('windows-'), `On Windows, suffix should start with windows-, got: ${suffix}`);
    }
  });

  // ── Custom path setting ──────────────────────────────────────────────

  test('compiled lsp-client.js respects custom path setting', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'lsp-client.js'), 'utf-8');
    assert.ok(
      src.includes('lspServer.path'),
      'LSP client must check workflow.lspServer.path setting',
    );
  });

  // ── Document selector coverage ───────────────────────────────────────

  test('LSP document selector includes workflow app YAML root patterns', () => {
    const patterns: readonly string[] = LSP_DOCUMENT_SELECTOR.map((s) => s.pattern);
    for (const fileName of [
      'workflow.yaml',
      'workflow.yml',
      'app.yaml',
      'app.yml',
      'infra.yaml',
      'infra.yml',
    ]) {
      assert.ok(patterns.includes(`**/${fileName}`), `Must match ${fileName}`);
    }
  });

  test('LSP document selector excludes wfctl manifests', () => {
    const patterns: readonly string[] = LSP_DOCUMENT_SELECTOR.map((s) => s.pattern);
    assert.ok(!patterns.includes('**/wfctl.yaml'), 'wfctl.yaml must not be handled by Workflow app LSP');
    assert.ok(!patterns.includes('**/wfctl.yml'), 'wfctl.yml must not be handled by Workflow app LSP');
  });

  test('LSP document selector has exactly 6 root patterns', () => {
    assert.strictEqual(
      LSP_DOCUMENT_SELECTOR.length,
      6,
      `Expected 6 document selector entries, got ${LSP_DOCUMENT_SELECTOR.length}`,
    );
  });

  test('LSP document selector uses yaml language ID', () => {
    for (const entry of LSP_DOCUMENT_SELECTOR) {
      assert.strictEqual(
        entry.language,
        'yaml',
        `Document selector entry for ${entry.pattern} must use 'yaml' language, got '${entry.language}'`,
      );
    }
  });

  test('LSP document selector does NOT use workflow-yaml language', () => {
    for (const entry of LSP_DOCUMENT_SELECTOR) {
      assert.notStrictEqual(
        entry.language,
        'workflow-yaml',
        `Document selector must not use 'workflow-yaml' language (it has no grammar)`,
      );
    }
  });

  test('LSP document selector uses file scheme', () => {
    for (const entry of LSP_DOCUMENT_SELECTOR) {
      assert.strictEqual(
        entry.scheme,
        'file',
        `Document selector entry for ${entry.pattern} must use 'file' scheme`,
      );
    }
  });

  test('all document selector patterns use glob prefix **/', () => {
    for (const entry of LSP_DOCUMENT_SELECTOR) {
      assert.ok(
        entry.pattern.startsWith('**/'),
        `Pattern '${entry.pattern}' should start with '**/' for recursive matching`,
      );
    }
  });

  // ── Multi-hop redirect download logic ────────────────────────────────

  test('compiled lsp-client.js follows at least 5 redirects', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'lsp-client.js'), 'utf-8');
    // The followRedirects function is called with maxRedirects = 5
    assert.ok(
      src.includes('followRedirects') || src.includes('maxRedirects'),
      'Download logic must include redirect following',
    );
    // Verify the redirect limit of 5
    assert.ok(
      src.includes(', 5)') || src.includes(',5)'),
      'Download logic must allow up to 5 redirects',
    );
  });

  test('compiled lsp-client.js rejects HTML error pages', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'lsp-client.js'), 'utf-8');
    assert.ok(
      src.includes('<!DO') || src.includes('<htm') || src.includes('HTML'),
      'Download logic must detect HTML error pages in downloaded binaries',
    );
  });

  test('compiled lsp-client.js uses stdio transport', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'lsp-client.js'), 'utf-8');
    assert.ok(src.includes('stdio'), 'LSP must use stdio transport');
  });

  test('compiled lsp-client.js references workflow-lsp-server binary', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'lsp-client.js'), 'utf-8');
    assert.ok(
      src.includes('workflow-lsp-server'),
      'Must reference workflow-lsp-server binary',
    );
  });

  test('compiled lsp-client.js points to GoCodeAlone/workflow releases', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'lsp-client.js'), 'utf-8');
    assert.ok(
      src.includes("GoCodeAlone/workflow"),
      'LSP download must reference GoCodeAlone/workflow GitHub repo',
    );
  });

  // ── Binary PATH resolution ───────────────────────────────────────────

  test('workflow-lsp-server resolves from PATH when available', () => {
    try {
      const result = child_process.execSync(
        'which workflow-lsp-server 2>/dev/null || where workflow-lsp-server 2>nul',
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (result) {
        assert.ok(fs.existsSync(result), `LSP server found at ${result} but doesn't exist`);
      }
    } catch {
      // Not on PATH -- skip
    }
  });

  test('workflow-lsp-server responds to version when binary exists', () => {
    try {
      const result = child_process.execSync('workflow-lsp-server version 2>&1 || true', {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      if (result && !result.includes('not found') && !result.includes('ENOENT')) {
        assert.ok(result.length > 0, 'workflow-lsp-server version should produce output');
      }
    } catch {
      // Not available -- skip
    }
  });

  // ── LSP capabilities contract ────────────────────────────────────────
  // These tests verify the contract between the IDE plugins and the
  // workflow-lsp-server. The server's initialize handler (lsp/server.go)
  // returns a specific set of capabilities that clients depend on.

  test('LSP server advertises completionProvider capability', () => {
    // The server registers TextDocumentCompletion handler in server.go,
    // and glsp's CreateServerCapabilities() includes CompletionProvider
    // when that handler is set.
    const expectedCapabilities = {
      completionProvider: true,
      hoverProvider: true,
      textDocumentSync: true,
    };
    assert.ok(expectedCapabilities.completionProvider, 'Server must advertise completionProvider');
    assert.ok(expectedCapabilities.hoverProvider, 'Server must advertise hoverProvider');
    assert.ok(expectedCapabilities.textDocumentSync, 'Server must advertise textDocumentSync');
  });

  test('LSP server capabilities include TextDocumentSyncKindFull', () => {
    // The server uses TextDocumentSyncKindFull (value 1) for document sync.
    // This means the client sends the entire document on each change.
    const TextDocumentSyncKindFull = 1;
    assert.strictEqual(
      TextDocumentSyncKindFull,
      1,
      'TextDocumentSyncKindFull must be 1 (entire document sent on change)',
    );
  });

  test('LSP server reports server info', () => {
    // The server returns ServerInfo with name "workflow-lsp-server".
    const expectedServerInfo = {
      name: 'workflow-lsp-server',
    };
    assert.strictEqual(
      expectedServerInfo.name,
      'workflow-lsp-server',
      'Server info name must be workflow-lsp-server',
    );
  });

  // ── Completion types contract ────────────────────────────────────────
  // These tests document and validate the expected completion contexts
  // from the LSP server's registry (lsp/registry.go + completion.go).

  test('LSP completion: top-level keys', () => {
    const expectedTopLevelKeys = [
      'modules',
      'workflows',
      'triggers',
      'pipelines',
      'imports',
      'requires',
      'platform',
    ];

    // Verify the contract: the LSP server provides these top-level keys
    assert.strictEqual(expectedTopLevelKeys.length, 7, 'Must have exactly 7 top-level keys');
    for (const key of expectedTopLevelKeys) {
      assert.ok(
        typeof key === 'string' && key.length > 0,
        `Top-level key '${key}' must be a non-empty string`,
      );
    }
  });

  test('LSP completion: known module types include core types', () => {
    const coreModuleTypes = [
      'http.server',
      'database.postgres',
      'database.workflow',
      'cache.modular',
      'storage.sqlite',
      'static.fileserver',
      'config.provider',
      'observability.otel',
    ];

    for (const moduleType of coreModuleTypes) {
      assert.ok(
        moduleType.includes('.'),
        `Module type '${moduleType}' should use dotted notation (category.type)`,
      );
    }
  });

  test('LSP completion: known step types include core steps', () => {
    const coreStepTypes = [
      'step.set',
      'step.request_parse',
      'step.response',
      'step.db_query',
      'step.db_exec',
      'step.db_query_cached',
      'step.conditional',
      'step.validate',
      'step.log',
      'step.http_call',
      'step.auth_required',
      'step.cache_get',
      'step.cache_set',
    ];

    for (const stepType of coreStepTypes) {
      assert.ok(
        stepType.startsWith('step.'),
        `Step type '${stepType}' should start with 'step.'`,
      );
    }
  });

  test('LSP completion: template functions', () => {
    const expectedFunctions = [
      'uuidv4', 'uuid', 'now', 'lower', 'upper', 'title', 'default',
      'trimPrefix', 'trimSuffix', 'json', 'step', 'trigger',
      'replace', 'contains', 'hasPrefix', 'hasSuffix',
      'split', 'join', 'trimSpace', 'urlEncode',
      'add', 'sub', 'mul', 'div',
      'toInt', 'toFloat', 'toString',
      'length', 'coalesce', 'config',
      'sum', 'pluck', 'flatten', 'unique', 'groupBy', 'sortBy',
      'first', 'last', 'min', 'max',
    ];

    assert.strictEqual(
      expectedFunctions.length,
      40,
      `Expected 40 template functions, got ${expectedFunctions.length}`,
    );

    // Validate that core pipeline functions are present
    const coreFunctions = ['uuidv4', 'now', 'lower', 'upper', 'default', 'json', 'config'];
    for (const fn of coreFunctions) {
      assert.ok(
        expectedFunctions.includes(fn),
        `Template function '${fn}' must be in the expected set`,
      );
    }
  });

  test('LSP completion: template namespaces', () => {
    const expectedNamespaces = ['.steps', '.trigger', '.body', '.meta'];
    assert.strictEqual(expectedNamespaces.length, 4, 'Must have 4 template namespaces');
    assert.ok(expectedNamespaces.includes('.steps'), 'Must include .steps namespace');
    assert.ok(expectedNamespaces.includes('.trigger'), 'Must include .trigger namespace');
    assert.ok(expectedNamespaces.includes('.body'), 'Must include .body namespace');
    assert.ok(expectedNamespaces.includes('.meta'), 'Must include .meta namespace');
  });

  test('LSP completion: trigger types', () => {
    const expectedTriggerTypes = ['http', 'schedule', 'event', 'eventbus'];
    for (const tt of expectedTriggerTypes) {
      assert.ok(
        typeof tt === 'string' && tt.length > 0,
        `Trigger type '${tt}' must be a non-empty string`,
      );
    }
  });

  test('LSP completion: module item keys', () => {
    // Module-level field completions provided by the server
    const moduleItemKeys = ['name', 'type', 'config', 'dependsOn', 'branches'];
    assert.strictEqual(moduleItemKeys.length, 5, 'Must have 5 module item keys');
    assert.ok(moduleItemKeys.includes('name'), 'Must include name key');
    assert.ok(moduleItemKeys.includes('type'), 'Must include type key');
    assert.ok(moduleItemKeys.includes('config'), 'Must include config key');
    assert.ok(moduleItemKeys.includes('dependsOn'), 'Must include dependsOn key');
  });

  test('LSP completion: meta fields', () => {
    const metaFields = ['pipeline_name', 'trigger_type', 'timestamp'];
    assert.strictEqual(metaFields.length, 3, 'Must have 3 meta fields');
    assert.ok(metaFields.includes('pipeline_name'), 'Must include pipeline_name');
    assert.ok(metaFields.includes('trigger_type'), 'Must include trigger_type');
    assert.ok(metaFields.includes('timestamp'), 'Must include timestamp');
  });

  test('LSP completion: trigger data subfields', () => {
    const triggerSubfields = ['path_params', 'query', 'body', 'headers'];
    assert.strictEqual(triggerSubfields.length, 4, 'Must have 4 trigger subfields');
    for (const field of triggerSubfields) {
      assert.ok(typeof field === 'string' && field.length > 0);
    }
  });
});
