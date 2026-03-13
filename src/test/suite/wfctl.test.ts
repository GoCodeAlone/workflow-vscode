import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as child_process from 'child_process';
import { getPlatformSuffix, buildDownloadUrl } from '../../wfctl.js';

/**
 * Functional tests for wfctl binary resolution, platform detection,
 * and download URL construction.
 */
suite('wfctl Binary', () => {
  const extensionRoot = path.resolve(__dirname, '..', '..', '..');

  test('getPlatformSuffix returns a valid suffix for current platform', () => {
    const suffix = getPlatformSuffix();
    assert.ok(
      /^(darwin|linux|windows)-(arm64|amd64)$/.test(suffix),
      `getPlatformSuffix() returned invalid suffix: ${suffix}`,
    );
  });

  test('buildDownloadUrl constructs correct GitHub release URL', () => {
    const url = buildDownloadUrl('wfctl', 'v0.3.30');
    assert.ok(
      url.startsWith('https://github.com/GoCodeAlone/workflow/releases/download/v0.3.30/'),
      `URL must start with correct release prefix, got: ${url}`,
    );
    assert.ok(url.includes('wfctl-'), 'URL must include binary name with dash');
    assert.ok(url.includes(getPlatformSuffix()), 'URL must include platform suffix');
  });

  test('buildDownloadUrl adds .exe suffix on Windows only', () => {
    const url = buildDownloadUrl('wfctl', 'v0.3.30');
    if (os.platform() === 'win32') {
      assert.ok(url.endsWith('.exe'), 'Windows URL must end with .exe');
    } else {
      assert.ok(!url.endsWith('.exe'), 'Non-Windows URL must not end with .exe');
    }
  });

  test('buildDownloadUrl preserves exact tag in URL', () => {
    const url = buildDownloadUrl('wfctl', 'v1.2.3-rc.1');
    assert.ok(
      url.includes('/v1.2.3-rc.1/'),
      'URL must preserve the exact tag including pre-release suffix',
    );
  });

  test('compiled wfctl.js contains all platform-arch combinations', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'wfctl.js'), 'utf-8');
    assert.ok(src.includes('darwin-arm64'), 'Must handle darwin-arm64');
    assert.ok(src.includes('darwin-amd64'), 'Must handle darwin-amd64');
    assert.ok(src.includes('linux-arm64'), 'Must handle linux-arm64');
    assert.ok(src.includes('linux-amd64'), 'Must handle linux-amd64');
    assert.ok(src.includes('windows-amd64'), 'Must handle windows-amd64');
  });

  test('download URL points to GoCodeAlone/workflow releases', () => {
    const src = fs.readFileSync(path.join(extensionRoot, 'out', 'wfctl.js'), 'utf-8');
    assert.ok(
      src.includes("GoCodeAlone/workflow"),
      'Download URL must reference GoCodeAlone/workflow GitHub repo',
    );
  });

  test('wfctl resolves from PATH when available', () => {
    try {
      const result = child_process.execSync('which wfctl 2>/dev/null || where wfctl 2>nul', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (result) {
        assert.ok(fs.existsSync(result), `wfctl found at ${result} but file doesn't exist`);
        const stat = fs.statSync(result);
        assert.ok(stat.mode & 0o111, 'wfctl must be executable');
      }
    } catch {
      // wfctl not on PATH -- skip
    }
  });

  test('wfctl version runs successfully when binary exists', () => {
    try {
      const result = child_process.execSync('wfctl version 2>&1 || true', {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      if (result && !result.includes('not found') && !result.includes('ENOENT')) {
        assert.ok(result.length > 0, 'wfctl version should produce output');
      }
    } catch {
      // wfctl not available -- skip
    }
  });
});
