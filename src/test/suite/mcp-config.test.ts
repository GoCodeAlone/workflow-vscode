import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Tests MCP config file read/write/merge logic.
 * Validates the same patterns used in mcp-config.ts without needing
 * the full VS Code API for the pure I/O functions.
 */
suite('MCP Config', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates new mcp.json with workflow server', () => {
    const mcpPath = path.join(tmpDir, '.vscode', 'mcp.json');
    const dir = path.dirname(mcpPath);
    fs.mkdirSync(dir, { recursive: true });

    const config = {
      servers: {
        workflow: {
          command: '/usr/local/bin/wfctl',
          args: ['mcp'],
        },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    const loaded = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    assert.ok(loaded.servers.workflow, 'Must have workflow server');
    assert.strictEqual(loaded.servers.workflow.command, '/usr/local/bin/wfctl');
    assert.deepStrictEqual(loaded.servers.workflow.args, ['mcp']);
  });

  test('merges workflow server into existing mcp.json', () => {
    const mcpPath = path.join(tmpDir, 'mcp.json');
    const existing = {
      servers: {
        other: { command: '/usr/local/bin/other', args: ['serve'] },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(existing));

    // Simulate the merge logic from mcp-config.ts
    const current = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    const updated = {
      ...current,
      servers: {
        ...(current.servers ?? {}),
        workflow: { command: '/usr/local/bin/wfctl', args: ['mcp'] },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(updated, null, 2) + '\n');

    const result = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    assert.ok(result.servers.other, 'Must preserve existing server');
    assert.ok(result.servers.workflow, 'Must add workflow server');
    assert.strictEqual(result.servers.other.command, '/usr/local/bin/other');
    assert.strictEqual(result.servers.workflow.command, '/usr/local/bin/wfctl');
  });

  test('detects existing workflow server', () => {
    const config = {
      servers: {
        workflow: { command: '/usr/local/bin/wfctl', args: ['mcp'] },
      },
    };
    const hasWorkflow = !!(config.servers && config.servers['workflow']);
    assert.ok(hasWorkflow);
  });

  test('detects missing workflow server', () => {
    const config = {
      servers: {
        other: { command: '/usr/local/bin/other' },
      },
    };
    const hasWorkflow = !!(config.servers && (config.servers as Record<string, unknown>)['workflow']);
    assert.ok(!hasWorkflow);
  });

  test('handles empty/missing config gracefully', () => {
    const mcpPath = path.join(tmpDir, 'nonexistent.json');
    let config = {};
    if (fs.existsSync(mcpPath)) {
      try {
        config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      } catch {
        config = {};
      }
    }
    assert.deepStrictEqual(config, {});
  });

  test('handles corrupt JSON gracefully', () => {
    const mcpPath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(mcpPath, '{not valid json!!!');

    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    } catch {
      config = {};
    }
    assert.deepStrictEqual(config, {});
  });
});
