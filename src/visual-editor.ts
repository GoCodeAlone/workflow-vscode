import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { discoverPluginSchemas } from './plugin-discovery';

export class WorkflowVisualEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private document: vscode.TextDocument | undefined;
  private updatingFromEditor = false;
  private updatingFromWebview = false;

  constructor(private context: vscode.ExtensionContext) {}

  public open(document: vscode.TextDocument) {
    this.document = document;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.sendYamlToEditor(document.getText());
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'workflowVisualEditor',
      'Workflow: ' + path.basename(document.fileName),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist'),
        ],
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.sendYamlToEditor(document.getText());
    this.setupMessageHandling();
    this.setupDocumentSync();

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private setupMessageHandling() {
    this.panel!.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'yamlUpdated':
          this.handleYamlFromWebview(msg.content);
          break;
        case 'navigateToLine':
          this.navigateToLine(msg.line, msg.col);
          break;
        case 'requestSchemas':
          this.sendSchemas();
          break;
        case 'aiRequest':
          this.handleAIRequest(msg.yaml, msg.moduleTypes, msg.userPrompt);
          break;
        case 'resolveFile':
          this.handleResolveFile(msg.requestId, msg.relativePath);
          break;
        case 'saveFiles':
          this.handleSaveFiles(msg.entries);
          break;
        case 'ready':
          this.sendYamlToEditor(this.document!.getText());
          this.sendSchemas();
          break;
        case 'layoutChanged': {
          const yamlUri = this.document!.uri;
          const sidecarUri = vscode.Uri.file(yamlUri.fsPath.replace(/\.ya?ml$/, '.workflow-editor.json'));
          const content = new TextEncoder().encode(JSON.stringify(msg.layout, null, 2));
          vscode.workspace.fs.writeFile(sidecarUri, content);
          break;
        }
      }
    });
  }

  private setupDocumentSync() {
    // Watch for text editor changes
    const docSyncDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.document && !this.updatingFromWebview) {
        this.updatingFromEditor = true;
        this.sendYamlToEditor(e.document.getText());
        this.updatingFromEditor = false;
      }
    });

    // Watch for cursor position changes
    const cursorSyncDisposable = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document === this.document) {
        const pos = e.selections[0].active;
        this.panel?.webview.postMessage({
          type: 'cursorMoved',
          line: pos.line + 1,
          col: pos.character + 1,
        });
      }
    });

    // Clean up listeners when panel is disposed
    this.panel!.onDidDispose(() => {
      docSyncDisposable.dispose();
      cursorSyncDisposable.dispose();
    });
  }

  private async sendYamlToEditor(content: string) {
    this.panel?.webview.postMessage({ type: 'yamlChanged', content });
    if (this.document) {
      const uri = this.document.uri;
      const sidecarUri = vscode.Uri.file(uri.fsPath.replace(/\.ya?ml$/, '.workflow-editor.json'));
      try {
        const sidecarContent = await vscode.workspace.fs.readFile(sidecarUri);
        this.panel?.webview.postMessage({ type: 'layoutLoaded', layout: JSON.parse(new TextDecoder().decode(sidecarContent)) });
      } catch {
        // No sidecar file — editor will use auto-layout
      }
    }
  }

  private async handleYamlFromWebview(content: string) {
    if (!this.document || this.updatingFromEditor) return;
    this.updatingFromWebview = true;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(0, 0, this.document.lineCount, 0),
      content
    );
    await vscode.workspace.applyEdit(edit);

    this.updatingFromWebview = false;
  }

  private navigateToLine(line: number, col: number) {
    if (!this.document) return;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === this.document
    );
    if (editor) {
      const pos = new vscode.Position(line - 1, col - 1);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async sendSchemas() {
    const schemaPath = path.join(this.context.extensionPath, 'schemas', 'workflow-config.schema.json');
    try {
      const content = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(content);
      this.panel?.webview.postMessage({ type: 'schemasLoaded', schemas: schema });
    } catch {
      // Schema file not available — editor degrades gracefully
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const plugins = await discoverPluginSchemas(workspaceRoot, this.context.globalStorageUri);
      if (plugins.length > 0) {
        this.panel?.webview.postMessage({ type: 'pluginSchemasLoaded', plugins });
      }
    }
  }

  private async handleAIRequest(currentYaml: string, moduleTypes: string[], userPrompt: string) {
    // Empty userPrompt means IDE embedded mode — open Copilot chat with context on clipboard
    if (!userPrompt) {
      const context = `You are a Workflow Engine configuration expert.\nAvailable module types: ${moduleTypes.join(', ')}\nReturn ONLY the complete updated YAML config. No explanations, no markdown fences.\n\nCurrent workflow YAML:\n\`\`\`yaml\n${currentYaml}\n\`\`\``;
      await vscode.env.clipboard.writeText(context);
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
      } catch {
        // Chat panel may not be available
      }
      vscode.window.showInformationMessage(
        'Workflow context copied to clipboard. Paste into Copilot chat and describe what you\'d like to change.'
      );
      return;
    }

    // Non-empty userPrompt — use Language Model API directly
    const lm = (vscode as any).lm;
    if (!lm?.selectChatModels) {
      vscode.window.showWarningMessage(
        'AI-assisted design requires VS Code 1.90+ with GitHub Copilot installed.'
      );
      return;
    }

    try {
      const models = await lm.selectChatModels();
      if (!models || models.length === 0) {
        vscode.window.showWarningMessage(
          'No AI models available. Please install GitHub Copilot extension.'
        );
        return;
      }

      const model = models[0];
      const systemPrompt = `You are a Workflow Engine configuration assistant. You modify YAML configurations for the GoCodeAlone/workflow engine.

Available module types: ${moduleTypes.join(', ')}

Rules:
- Output ONLY valid workflow YAML — no markdown fences, no explanation
- Preserve existing modules unless the user asks to remove them
- Use proper module names (lowercase, hyphenated)
- Each module needs: name, type, and config (if required)`;

      const messages = [
        (vscode as any).LanguageModelChatMessage.User(`${systemPrompt}\n\nCurrent workflow YAML:\n\`\`\`yaml\n${currentYaml}\n\`\`\`\n\nUser request: ${userPrompt}`),
      ];

      const response = await model.sendRequest(messages);
      let result = '';
      for await (const chunk of response.text) {
        result += chunk;
      }

      // Strip markdown fences if the model wraps the output
      result = result.replace(/^```ya?ml\n?/m, '').replace(/\n?```\s*$/m, '').trim();

      this.panel?.webview.postMessage({ type: 'aiResponse', content: result });
    } catch (e: any) {
      vscode.window.showErrorMessage(`AI request failed: ${e.message || e}`);
    }
  }

  private async handleResolveFile(requestId: string, relativePath: string) {
    if (!this.document) {
      this.panel?.webview.postMessage({ type: 'resolveFileResponse', requestId, content: null });
      return;
    }
    try {
      const docDir = path.dirname(this.document.uri.fsPath);
      const targetPath = path.resolve(docDir, relativePath);
      const content = fs.readFileSync(targetPath, 'utf-8');
      this.panel?.webview.postMessage({ type: 'resolveFileResponse', requestId, content });
    } catch {
      this.panel?.webview.postMessage({ type: 'resolveFileResponse', requestId, content: null });
    }
  }

  private async handleSaveFiles(entries: Array<{ path: string | null; content: string }>) {
    if (!this.document) return;
    const docDir = path.dirname(this.document.uri.fsPath);

    for (const entry of entries) {
      if (entry.path === null) {
        // Main file — update the open document
        this.updatingFromWebview = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          this.document.uri,
          new vscode.Range(0, 0, this.document.lineCount, 0),
          entry.content
        );
        await vscode.workspace.applyEdit(edit);
        this.updatingFromWebview = false;
      } else {
        // Imported file — write to disk
        const targetPath = path.resolve(docDir, entry.path);
        const targetUri = vscode.Uri.file(targetPath);
        const encoder = new TextEncoder();
        // Ensure parent directory exists
        const targetDir = path.dirname(targetPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        await vscode.workspace.fs.writeFile(targetUri, encoder.encode(entry.content));
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist', 'index.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <style>html, body, #root { height: 100%; margin: 0; overflow: hidden; }</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function isExplicitMatch(document: vscode.TextDocument, configPaths: string[]): boolean {
  if (configPaths.length === 0) return false;
  for (const pattern of configPaths) {
    if (vscode.languages.match({ pattern }, document) > 0) return true;
  }
  return false;
}

function isContentMatch(document: vscode.TextDocument): boolean {
  const text = document.getText();
  return text.includes('modules:') && text.includes('workflows:');
}

export function isWorkflowFile(document: vscode.TextDocument): boolean {
  const configPaths: string[] = vscode.workspace.getConfiguration('workflow').get('configPaths', []);
  return isExplicitMatch(document, configPaths) || isContentMatch(document);
}

export function promptWorkflowDetection(document: vscode.TextDocument) {
  if (document.languageId !== 'yaml') return;
  const configPaths: string[] = vscode.workspace.getConfiguration('workflow').get('configPaths', []);
  if (isExplicitMatch(document, configPaths)) return;
  if (vscode.workspace.getConfiguration('workflow').get('suppressDetectionPrompt', false)) return;
  if (!isContentMatch(document)) return;

  vscode.window.showInformationMessage(
    'This looks like a Workflow config. Open the visual editor?',
    'Open Visual Editor',
    'Always for this file',
    "Don't ask again"
  ).then((choice) => {
    if (choice === 'Open Visual Editor') {
      vscode.commands.executeCommand('workflow.openVisualEditor');
    } else if (choice === 'Always for this file') {
      const config = vscode.workspace.getConfiguration('workflow');
      const paths: string[] = config.get('configPaths', []);
      config.update('configPaths', [...paths, document.uri.fsPath], vscode.ConfigurationTarget.Workspace);
    } else if (choice === "Don't ask again") {
      vscode.workspace.getConfiguration('workflow').update('suppressDetectionPrompt', true, vscode.ConfigurationTarget.Global);
    }
  });
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
