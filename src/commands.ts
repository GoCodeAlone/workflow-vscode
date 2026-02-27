import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

function getWfctlPath(): string {
  const config = vscode.workspace.getConfiguration('workflow');
  return config.get<string>('wfctl.path', 'wfctl');
}

function getActiveFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.fsPath;
}

function runWfctl(
  args: string[],
  outputChannel: vscode.OutputChannel,
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const wfctl = getWfctlPath();
    const cmd = `${wfctl} ${args.join(' ')}`;
    outputChannel.show(true);
    outputChannel.appendLine(`> ${cmd}`);

    const proc = child_process.spawn(wfctl, args, {
      cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      shell: false,
    });

    proc.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
    proc.stderr.on('data', (data: Buffer) => outputChannel.append(data.toString()));

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        vscode.window.showErrorMessage(
          `wfctl not found at "${wfctl}". Install it from https://github.com/GoCodeAlone/workflow or set workflow.wfctl.path.`,
        );
      } else {
        vscode.window.showErrorMessage(`wfctl error: ${err.message}`);
      }
      reject(err);
    });

    proc.on('close', (code) => {
      outputChannel.appendLine(`\n[wfctl exited with code ${code}]`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`wfctl exited with code ${code}`));
      }
    });
  });
}

function runWfctlInTerminal(args: string[], cwd?: string): void {
  const wfctl = getWfctlPath();
  const terminal = vscode.window.createTerminal({
    name: 'Workflow',
    cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  terminal.show();
  terminal.sendText(`${wfctl} ${args.join(' ')}`);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  // workflow.validate — runs wfctl template validate --config <active-file>
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.validate', async () => {
      const file = getActiveFilePath();
      if (!file) {
        vscode.window.showWarningMessage('No active file to validate.');
        return;
      }
      const args = ['template', 'validate', '--config', file];
      await runWfctl(args, outputChannel, path.dirname(file)).catch(() => {});
    }),
  );

  // workflow.inspect — runs wfctl inspect -deps <active-file>
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.inspect', async () => {
      const file = getActiveFilePath();
      if (!file) {
        vscode.window.showWarningMessage('No active file to inspect.');
        return;
      }
      await runWfctl(['inspect', '-deps', file], outputChannel, path.dirname(file)).catch(() => {});
    }),
  );

  // workflow.init — quick pick template then runs wfctl template init
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.init', async () => {
      const templates = [
        { label: 'api-service', description: 'REST API service with HTTP server and router' },
        { label: 'event-processor', description: 'Event-driven pipeline with queues' },
        { label: 'full-stack', description: 'Full-stack app with API, UI, and database' },
        { label: 'plugin', description: 'gRPC plugin scaffold' },
        { label: 'ui-plugin', description: 'Go gRPC plugin wrapping a React SPA' },
      ];

      const pick = await vscode.window.showQuickPick(templates, {
        placeHolder: 'Select a project template',
        matchOnDescription: true,
      });
      if (!pick) {
        return;
      }

      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await runWfctl(['template', 'init', pick.label], outputChannel, folder).catch(() => {});
    }),
  );

  // workflow.templateValidate — runs wfctl template validate (no file arg)
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.templateValidate', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await runWfctl(['template', 'validate'], outputChannel, folder).catch(() => {});
    }),
  );

  // workflow.run — runs wfctl run -config <active-file> in a terminal (long-running)
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.run', () => {
      const file = getActiveFilePath();
      if (!file) {
        vscode.window.showWarningMessage('No active config file to run.');
        return;
      }
      runWfctlInTerminal(['run', '-config', file], path.dirname(file));
    }),
  );

  // workflow.schema — runs wfctl schema and opens result in editor
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.schema', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      outputChannel.show(true);
      outputChannel.appendLine('> wfctl schema');

      const wfctl = getWfctlPath();
      child_process.exec(
        `${wfctl} schema`,
        { cwd: folder },
        async (err, stdout, stderr) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              vscode.window.showErrorMessage(
                `wfctl not found at "${wfctl}". Install it or set workflow.wfctl.path.`,
              );
            } else {
              outputChannel.appendLine(stderr);
              vscode.window.showErrorMessage(`wfctl schema failed: ${err.message}`);
            }
            return;
          }

          const doc = await vscode.workspace.openTextDocument({
            content: stdout,
            language: 'json',
          });
          await vscode.window.showTextDocument(doc);
        },
      );
    }),
  );
}
