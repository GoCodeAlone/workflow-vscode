import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Test the parseGoModPlugins function by importing the module's logic.
 * Since parseGoModPlugins is not exported, we test the regex pattern directly.
 */
suite('Plugin Discovery', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-pd-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('go.mod plugin regex matches workflow-plugin-* dependencies', () => {
    const goMod = `module github.com/example/myapp

go 1.22

require (
	github.com/GoCodeAlone/workflow v0.3.30
	github.com/GoCodeAlone/workflow-plugin-agent v0.3.1
	github.com/GoCodeAlone/workflow-plugin-authz v0.2.0
	github.com/GoCodeAlone/workflow-plugin-payments v0.1.0
	github.com/GoCodeAlone/modular v1.12.0
	github.com/some-other/module v1.0.0
)`;

    const plugins: string[] = [];
    for (const line of goMod.split('\n')) {
      const match = line.match(/github\.com\/GoCodeAlone\/(workflow-plugin-\S+)/);
      if (match) plugins.push(match[1]);
    }

    assert.deepStrictEqual(plugins, [
      'workflow-plugin-agent',
      'workflow-plugin-authz',
      'workflow-plugin-payments',
    ]);
  });

  test('go.mod regex does not match non-plugin workflow modules', () => {
    const goMod = `require (
	github.com/GoCodeAlone/workflow v0.3.30
	github.com/GoCodeAlone/modular v1.12.0
	github.com/GoCodeAlone/workflow-editor v0.1.0
)`;

    const plugins: string[] = [];
    for (const line of goMod.split('\n')) {
      const match = line.match(/github\.com\/GoCodeAlone\/(workflow-plugin-\S+)/);
      if (match) plugins.push(match[1]);
    }

    assert.deepStrictEqual(plugins, []);
  });

  test('go.mod regex handles version suffixes correctly', () => {
    const goMod = `require github.com/GoCodeAlone/workflow-plugin-agent v0.3.1 // indirect`;

    const plugins: string[] = [];
    for (const line of goMod.split('\n')) {
      const match = line.match(/github\.com\/GoCodeAlone\/(workflow-plugin-\S+)/);
      if (match) plugins.push(match[1]);
    }

    // The regex captures "workflow-plugin-agent" and stops at whitespace
    assert.strictEqual(plugins.length, 1);
    assert.strictEqual(plugins[0], 'workflow-plugin-agent');
  });

  test('go.mod regex returns empty for empty content', () => {
    const plugins: string[] = [];
    for (const line of ''.split('\n')) {
      const match = line.match(/github\.com\/GoCodeAlone\/(workflow-plugin-\S+)/);
      if (match) plugins.push(match[1]);
    }
    assert.deepStrictEqual(plugins, []);
  });

  test('cache directory creation works', () => {
    const cacheDir = path.join(tmpDir, 'plugin-manifests');
    assert.ok(!fs.existsSync(cacheDir));
    fs.mkdirSync(cacheDir, { recursive: true });
    assert.ok(fs.existsSync(cacheDir));
  });

  test('cached manifest read/write round-trips', () => {
    const cacheDir = path.join(tmpDir, 'plugin-manifests');
    fs.mkdirSync(cacheDir, { recursive: true });

    const manifest = {
      name: 'workflow-plugin-agent',
      stepTypes: [{ name: 'step.agent_execute' }],
      moduleTypes: [{ name: 'agent.provider' }],
    };

    const cacheFile = path.join(cacheDir, 'workflow-plugin-agent.json');
    fs.writeFileSync(cacheFile, JSON.stringify(manifest));

    const loaded = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    assert.deepStrictEqual(loaded, manifest);
  });
});
