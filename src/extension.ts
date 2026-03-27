import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { startLspClient, stopLspClient } from './lsp-client.js';
import { registerCommands, setWfctlPath, getWfctlPath } from './commands.js';
import { checkAndRegisterMcpServer } from './mcp-config.js';
import { resolveWfctlPath, downloadWfctl, getDefaultWfctlPath } from './wfctl.js';
import { downloadLspBinary, getDefaultLspBinaryPath } from './lsp-client.js';
import { WorkflowVisualEditorProvider, isWorkflowFile, promptWorkflowDetection } from './visual-editor.js';
import { MarketplaceProvider, MarketplaceItem } from './marketplace/MarketplaceProvider.js';
import { discoverConfigRoot } from './workspace-discovery.js';
import { registerPipelineNavigation } from './pipeline-navigation.js';
import { checkBinaryVersion } from './version-check.js';
import { parseTestOutput, applyTestDecorations } from './test-results.js';
import { DslReferenceViewProvider } from './dsl-reference.js';

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
      vscode.window.showWarningMessage(
        `Workflow LSP failed to start: ${err}. Validation and completions may be unavailable.`,
        'Show Output'
      ).then((choice) => {
        if (choice === 'Show Output') outputChannel.show(true);
      });
    });
  }

  // Offer MCP server registration
  if (config.get<boolean>('mcpServer.autoRegister', true)) {
    await checkAndRegisterMcpServer(wfctlPath, outputChannel);
  }

  // Register plugin marketplace panel
  const marketplaceProvider = new MarketplaceProvider();
  context.subscriptions.push(
    marketplaceProvider,
    vscode.window.registerTreeDataProvider('workflowPluginMarketplace', marketplaceProvider),
    vscode.commands.registerCommand('workflow.refreshMarketplace', () => marketplaceProvider.refresh()),
    vscode.commands.registerCommand('workflow.installPlugin', async (item?: MarketplaceItem) => {
      if (!item?.plugin?.name) {
        vscode.window.showWarningMessage('Select a plugin from the Marketplace panel to install.');
        return;
      }
      const name = item.plugin.name;
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        vscode.window.showErrorMessage(`Invalid plugin name: ${name}`);
        return;
      }
      const wfctl = getWfctlPath();
      outputChannel.show(true);
      outputChannel.appendLine(`> ${wfctl} plugin install ${name}`);
      const proc = child_process.spawn(wfctl, ['plugin', 'install', name], {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        shell: false,
      });
      proc.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
      proc.stderr.on('data', (data: Buffer) => outputChannel.append(data.toString()));
      proc.on('close', (code) => {
        outputChannel.appendLine(`\n[wfctl exited with code ${code}]`);
        if (code === 0) {
          vscode.window.showInformationMessage(`Plugin ${name} installed successfully.`);
        } else {
          vscode.window.showErrorMessage(`Failed to install plugin ${name} (exit code ${code}).`);
        }
      });
      proc.on('error', (err) => {
        vscode.window.showErrorMessage(`wfctl error: ${err.message}`);
      });
    })
  );

  // Register DSL reference view
  const dslReferenceProvider = new DslReferenceViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DslReferenceViewProvider.viewType, dslReferenceProvider),
    vscode.commands.registerCommand('workflow.openDslReference', () => {
      vscode.commands.executeCommand('workflowDslReference.focus');
    })
  );

  // Register wfctl test commands
  const runTests = (args: string[], targetFile?: string) => {
    outputChannel.show(true);
    outputChannel.appendLine(`> ${wfctlPath} ${args.join(' ')}`);
    let stdout = '';
    const proc = child_process.spawn(wfctlPath, args, {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      shell: false,
    });
    proc.stdout.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; outputChannel.append(s); });
    proc.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));
    proc.on('close', (code) => {
      outputChannel.appendLine(`\n[wfctl test exited with code ${code}]`);
      const results = parseTestOutput(stdout);
      if (results.length === 0) return;

      // Apply decorations to all visible _test.yaml editors
      for (const editor of vscode.window.visibleTextEditors) {
        const name = editor.document.fileName;
        if (name.endsWith('_test.yaml') || name.endsWith('_test.yml')) {
          applyTestDecorations(editor, results, context);
        }
      }
      // Also target the specific file that was tested
      if (targetFile) {
        const targetEditor = vscode.window.visibleTextEditors.find(
          (e) => e.document.fileName === targetFile
        );
        if (targetEditor) applyTestDecorations(targetEditor, results, context);
      }

      // Send to visual editor webview if open
      const resultMap: Record<string, { status: 'pass' | 'fail' | 'skip'; error?: string }> = {};
      for (const r of results) resultMap[r.name] = { status: r.status, error: r.error };
      editorProvider.sendTestResults(resultMap);
    });
    proc.on('error', (err) => outputChannel.appendLine(`wfctl error: ${err.message}`));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.test', () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
      runTests(['test', workspaceRoot]);
    }),
    vscode.commands.registerCommand('workflow.testFile', () => {
      const file = vscode.window.activeTextEditor?.document.fileName;
      if (!file) { vscode.window.showWarningMessage('Open a test file to run.'); return; }
      runTests(['test', file], file);
    }),
    vscode.commands.registerCommand('workflow.testCoverage', async () => {
      const activeFile = vscode.window.activeTextEditor?.document.fileName;
      const startPath = activeFile ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
      const rootConfig = await discoverConfigRoot(startPath);
      runTests(['test', '--coverage', rootConfig ?? '.']);
    })
  );

  // Register .feature pipeline navigation (CodeLens + goToPipeline command)
  registerPipelineNavigation(context);

  // Check for binary updates (non-blocking, once per 24h)
  checkBinaryVersion(
    context,
    'wfctl',
    wfctlPath !== 'wfctl' ? wfctlPath : getDefaultWfctlPath(context),
    outputChannel,
    () => downloadWfctl(context, outputChannel),
  ).catch(() => { /* silently ignore */ });

  checkBinaryVersion(
    context,
    'workflow-lsp-server',
    getDefaultLspBinaryPath(context),
    outputChannel,
    () => downloadLspBinary(context, outputChannel),
  ).catch(() => { /* silently ignore */ });

  outputChannel.appendLine('Workflow Engine extension activated.');
}

export async function deactivate(): Promise<void> {
  await stopLspClient();
}
