import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import { IncomingMessage } from 'http';
import { pipeline } from 'stream/promises';

const GITHUB_REPO = 'GoCodeAlone/workflow';
const BINARY_NAME = 'wfctl';

export function getPlatformSuffix(): string {
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

export function buildDownloadUrl(binaryName: string, tag: string): string {
  const suffix = getPlatformSuffix();
  const assetName = os.platform() === 'win32' ? `${binaryName}-${suffix}.exe` : `${binaryName}-${suffix}`;
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;
}

export function getDefaultWfctlPath(context: vscode.ExtensionContext): string {
  return getDefaultBinaryPath(context);
}

function getDefaultBinaryPath(context: vscode.ExtensionContext): string {
  const suffix = getPlatformSuffix();
  const binaryFileName = os.platform() === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
  return path.join(context.globalStorageUri.fsPath, 'bin', suffix, binaryFileName);
}

export async function downloadWfctl(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<void> {
  const destPath = getDefaultBinaryPath(context);
  await downloadBinary(destPath, outputChannel);
}

async function getDownloadResponse(url: string, remainingRequests = 5): Promise<IncomingMessage> {
  if (remainingRequests <= 0) {
    throw new Error('Too many redirects');
  }
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'workflow-vscode' } }, (res) => {
      // Also handle errors on responses discarded during redirects or HTTP failures.
      res.on('error', reject);
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Download request timed out')));
  });

  if (response.statusCode === 301 || response.statusCode === 302) {
    const location = response.headers.location;
    response.destroy();
    if (!location) {
      throw new Error('Redirect with no location');
    }
    return getDownloadResponse(new URL(location, url).toString(), remainingRequests - 1);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`Download failed with status ${response.statusCode}`);
  }
  return response;
}

async function downloadBinary(destPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
  // Fetch latest release tag from GitHub API
  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  outputChannel.appendLine(`Fetching latest release from ${releaseUrl}`);

  const releaseResponse = await getDownloadResponse(releaseUrl);
  let releaseData = '';
  for await (const chunk of releaseResponse) {
    releaseData += chunk.toString();
  }
  if (!releaseResponse.complete) {
    throw new Error('Incomplete GitHub release response');
  }
  const release = JSON.parse(releaseData) as { tag_name?: unknown } | null;
  if (typeof release?.tag_name !== 'string' || !release.tag_name.trim()) {
    throw new Error('No tag_name in GitHub release response');
  }
  const tag = release.tag_name;
  const downloadUrl = buildDownloadUrl(BINARY_NAME, tag);

  outputChannel.appendLine(`Downloading ${BINARY_NAME} ${tag} from ${downloadUrl}`);

  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });

  // Keep the published cache untouched until the complete download is closed and validated.
  // A unique directory on the same filesystem also isolates overlapping attempts.
  const stagingDir = fs.mkdtempSync(path.join(destDir, '.wfctl-download-'));
  const stagingPath = path.join(stagingDir, path.basename(destPath));
  try {
    const response = await getDownloadResponse(downloadUrl);
    await pipeline(response, fs.createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }));
    const size = fs.statSync(stagingPath).size;
    if (!response.complete || size === 0) {
      throw new Error('Downloaded wfctl is empty or incomplete');
    }
    const contentLength = response.headers['content-length'];
    if (contentLength !== undefined && (
      !/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength)) ||
      Number(contentLength) !== size
    )) {
      throw new Error('Downloaded wfctl size does not match Content-Length');
    }
    fs.chmodSync(stagingPath, 0o755);
    // Never unlink the existing binary: a failed replacement must leave it available.
    fs.renameSync(stagingPath, destPath);
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (err) {
      // Preserve the transfer/publication result while making cleanup failures visible.
      outputChannel.appendLine(`Could not remove download staging directory ${stagingDir}: ${err}`);
    }
  }
  outputChannel.appendLine(`${BINARY_NAME} installed to ${destPath}`);
}

function isUsableCachedBinary(binaryPath: string): boolean {
  try {
    const stat = fs.statSync(binaryPath);
    if (!stat.isFile() || stat.size === 0) {
      return false;
    }
    fs.accessSync(binaryPath, fs.constants.R_OK | (os.platform() === 'win32' ? 0 : fs.constants.X_OK));
    return true;
  } catch {
    return false;
  }
}

export async function resolveWfctlPath(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('workflow');
  const customPath = config.get<string>('wfctl.path', '');

  if (customPath) {
    if (!fs.existsSync(customPath)) {
      throw new Error(`workflow.wfctl.path is set to "${customPath}" but the file does not exist.`);
    }
    return customPath;
  }

  const defaultPath = getDefaultBinaryPath(context);
  if (isUsableCachedBinary(defaultPath)) {
    return defaultPath;
  }

  // Ask user if they want to download
  const choice = await vscode.window.showInformationMessage(
    `wfctl was not found. Download it from GitHub Releases? (required for commands and MCP integration)`,
    'Download',
    'Skip',
  );

  if (choice === 'Download') {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading wfctl...',
        cancellable: false,
      },
      async () => {
        await downloadBinary(defaultPath, outputChannel);
      },
    );
    return defaultPath;
  }

  throw new Error('wfctl not available. Install it or set workflow.wfctl.path.');
}
