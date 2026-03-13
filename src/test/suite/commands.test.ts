import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Validates that all commands declared in package.json exist in the
 * extension source. This is a static check that doesn't require
 * activation (which would prompt for binary downloads in CI).
 */
suite('Commands', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');

  test('all declared commands have matching registrations in extension.ts', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const declaredCommands: string[] = packageJson.contributes.commands.map(
      (c: { command: string }) => c.command,
    );

    assert.ok(declaredCommands.length > 0, 'Must have declared commands');

    // Read the compiled extension source to verify commands are registered
    const extensionSrc = fs.readFileSync(
      path.join(extensionRoot, 'out', 'extension.js'),
      'utf-8',
    );
    const commandsSrc = fs.readFileSync(
      path.join(extensionRoot, 'out', 'commands.js'),
      'utf-8',
    );
    const allSrc = extensionSrc + commandsSrc;

    for (const cmd of declaredCommands) {
      assert.ok(
        allSrc.includes(cmd),
        `Command ${cmd} declared in package.json but not found in compiled source`,
      );
    }
  });

  test('package.json commands have title and command fields', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    for (const cmd of packageJson.contributes.commands) {
      assert.ok(cmd.command, `Command missing "command" field`);
      assert.ok(cmd.title, `Command ${cmd.command} missing "title" field`);
      assert.ok(
        cmd.title.startsWith('Workflow:'),
        `Command ${cmd.command} title should start with "Workflow:", got "${cmd.title}"`,
      );
    }
  });

  test('visual editor menu contribution has correct when clause', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const editorTitleMenus = packageJson.contributes.menus['editor/title'];
    assert.ok(editorTitleMenus, 'Must have editor/title menu contributions');

    const visualEditorMenu = editorTitleMenus.find(
      (m: { command: string }) => m.command === 'workflow.openVisualEditor',
    );
    assert.ok(visualEditorMenu, 'Visual editor must be in editor/title menu');
    assert.ok(
      visualEditorMenu.when.includes('.yaml') || visualEditorMenu.when.includes('.yml'),
      'Visual editor menu should only show for YAML files',
    );
  });
});
