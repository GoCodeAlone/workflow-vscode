import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as child_process from 'child_process';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node.js';

let client: LanguageClient | undefined;

const GITHUB_REPO = 'GoCodeAlone/workflow';
const BINARY_NAME = 'workflow-lsp-server';

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

export function buildLspDownloadUrl(tag: string): string {
  const suffix = getPlatformSuffix();
  const binaryFileName = os.platform() === 'win32' ? `${BINARY_NAME}-${suffix}.exe` : `${BINARY_NAME}-${suffix}`;
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${binaryFileName}`;
}

export { getPlatformSuffix as getLspPlatformSuffix };

export function getDefaultLspBinaryPath(context: vscode.ExtensionContext): string {
  return getDefaultBinaryPath(context);
}

function getDefaultBinaryPath(context: vscode.ExtensionContext): string {
  const suffix = getPlatformSuffix();
  const binaryFileName = os.platform() === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
  return path.join(context.globalStorageUri.fsPath, 'bin', suffix, binaryFileName);
}

export async function downloadLspBinary(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<void> {
  const destPath = getDefaultBinaryPath(context);
  await downloadBinary(destPath, outputChannel);
}

async function downloadBinary(destPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
  const suffix = getPlatformSuffix();
  const binaryFileName = os.platform() === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;

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
  // Release assets are raw binaries: workflow-lsp-server-{os}-{arch}[.exe]
  const assetName = os.platform() === 'win32'
    ? `${BINARY_NAME}-${suffix}.exe`
    : `${BINARY_NAME}-${suffix}`;
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;

  outputChannel.appendLine(`Downloading ${BINARY_NAME} ${tag} from ${downloadUrl}`);

  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });

  // Follow redirects properly (GitHub uses multi-hop redirects)
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    function followRedirects(url: string, maxRedirects: number) {
      if (maxRedirects <= 0) {
        reject(new Error('Too many redirects'));
        return;
      }
      https.get(url, { headers: { 'User-Agent': 'workflow-vscode' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error('Redirect with no location'));
            return;
          }
          res.resume(); // consume response to free up memory
          followRedirects(location, maxRedirects - 1);
        } else if (res.statusCode === 200) {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        } else {
          reject(new Error(`Download failed with status ${res.statusCode}`));
        }
      }).on('error', reject);
    }

    followRedirects(downloadUrl, 5);
  });

  // Verify downloaded file is actually a binary, not an HTML error page
  const firstBytes = fs.readFileSync(destPath, { encoding: null }).subarray(0, 4);
  const header = firstBytes.toString('ascii');
  if (header.startsWith('<!DO') || header.startsWith('<htm') || header.startsWith('<HTM')) {
    fs.unlinkSync(destPath);
    throw new Error('Downloaded file appears to be HTML, not a binary. Check the release URL.');
  }

  fs.chmodSync(destPath, 0o755);

  outputChannel.appendLine(`${BINARY_NAME} installed to ${destPath}`);
}

async function resolveLspBinaryPath(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('workflow');
  const customPath = config.get<string>('lspServer.path', '');

  if (customPath) {
    if (!fs.existsSync(customPath)) {
      throw new Error(`workflow.lspServer.path is set to "${customPath}" but the file does not exist.`);
    }
    return customPath;
  }

  const defaultPath = getDefaultBinaryPath(context);
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  // Ask user if they want to download
  const choice = await vscode.window.showInformationMessage(
    `The ${BINARY_NAME} binary was not found. Download it from GitHub Releases?`,
    'Download',
    'Disable LSP',
  );

  if (choice === 'Download') {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${BINARY_NAME}...`,
        cancellable: false,
      },
      async () => {
        await downloadBinary(defaultPath, outputChannel);
      },
    );
    return defaultPath;
  }

  await config.update('lspServer.enabled', false, vscode.ConfigurationTarget.Global);
  throw new Error('LSP disabled by user.');
}

export const LSP_DOCUMENT_SELECTOR = [
  { scheme: 'file', language: 'yaml', pattern: '**/workflow.yaml' },
  { scheme: 'file', language: 'yaml', pattern: '**/workflow.yml' },
  { scheme: 'file', language: 'yaml', pattern: '**/app.yaml' },
  { scheme: 'file', language: 'yaml', pattern: '**/app.yml' },
  { scheme: 'file', language: 'yaml', pattern: '**/wfctl.yaml' },
  { scheme: 'file', language: 'yaml', pattern: '**/wfctl.yml' },
  { scheme: 'file', language: 'yaml', pattern: '**/infra.yaml' },
  { scheme: 'file', language: 'yaml', pattern: '**/infra.yml' },
] as const;

export async function startLspClient(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const serverBin = await resolveLspBinaryPath(context, outputChannel);

  const serverOptions: ServerOptions = {
    command: serverBin,
    args: [],
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [...LSP_DOCUMENT_SELECTOR],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml}'),
    },
    outputChannel,
  };

  client = new LanguageClient(
    'workflowLsp',
    'Workflow LSP',
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(client);
  await client.start();
}

export async function stopLspClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
