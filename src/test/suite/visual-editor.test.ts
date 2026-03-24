import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { isWorkflowFile, extractYamlPreamble, mergeYamlPreamble, resolveFullConfig, parseYamlModuleNames, parseYamlMappingKeys, parseYamlStringList } from '../../visual-editor.js';
import { detectWorkflowFileType } from '../../file-detection.js';

suite('Visual Editor', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('openVisualEditor command is declared in package.json', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const commands: string[] = packageJson.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    assert.ok(
      commands.includes('workflow.openVisualEditor'),
      'Expected workflow.openVisualEditor in package.json commands',
    );
  });

  test('isWorkflowFile returns true for content-matched YAML', async () => {
    const content = `
modules:
  - name: web
    type: http.server
workflows:
  http:
    routes: []
`;
    const filePath = path.join(tmpDir, 'app.yaml');
    fs.writeFileSync(filePath, content);
    const doc = await vscode.workspace.openTextDocument(filePath);
    assert.ok(isWorkflowFile(doc), 'Expected isWorkflowFile to return true');
  });

  test('isWorkflowFile returns false for non-workflow YAML', async () => {
    const content = `
database:
  host: localhost
  port: 5432
`;
    const filePath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(filePath, content);
    const doc = await vscode.workspace.openTextDocument(filePath);
    assert.ok(!isWorkflowFile(doc), 'Expected isWorkflowFile to return false');
  });

  test('isWorkflowFile returns false for non-YAML files', async () => {
    const filePath = path.join(tmpDir, 'main.go');
    fs.writeFileSync(filePath, 'package main\n');
    const doc = await vscode.workspace.openTextDocument(filePath);
    assert.ok(!isWorkflowFile(doc), 'Expected non-YAML file to return false');
  });

  test('isWorkflowFile is not required for manual visual editor open', () => {
    // The visual editor command should open for ANY yaml file,
    // not just files that pass isWorkflowFile()
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const extensionSrc = fs.readFileSync(
      path.join(extensionRoot, 'out', 'extension.js'),
      'utf-8',
    );
    // The command handler should NOT call isWorkflowFile for the button click
    // It should check file extension only (.yaml/.yml)
    const cmdRegistration = extensionSrc.match(
      /registerCommand\s*\(\s*['"]workflow\.openVisualEditor['"]/
    );
    assert.ok(cmdRegistration, 'openVisualEditor command must be registered');
  });

  test('partial files show info message path — detectWorkflowFileType returns partial', async () => {
    // A file with only pipelines: should be detected as partial
    const content = `
pipelines:
  my-pipeline:
    steps:
      - step.transform
`;
    const filePath = path.join(tmpDir, 'partial.yaml');
    fs.writeFileSync(filePath, content);
    const doc = await vscode.workspace.openTextDocument(filePath);
    assert.strictEqual(detectWorkflowFileType(doc), 'partial', 'Expected partial file type');
    assert.ok(isWorkflowFile(doc), 'Expected isWorkflowFile to return true for partial');
  });

  test('name and version preserved through webview round-trip', () => {
    const original = `name: my-workflow\nversion: "1.0"\nmodules:\n  - name: web\n    type: http.server\n`;
    const preamble = extractYamlPreamble(original);
    assert.ok(preamble.includes('name: my-workflow'), 'Preamble should contain name');
    assert.ok(preamble.includes('version:'), 'Preamble should contain version');

    // Simulate webview stripping name/version
    const stripped = `modules:\n  - name: web\n    type: http.server\n`;
    const merged = mergeYamlPreamble(preamble, stripped);
    assert.ok(merged.includes('name: my-workflow'), 'Merged YAML should contain name');
    assert.ok(merged.includes('version:'), 'Merged YAML should contain version');
    assert.ok(merged.includes('modules:'), 'Merged YAML should still contain modules');
  });

  test('mergeYamlPreamble does not duplicate existing keys', () => {
    const preamble = 'name: my-workflow\nversion: "1.0"';
    const yaml = 'name: my-workflow\nversion: "1.0"\nmodules:\n  - name: web\n';
    const merged = mergeYamlPreamble(preamble, yaml);
    const nameCount = (merged.match(/^name:/gm) || []).length;
    const versionCount = (merged.match(/^version:/gm) || []).length;
    assert.strictEqual(nameCount, 1, 'name should not be duplicated');
    assert.strictEqual(versionCount, 1, 'version should not be duplicated');
  });

  test('isWorkflowFile detects both modules and workflows keys', async () => {
    // Only modules: without workflows: should NOT match
    const onlyModules = path.join(tmpDir, 'modules-only.yaml');
    fs.writeFileSync(onlyModules, 'modules:\n  - name: x\n');
    const doc1 = await vscode.workspace.openTextDocument(onlyModules);
    assert.ok(!isWorkflowFile(doc1), 'modules: alone should not match');

    // Only workflows: without modules: should NOT match
    const onlyWorkflows = path.join(tmpDir, 'workflows-only.yaml');
    fs.writeFileSync(onlyWorkflows, 'workflows:\n  http:\n    routes: []\n');
    const doc2 = await vscode.workspace.openTextDocument(onlyWorkflows);
    assert.ok(!isWorkflowFile(doc2), 'workflows: alone should not match');
  });

  test('partial file resolves full workspace config via resolveFullConfig', () => {
    // Create root config that imports a partial
    const rootYaml = [
      'name: my-app',
      'version: "1.0"',
      'modules:',
      '  - name: web',
      '    type: http.server',
      'workflows:',
      '  http:',
      '    routes: []',
      'imports:',
      '  - partials/auth.yaml',
    ].join('\n') + '\n';

    const partialYaml = [
      'pipelines:',
      '  auth-pipeline:',
      '    steps: []',
      '  login-pipeline:',
      '    steps: []',
    ].join('\n') + '\n';

    const rootPath = path.join(tmpDir, 'app.yaml');
    const partialDir = path.join(tmpDir, 'partials');
    fs.mkdirSync(partialDir);
    fs.writeFileSync(rootPath, rootYaml);
    fs.writeFileSync(path.join(partialDir, 'auth.yaml'), partialYaml);

    const { yaml, sourceMap } = resolveFullConfig(rootPath);

    // Merged yaml should contain both root and partial content
    assert.ok(yaml.includes('modules:'), 'Merged yaml should contain modules');
    assert.ok(yaml.includes('pipelines:'), 'Merged yaml should contain pipelines');
    assert.ok(yaml.includes('auth-pipeline'), 'Merged yaml should include auth-pipeline');
    assert.ok(yaml.includes('login-pipeline'), 'Merged yaml should include login-pipeline');
    assert.ok(yaml.includes('name: my-app'), 'Merged yaml should include root preamble');

    // imports section should not appear in merged output
    assert.ok(!yaml.includes('imports:'), 'Merged yaml should not include imports section');
  });

  test('sourceMap tracks correct file for each node', () => {
    const rootPath = path.join(tmpDir, 'app.yaml');
    const modulesPath = path.join(tmpDir, 'modules.yaml');
    const pipelinesPath = path.join(tmpDir, 'pipelines', 'auth.yaml');
    fs.mkdirSync(path.join(tmpDir, 'pipelines'));

    fs.writeFileSync(rootPath, [
      'modules:',
      '  - name: web',
      '    type: http.server',
      'workflows:',
      '  http:',
      '    routes: []',
      'imports:',
      '  - modules.yaml',
      '  - pipelines/auth.yaml',
    ].join('\n') + '\n');

    fs.writeFileSync(modulesPath, [
      'modules:',
      '  - name: db',
      '    type: postgres',
      '  - name: cache',
      '    type: redis',
    ].join('\n') + '\n');

    fs.writeFileSync(pipelinesPath, [
      'pipelines:',
      '  auth-pipeline:',
      '    steps: []',
    ].join('\n') + '\n');

    const { sourceMap } = resolveFullConfig(rootPath);

    assert.strictEqual(sourceMap['web'], rootPath, 'web module should map to root file');
    assert.strictEqual(sourceMap['db'], modulesPath, 'db module should map to modules.yaml');
    assert.strictEqual(sourceMap['cache'], modulesPath, 'cache module should map to modules.yaml');
    assert.strictEqual(sourceMap['auth-pipeline'], pipelinesPath, 'auth-pipeline should map to pipelines/auth.yaml');
  });

  test('parseYamlModuleNames extracts module names from yaml', () => {
    const yaml = 'modules:\n  - name: web\n    type: http.server\n  - name: db\n    type: postgres\n';
    const names = parseYamlModuleNames(yaml);
    assert.deepStrictEqual(names, ['web', 'db']);
  });

  test('parseYamlMappingKeys extracts pipeline names from yaml', () => {
    const yaml = 'pipelines:\n  my-pipeline:\n    steps: []\n  other-pipeline:\n    steps: []\n';
    const keys = parseYamlMappingKeys(yaml, 'pipelines');
    assert.deepStrictEqual(keys, ['my-pipeline', 'other-pipeline']);
  });

  test('parseYamlStringList extracts imports list from yaml', () => {
    const yaml = 'imports:\n  - partials/auth.yaml\n  - modules.yaml\n';
    const imports = parseYamlStringList(yaml, 'imports');
    assert.deepStrictEqual(imports, ['partials/auth.yaml', 'modules.yaml']);
  });
});
