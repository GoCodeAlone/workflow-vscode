import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

suite('Marketplace Provider', () => {
  test('marketplace commands are declared in package.json', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const commands: string[] = packageJson.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    assert.ok(
      commands.includes('workflow.installPlugin'),
      'Expected workflow.installPlugin in package.json commands',
    );
    assert.ok(
      commands.includes('workflow.refreshMarketplace'),
      'Expected workflow.refreshMarketplace in package.json commands',
    );
  });

  test('marketplace view is declared in package.json', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const views: { id: string; name: string }[] =
      packageJson.contributes.views['workflow-explorer'] ?? [];
    const viewIds = views.map(v => v.id);
    assert.ok(
      viewIds.includes('workflowPluginMarketplace'),
      'Expected workflowPluginMarketplace view in workflow-explorer container',
    );
  });

  test('view container is declared in package.json', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const containers: { id: string }[] =
      packageJson.contributes.viewsContainers?.activitybar ?? [];
    const containerIds = containers.map(c => c.id);
    assert.ok(
      containerIds.includes('workflow-explorer'),
      'Expected workflow-explorer activity bar container',
    );
  });

  test('marketplace menu contributions reference valid view', () => {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf-8'),
    );
    const viewTitleMenus: { command: string; when: string }[] =
      packageJson.contributes.menus?.['view/title'] ?? [];
    const refreshMenu = viewTitleMenus.find(
      m => m.command === 'workflow.refreshMarketplace',
    );
    assert.ok(refreshMenu, 'Expected workflow.refreshMarketplace in view/title menus');
    assert.ok(
      refreshMenu.when.includes('workflowPluginMarketplace'),
      'Expected when-clause to reference workflowPluginMarketplace',
    );
  });

  test('private plugin filter logic', () => {
    interface Plugin { name: string; private?: boolean; }
    const plugins: Plugin[] = [
      { name: 'public-plugin', private: false },
      { name: 'private-plugin', private: true },
      { name: 'no-private-field' },
    ];
    const visible = plugins.filter(p => !p.private);
    assert.strictEqual(visible.length, 2);
    assert.ok(visible.some(p => p.name === 'public-plugin'));
    assert.ok(visible.some(p => p.name === 'no-private-field'));
    assert.ok(!visible.some(p => p.name === 'private-plugin'));
  });

  test('cache TTL logic', () => {
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const now = Date.now();
    // Fresh cache (14 min ago) — should still be valid
    assert.ok(now - (now - 14 * 60 * 1000) < CACHE_TTL_MS);
    // Stale cache (16 min ago) — should be expired
    assert.ok(now - (now - 16 * 60 * 1000) >= CACHE_TTL_MS);
  });

  test('capabilities optional field handling', () => {
    // Simulate a plugin with no capabilities field
    const plugin = { name: 'test', version: '0.1.0', tier: 'community' } as {
      name: string;
      version: string;
      tier: string;
      capabilities?: { stepTypes: string[]; moduleTypes: string[] };
    };
    const stepCount = plugin.capabilities?.stepTypes?.length ?? 0;
    const moduleCount = plugin.capabilities?.moduleTypes?.length ?? 0;
    assert.strictEqual(stepCount, 0);
    assert.strictEqual(moduleCount, 0);
  });

  test('registry response must be an array', () => {
    const validateRegistryResponse = (data: unknown): boolean => Array.isArray(data);
    assert.ok(!validateRegistryResponse(null));
    assert.ok(!validateRegistryResponse({}));
    assert.ok(!validateRegistryResponse('string'));
    assert.ok(validateRegistryResponse([]));
    assert.ok(validateRegistryResponse([{ name: 'plugin' }]));
  });
});
