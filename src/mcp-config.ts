import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
}

const MCP_SERVER_KEY = 'workflow';

function getMcpConfigPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return path.join(workspaceFolder.uri.fsPath, '.vscode', 'mcp.json');
}

function readMcpConfig(mcpPath: string): McpConfig {
  if (!fs.existsSync(mcpPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(mcpPath, 'utf-8');
    return JSON.parse(raw) as McpConfig;
  } catch {
    return {};
  }
}

function writeMcpConfig(mcpPath: string, config: McpConfig): void {
  const dir = path.dirname(mcpPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function hasWorkflowServer(config: McpConfig): boolean {
  return !!(config.servers && config.servers[MCP_SERVER_KEY]);
}

export async function checkAndRegisterMcpServer(
  wfctlPath: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const workspaceFolder = workspaceFolders[0];
  const mcpPath = getMcpConfigPath(workspaceFolder);
  const currentConfig = readMcpConfig(mcpPath);

  if (hasWorkflowServer(currentConfig)) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Add the Workflow MCP server to .vscode/mcp.json for AI assistant integration?',
    'Add',
    'Not Now',
    'Never',
  );

  if (choice === 'Add') {
    const mcpConfig: McpServerConfig = {
      command: wfctlPath,
      args: ['mcp'],
    };
    const updated: McpConfig = {
      ...currentConfig,
      servers: {
        ...(currentConfig.servers ?? {}),
        [MCP_SERVER_KEY]: mcpConfig,
      },
    };
    writeMcpConfig(mcpPath, updated);
    outputChannel.appendLine(`MCP server config written to ${mcpPath}`);
    vscode.window.showInformationMessage('Workflow MCP server registered in .vscode/mcp.json.');
  } else if (choice === 'Never') {
    const config = vscode.workspace.getConfiguration('workflow');
    await config.update('mcpServer.autoRegister', false, vscode.ConfigurationTarget.Workspace);
    outputChannel.appendLine('MCP auto-registration disabled for this workspace.');
  }
}
