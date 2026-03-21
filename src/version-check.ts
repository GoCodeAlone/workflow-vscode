import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as https from 'https';
import * as fs from 'fs';

const GITHUB_API_URL = 'https://api.github.com/repos/GoCodeAlone/workflow/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchLatestReleaseTag(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = https.get(GITHUB_API_URL, { headers: { 'User-Agent': 'workflow-vscode' } }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const release = JSON.parse(data) as { tag_name?: string };
          if (!release.tag_name) {
            reject(new Error('No tag_name in GitHub release response'));
            return;
          }
          resolve(release.tag_name);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Request timed out')); });
  });
}

function getCurrentVersion(binaryPath: string, versionFlag: string): string | null {
  try {
    const result = child_process.execSync(`"${binaryPath}" ${versionFlag}`, {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Extract version string — look for something like v0.3.51
    const match = result.trim().match(/v\d+\.\d+\.\d+/);
    return match ? match[0] : result.trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Checks if a downloaded binary is outdated compared to the latest GitHub release.
 * Shows a notification if an update is available. Skips if checked within the last 24 hours.
 * The check is failure-tolerant — network errors and binary errors are silently ignored.
 */
export async function checkBinaryVersion(
  context: vscode.ExtensionContext,
  binaryName: string,
  currentPath: string,
  outputChannel: vscode.OutputChannel,
  downloadFn: () => Promise<void>,
): Promise<void> {
  // Skip if binary doesn't exist at this path
  if (!fs.existsSync(currentPath)) {
    return;
  }

  // Skip if checked within the last 24 hours
  const lastCheckKey = `lastVersionCheck-${binaryName}`;
  const lastCheck = context.globalState.get<number>(lastCheckKey, 0);
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
    outputChannel.appendLine(`[version-check] ${binaryName}: skipping check (last checked <24h ago)`);
    return;
  }

  try {
    // Determine the version flag for this binary
    const versionFlag = binaryName === 'wfctl' ? 'version' : '-version';
    const currentVersion = getCurrentVersion(currentPath, versionFlag);
    if (!currentVersion) {
      outputChannel.appendLine(`[version-check] ${binaryName}: could not determine current version`);
      return;
    }

    const latestTag = await fetchLatestReleaseTag();

    // Save timestamp regardless of whether update is needed
    await context.globalState.update(lastCheckKey, Date.now());

    if (currentVersion === latestTag) {
      outputChannel.appendLine(`[version-check] ${binaryName}: up to date (${currentVersion})`);
      return;
    }

    outputChannel.appendLine(`[version-check] ${binaryName}: update available ${currentVersion} → ${latestTag}`);

    const choice = await vscode.window.showInformationMessage(
      `Workflow ${binaryName} update available: ${currentVersion} → ${latestTag}. Update now?`,
      'Update',
      'Dismiss',
    );

    if (choice === 'Update') {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating ${binaryName}...`,
          cancellable: false,
        },
        async () => {
          await downloadFn();
        },
      );
    }
  } catch (err) {
    // Silently ignore all errors (network issues, binary errors, etc.)
    outputChannel.appendLine(`[version-check] ${binaryName}: check failed (${err})`);
  }
}
