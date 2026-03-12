import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { isWorkflowFile, promptWorkflowDetection } from '../../visual-editor.js';

suite('Visual Editor', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('openVisualEditor command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('workflow.openVisualEditor'),
      'Expected workflow.openVisualEditor command to be registered',
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

  test('configPaths setting overrides content detection', async () => {
    // A YAML file without modules:/workflows: should still match via configPaths glob
    const content = 'key: value\n';
    const filePath = path.join(tmpDir, 'special.yaml');
    fs.writeFileSync(filePath, content);

    // Update the setting to include the pattern
    const config = vscode.workspace.getConfiguration('workflow');
    const originalPaths = config.get<string[]>('configPaths', []);
    try {
      await config.update('configPaths', ['*.yaml'], vscode.ConfigurationTarget.Global);
      const doc = await vscode.workspace.openTextDocument(filePath);
      assert.ok(isWorkflowFile(doc), 'Expected configPaths match to return true');
    } finally {
      await config.update('configPaths', originalPaths, vscode.ConfigurationTarget.Global);
    }
  });

  test('isWorkflowFile returns false for non-YAML files', async () => {
    const filePath = path.join(tmpDir, 'main.go');
    fs.writeFileSync(filePath, 'package main\n');
    const doc = await vscode.workspace.openTextDocument(filePath);
    assert.ok(!isWorkflowFile(doc), 'Expected non-YAML file to return false');
  });
});
