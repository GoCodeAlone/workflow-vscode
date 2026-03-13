import * as vscode from 'vscode';
import { startLspClient, stopLspClient } from './lsp-client.js';
import { registerCommands, setWfctlPath } from './commands.js';
import { checkAndRegisterMcpServer } from './mcp-config.js';
import { resolveWfctlPath } from './wfctl.js';
import { WorkflowVisualEditorProvider, isWorkflowFile, promptWorkflowDetection } from './visual-editor.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Workflow');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Workflow Engine extension activating...');

  // Resolve wfctl binary (auto-download if needed)
  let wfctlPath = 'wfctl';
  try {
    wfctlPath = await resolveWfctlPath(context, outputChannel);
    outputChannel.appendLine(`wfctl resolved to: ${wfctlPath}`);
  } catch (err) {
    outputChannel.appendLine(`wfctl not available: ${err}. Commands may not work.`);
  }

  // Set the resolved path for command execution
  setWfctlPath(wfctlPath);

  // Register wfctl command palette commands
  registerCommands(context, outputChannel);

  // Register visual editor
  const editorProvider = new WorkflowVisualEditorProvider(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.openVisualEditor', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && (editor.document.fileName.endsWith('.yaml') || editor.document.fileName.endsWith('.yml'))) {
        editorProvider.open(editor.document);
      }
    })
  );

  // Show detection prompt when a YAML file is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'yaml') promptWorkflowDetection(doc);
    })
  );

  // Start the LSP client if enabled (non-blocking)
  const config = vscode.workspace.getConfiguration('workflow');
  if (config.get<boolean>('lspServer.enabled', true)) {
    startLspClient(context, outputChannel).catch((err) => {
      outputChannel.appendLine(`LSP client not started: ${err}`);
    });
  }

  // Offer MCP server registration
  if (config.get<boolean>('mcpServer.autoRegister', true)) {
    await checkAndRegisterMcpServer(wfctlPath, outputChannel);
  }

  outputChannel.appendLine('Workflow Engine extension activated.');
}

export async function deactivate(): Promise<void> {
  await stopLspClient();
}
