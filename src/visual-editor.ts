import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
        case 'ready':
          this.sendYamlToEditor(this.document!.getText());
          this.sendSchemas();
          break;
      }
    });
  }

  private setupDocumentSync() {
    // Watch for text editor changes
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.document && !this.updatingFromWebview) {
        this.updatingFromEditor = true;
        this.sendYamlToEditor(e.document.getText());
        this.updatingFromEditor = false;
      }
    });

    // Watch for cursor position changes
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document === this.document) {
        const pos = e.selections[0].active;
        this.panel?.webview.postMessage({
          type: 'cursorMoved',
          line: pos.line + 1,
          col: pos.character + 1,
        });
      }
    });
  }

  private sendYamlToEditor(content: string) {
    this.panel?.webview.postMessage({ type: 'yamlChanged', content });
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

  private sendSchemas() {
    const schemaPath = path.join(this.context.extensionPath, 'schemas', 'workflow-config.schema.json');
    try {
      const content = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(content);
      this.panel?.webview.postMessage({ type: 'schemasLoaded', schemas: schema });
    } catch {
      // Schema file not available — editor degrades gracefully
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

export function isWorkflowFile(document: vscode.TextDocument): boolean {
  // Layer 1: explicit configPaths setting
  const configPaths: string[] = vscode.workspace.getConfiguration('workflow').get('configPaths', []);
  if (configPaths.length > 0) {
    const relative = vscode.workspace.asRelativePath(document.uri);
    for (const pattern of configPaths) {
      if (vscode.languages.match({ pattern }, document) > 0) return true;
    }
  }

  // Layer 2: content detection
  const text = document.getText(new vscode.Range(0, 0, 50, 0));
  return /^modules:/m.test(text) && /^workflows:/m.test(text);
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
