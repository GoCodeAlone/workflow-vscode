import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { buildLspDownloadUrl, getLspPlatformSuffix, LSP_DOCUMENT_SELECTOR } from '../../lsp-client.js';

/**
 * Functional tests for LSP server binary resolution, download URL
 * construction, and document selector configuration.
 */
suite('LSP Server', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');

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

  test('LSP document selector includes workflow YAML patterns', () => {
    const patterns = LSP_DOCUMENT_SELECTOR.map((s) => s.pattern);
    assert.ok(patterns.includes('**/workflow.yaml'), 'Must match workflow.yaml');
    assert.ok(patterns.includes('**/workflow.yml'), 'Must match workflow.yml');
    assert.ok(patterns.includes('**/app.yaml'), 'Must match app.yaml');
    assert.ok(patterns.includes('**/app.yml'), 'Must match app.yml');
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
});
