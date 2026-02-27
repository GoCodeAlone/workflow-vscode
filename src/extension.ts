import * as vscode from 'vscode';
import { startLspClient, stopLspClient } from './lsp-client.js';
import { registerCommands } from './commands.js';
import { checkAndRegisterMcpServer } from './mcp-config.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Workflow');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Workflow Engine extension activating...');

  // Register wfctl command palette commands
  registerCommands(context, outputChannel);

  // Start the LSP client if enabled
  const config = vscode.workspace.getConfiguration('workflow');
  if (config.get<boolean>('lspServer.enabled', true)) {
    try {
      await startLspClient(context, outputChannel);
      outputChannel.appendLine('LSP client started.');
    } catch (err) {
      outputChannel.appendLine(`LSP client failed to start: ${err}`);
      // Non-fatal: extension still provides commands and snippets
    }
  }

  // Offer MCP server registration
  if (config.get<boolean>('mcpServer.autoRegister', true)) {
    await checkAndRegisterMcpServer(outputChannel);
  }

  outputChannel.appendLine('Workflow Engine extension activated.');
}

export async function deactivate(): Promise<void> {
  await stopLspClient();
}
