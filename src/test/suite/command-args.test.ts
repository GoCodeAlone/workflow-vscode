import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { COMMAND_SPECS } from '../../commands.js';

/**
 * Tests that wfctl command arguments are constructed correctly.
 * Uses the exported COMMAND_SPECS for direct unit testing, plus
 * compiled source verification for runtime behavior.
 */
suite('Command Arguments', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');
  let commandsSrc: string;

  setup(() => {
    commandsSrc = fs.readFileSync(
      path.join(extensionRoot, 'out', 'commands.js'),
      'utf-8',
    );
  });

  // --- Direct COMMAND_SPECS unit tests ---

  test('COMMAND_SPECS validate builds correct args with file', () => {
    const args = COMMAND_SPECS['workflow.validate'].args('/path/to/app.yaml');
    assert.deepStrictEqual(args, ['template', 'validate', '--config', '/path/to/app.yaml']);
  });

  test('COMMAND_SPECS validate builds correct args without file', () => {
    const args = COMMAND_SPECS['workflow.validate'].args();
    assert.deepStrictEqual(args, ['template', 'validate']);
  });

  test('COMMAND_SPECS inspect builds correct args with file', () => {
    const args = COMMAND_SPECS['workflow.inspect'].args('/path/to/workflow.yaml');
    assert.deepStrictEqual(args, ['inspect', '-deps', '/path/to/workflow.yaml']);
  });

  test('COMMAND_SPECS inspect builds correct args without file', () => {
    const args = COMMAND_SPECS['workflow.inspect'].args();
    assert.deepStrictEqual(args, ['inspect', '-deps']);
  });

  test('COMMAND_SPECS templateValidate takes no file argument', () => {
    const args = COMMAND_SPECS['workflow.templateValidate'].args('/path/to/whatever.yaml');
    assert.deepStrictEqual(args, ['template', 'validate']);
  });

  test('COMMAND_SPECS run is flagged as terminal command', () => {
    assert.ok(COMMAND_SPECS['workflow.run'].useTerminal, 'run must use terminal');
  });

  test('COMMAND_SPECS run builds correct args with file', () => {
    const args = COMMAND_SPECS['workflow.run'].args('/path/to/app.yaml');
    assert.deepStrictEqual(args, ['run', '-config', '/path/to/app.yaml']);
  });

  test('COMMAND_SPECS run builds correct args without file', () => {
    const args = COMMAND_SPECS['workflow.run'].args();
    assert.deepStrictEqual(args, ['run']);
  });

  test('COMMAND_SPECS schema takes no file argument', () => {
    const args = COMMAND_SPECS['workflow.schema'].args('/path/to/whatever.yaml');
    assert.deepStrictEqual(args, ['schema']);
  });

  test('COMMAND_SPECS non-terminal commands do not set useTerminal', () => {
    for (const [id, spec] of Object.entries(COMMAND_SPECS)) {
      if (id !== 'workflow.run') {
        assert.ok(
          !spec.useTerminal,
          `${id} should not be a terminal command`,
        );
      }
    }
  });

  test('all declared commands have a COMMAND_SPEC (except init and openVisualEditor)', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const declaredCommands: string[] = packageJson.contributes.commands
      .map((c: { command: string }) => c.command)
      .filter((c: string) => !['workflow.init', 'workflow.openVisualEditor', 'workflow.installPlugin', 'workflow.refreshMarketplace'].includes(c));

    for (const cmd of declaredCommands) {
      assert.ok(
        COMMAND_SPECS[cmd],
        `Command ${cmd} declared in package.json but has no COMMAND_SPEC`,
      );
    }
  });

  // --- Compiled source verification ---

  test('validate command uses "template validate --config"', () => {
    assert.ok(
      commandsSrc.includes('template') && commandsSrc.includes('validate') && commandsSrc.includes('--config'),
      'workflow.validate must pass "template", "validate", "--config" args to wfctl',
    );
  });

  test('inspect command uses "inspect -deps"', () => {
    assert.ok(
      commandsSrc.includes('inspect') && commandsSrc.includes('-deps'),
      'workflow.inspect must pass "inspect", "-deps" args to wfctl',
    );
  });

  test('run command uses "run -config"', () => {
    assert.ok(
      commandsSrc.includes('-config'),
      'workflow.run must pass "run", "-config" args to wfctl',
    );
  });

  test('schema command calls "schema"', () => {
    assert.ok(
      commandsSrc.includes('schema'),
      'workflow.schema must include "schema" subcommand',
    );
  });

  test('init command uses "template init"', () => {
    assert.ok(
      commandsSrc.includes('template') && commandsSrc.includes('init'),
      'workflow.init must pass "template", "init" args to wfctl',
    );
  });

  test('runWfctl uses spawn for streaming output', () => {
    assert.ok(
      commandsSrc.includes('spawn'),
      'runWfctl must use child_process.spawn for streaming stdout/stderr',
    );
  });

  test('runWfctl handles ENOENT error when binary not found', () => {
    assert.ok(
      commandsSrc.includes('ENOENT'),
      'Must handle ENOENT error to show helpful message when wfctl not found',
    );
  });

  test('runWfctl checks exit code on close', () => {
    assert.ok(
      commandsSrc.includes('close') && commandsSrc.includes('code'),
      'Must check process exit code on close event',
    );
  });

  test('init templates include api-service, full-stack, and plugin', () => {
    assert.ok(commandsSrc.includes('api-service'), 'Must offer api-service template');
    assert.ok(commandsSrc.includes('full-stack'), 'Must offer full-stack template');
    assert.ok(commandsSrc.includes('plugin'), 'Must offer plugin template');
  });
});
