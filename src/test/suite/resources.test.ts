import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Validates that all extension resources are bundled correctly.
 * Equivalent to the JetBrains EditorResourcesTest — these tests
 * catch missing/broken resource files before release.
 */
suite('Extension Resources', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
  );

  test('webview-dist/index.js exists', () => {
    const filePath = path.join(extensionRoot, 'webview-dist', 'index.js');
    assert.ok(fs.existsSync(filePath), `Expected ${filePath} to exist`);
  });

  test('webview-dist/index.css exists', () => {
    const filePath = path.join(extensionRoot, 'webview-dist', 'index.css');
    assert.ok(fs.existsSync(filePath), `Expected ${filePath} to exist`);
  });

  test('webview-dist/index.js is not empty', () => {
    const filePath = path.join(extensionRoot, 'webview-dist', 'index.js');
    const stat = fs.statSync(filePath);
    assert.ok(stat.size > 1000, `index.js should be > 1KB, got ${stat.size}`);
  });

  test('webview-dist/index.css is not empty', () => {
    const filePath = path.join(extensionRoot, 'webview-dist', 'index.css');
    const stat = fs.statSync(filePath);
    assert.ok(stat.size > 100, `index.css should be > 100 bytes, got ${stat.size}`);
  });

  test('schemas/workflow-config.schema.json exists', () => {
    const filePath = path.join(extensionRoot, 'schemas', 'workflow-config.schema.json');
    assert.ok(fs.existsSync(filePath), `Expected ${filePath} to exist`);
  });

  test('schemas/wfctl-manifest.schema.json exists', () => {
    const filePath = path.join(extensionRoot, 'schemas', 'wfctl-manifest.schema.json');
    assert.ok(fs.existsSync(filePath), `Expected ${filePath} to exist`);
  });

  test('schema is valid JSON with $schema key', () => {
    const filePath = path.join(extensionRoot, 'schemas', 'workflow-config.schema.json');
    const content = fs.readFileSync(filePath, 'utf-8');
    const schema = JSON.parse(content);
    assert.ok(schema['$schema'], 'Schema must have a $schema key');
  });

  test('wfctl manifest schema accepts manifest fields without requiring app modules', () => {
    const filePath = path.join(extensionRoot, 'schemas', 'wfctl-manifest.schema.json');
    const content = fs.readFileSync(filePath, 'utf-8');
    const schema = JSON.parse(content);
    assert.ok(schema['$schema'], 'wfctl manifest schema must have a $schema key');
    assert.ok(schema.properties.version, 'wfctl manifest schema must define version');
    assert.ok(schema.properties.plugins, 'wfctl manifest schema must define plugins');
    assert.ok(schema.properties.registries, 'wfctl manifest schema must define registries');
    assert.ok(
      !schema.required?.includes('modules'),
      'wfctl manifest schema must not require Workflow app modules',
    );
  });

  test('snippets/workflow.json exists', () => {
    const filePath = path.join(extensionRoot, 'snippets', 'workflow.json');
    assert.ok(fs.existsSync(filePath), `Expected ${filePath} to exist`);
  });

  test('snippets/workflow.json is valid JSON', () => {
    const filePath = path.join(extensionRoot, 'snippets', 'workflow.json');
    const content = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(content); // Throws if invalid
  });

  test('no custom language ID without a grammar', () => {
    const languages = packageJson.contributes.languages || [];
    const grammars = packageJson.contributes.grammars || [];

    for (const lang of languages) {
      if (lang.id === 'yaml' || lang.id === 'json') continue;
      const hasGrammar = grammars.some(
        (g: { language: string }) => g.language === lang.id,
      );
      assert.ok(
        hasGrammar,
        `Language "${lang.id}" declared without a TextMate grammar — will lose syntax highlighting`,
      );
    }
  });

  test('schema validation targets YAML files correctly', () => {
    const jsonValidation = packageJson.contributes.jsonValidation || [];
    for (const entry of jsonValidation) {
      for (const pattern of entry.fileMatch) {
        assert.ok(
          !pattern.endsWith('.yaml') && !pattern.endsWith('.yml'),
          `jsonValidation has YAML pattern "${pattern}" — jsonValidation only works for JSON files`,
        );
      }
    }
  });

  test('yamlValidation associates workflow schema with app root files only', () => {
    const yamlValidation = packageJson.contributes.yamlValidation || [];
    assert.ok(
      yamlValidation.length > 0,
      'Must have yamlValidation entries for workflow YAML files',
    );
    const workflowEntry = yamlValidation.find(
      (e: { url: string }) => e.url === './schemas/workflow-config.schema.json',
    );
    assert.ok(workflowEntry, 'Must have workflow config schema yamlValidation entry');
    const patterns = workflowEntry.fileMatch;
    for (const fileName of [
      'workflow.yaml',
      'workflow.yml',
      'app.yaml',
      'app.yml',
      'infra.yaml',
      'infra.yml',
    ]) {
      assert.ok(
        patterns.includes(fileName),
        `yamlValidation must associate workflow schema with ${fileName}`,
      );
    }
    assert.ok(!patterns.includes('wfctl.yaml'), 'workflow app schema must not match wfctl.yaml');
    assert.ok(!patterns.includes('wfctl.yml'), 'workflow app schema must not match wfctl.yml');
  });

  test('yamlValidation associates wfctl manifests with wfctl manifest schema', () => {
    const yamlValidation = packageJson.contributes.yamlValidation || [];
    const wfctlEntry = yamlValidation.find(
      (e: { url: string }) => e.url === './schemas/wfctl-manifest.schema.json',
    );
    assert.ok(wfctlEntry, 'Must have wfctl manifest schema yamlValidation entry');
    assert.deepStrictEqual(
      wfctlEntry.fileMatch,
      ['wfctl.yaml', 'wfctl.yml'],
      'wfctl manifests must use the wfctl manifest schema only',
    );
  });

  test('activation events include all workflow root file names', () => {
    const activationEvents: string[] = packageJson.activationEvents || [];
    for (const fileName of [
      'workflow.yaml',
      'workflow.yml',
      'app.yaml',
      'app.yml',
      'wfctl.yaml',
      'wfctl.yml',
      'infra.yaml',
      'infra.yml',
    ]) {
      assert.ok(
        activationEvents.includes(`workspaceContains:**/${fileName}`),
        `activationEvents must include ${fileName}`,
      );
    }
  });

  test('LSP startup is non-blocking in extension.ts', () => {
    const extensionSrc = fs.readFileSync(
      path.join(extensionRoot, 'out', 'extension.js'),
      'utf-8',
    );
    // The LSP startup should use .catch() pattern, not await
    // Check that startLspClient is NOT preceded by await on the same expression
    assert.ok(
      !extensionSrc.includes('await startLspClient'),
      'startLspClient should not be awaited — use .catch() for non-blocking startup',
    );
  });

  test('language-configuration.json exists', () => {
    const filePath = path.join(extensionRoot, 'language-configuration.json');
    assert.ok(fs.existsSync(filePath), `Expected ${filePath} to exist`);
  });
});
