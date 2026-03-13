import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';

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

function getDefaultBinaryPath(context: vscode.ExtensionContext): string {
  const suffix = getPlatformSuffix();
  const binaryFileName = os.platform() === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
  return path.join(context.globalStorageUri.fsPath, 'bin', suffix, binaryFileName);
}

async function downloadBinary(destPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
  const suffix = getPlatformSuffix();

  // Fetch latest release tag from GitHub API
  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  outputChannel.appendLine(`Fetching latest release from ${releaseUrl}`);

  const releaseData = await new Promise<string>((resolve, reject) => {
    const req = https.get(releaseUrl, { headers: { 'User-Agent': 'workflow-vscode' } }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });

  const release = JSON.parse(releaseData) as { tag_name: string };
  const tag = release.tag_name;
  const assetName = os.platform() === 'win32'
    ? `${BINARY_NAME}-${suffix}.exe`
    : `${BINARY_NAME}-${suffix}`;
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;

  outputChannel.appendLine(`Downloading ${BINARY_NAME} ${tag} from ${downloadUrl}`);

  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(downloadUrl, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const location = res.headers.location;
        if (!location) {
          reject(new Error('Redirect with no location'));
          return;
        }
        https.get(location, (res2) => {
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      } else {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }
    }).on('error', reject);
  });

  fs.chmodSync(destPath, 0o755);
  outputChannel.appendLine(`${BINARY_NAME} installed to ${destPath}`);
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
  if (fs.existsSync(defaultPath)) {
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
