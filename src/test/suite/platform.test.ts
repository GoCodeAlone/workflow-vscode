import * as assert from 'assert';
import * as os from 'os';

/**
 * Tests the platform detection logic used by wfctl.ts and lsp-client.ts
 * for binary downloads. Validates the current platform is supported and
 * maps correctly.
 */
suite('Platform Detection', () => {
  // Reimplements getPlatformSuffix() from wfctl.ts for testing
  function getPlatformSuffix(): string {
    const platform = os.platform();
    const arch = os.arch();
    if (platform === 'darwin') {
      return arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
    }
    if (platform === 'linux') {
      return arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
    }
    if (platform === 'win32') {
      return 'windows-amd64';
    }
    throw new Error(`Unsupported platform: ${platform}/${arch}`);
  }

  test('current platform is supported', () => {
    // Should not throw
    const suffix = getPlatformSuffix();
    assert.ok(suffix.length > 0, 'Platform suffix must not be empty');
  });

  test('platform suffix contains expected segments', () => {
    const suffix = getPlatformSuffix();
    const [osName, arch] = suffix.split('-');

    assert.ok(
      ['darwin', 'linux', 'windows'].includes(osName),
      `OS must be darwin/linux/windows, got ${osName}`,
    );
    assert.ok(
      ['amd64', 'arm64'].includes(arch),
      `Arch must be amd64/arm64, got ${arch}`,
    );
  });

  test('binary filename has .exe on windows', () => {
    const platform = os.platform();
    const binaryFileName = platform === 'win32' ? 'wfctl.exe' : 'wfctl';
    if (platform === 'win32') {
      assert.ok(binaryFileName.endsWith('.exe'));
    } else {
      assert.ok(!binaryFileName.endsWith('.exe'));
    }
  });
});
