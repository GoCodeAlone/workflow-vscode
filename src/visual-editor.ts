import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { discoverPluginSchemas } from './plugin-discovery';
import { detectWorkflowFileType } from './file-detection';
import { discoverConfigRoot } from './workspace-discovery';

export class WorkflowVisualEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private document: vscode.TextDocument | undefined;
  private updatingFromEditor = false;
  private updatingFromWebview = false;
  private yamlPreamble: string = '';
  private sourceMap: Record<string, string> = {};
  private rootConfigPath: string | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  public async open(document: vscode.TextDocument) {
    this.document = document;

    // Detect partial files and resolve the full merged config from workspace
    const fileType = detectWorkflowFileType(document);
    if (fileType === 'partial') {
      const rootConfig = await discoverConfigRoot(document.fileName);
      if (rootConfig) {
        try {
          const resolved = resolveFullConfig(rootConfig);
          this.sourceMap = resolved.sourceMap;
          this.rootConfigPath = rootConfig;
          this.openWithContent(document, resolved.yaml, rootConfig);
          return;
        } catch (err) {
          vscode.window.showWarningMessage(
            `Could not resolve workspace config from ${path.basename(rootConfig)}: ${err}`
          );
        }
      } else {
        vscode.window.showWarningMessage(
          'Could not find a root workflow config for this partial file. Open the root config to use the visual editor.'
        );
        return;
      }
    }

    this.sourceMap = {};
    this.rootConfigPath = undefined;
    this.openWithContent(document, document.getText());
  }

  private openWithContent(document: vscode.TextDocument, yamlContent: string, rootConfigPath?: string) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.sendYamlToEditor(yamlContent);
      return;
    }

    const title = rootConfigPath
      ? `Workflow: ${path.basename(document.fileName)} (via ${path.basename(rootConfigPath)})`
      : `Workflow: ${path.basename(document.fileName)}`;

    this.panel = vscode.window.createWebviewPanel(
      'workflowVisualEditor',
      title,
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
    this.sendYamlToEditor(yamlContent);
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
          this.navigateToLine(msg.line, msg.col, msg.filePath);
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
        case 'saveToFile':
          this.handleSaveToFile(msg.filePath, msg.content);
          break;
        case 'ready':
          if (this.rootConfigPath) {
            try {
              const resolved = resolveFullConfig(this.rootConfigPath);
              this.sourceMap = resolved.sourceMap;
              this.sendYamlToEditorWithSourceMap(resolved.yaml, resolved.sourceMap, this.document!.fileName);
            } catch {
              this.sendYamlToEditor(this.document!.getText());
            }
          } else {
            this.sendYamlToEditor(this.document!.getText());
          }
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
    // Watch for text editor changes (main file and imported files)
    const docSyncDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.document && !this.updatingFromWebview) {
        this.updatingFromEditor = true;
        this.sendYamlToEditor(e.document.getText());
        this.updatingFromEditor = false;
      } else if (this.isTrackedImport(e.document.uri.fsPath)) {
        // An imported file changed — notify webview and re-resolve merged config
        this.panel?.webview.postMessage({
          type: 'fileChanged',
          filePath: e.document.uri.fsPath,
          content: e.document.getText(),
        });
        if (this.rootConfigPath) {
          try {
            const resolved = resolveFullConfig(this.rootConfigPath);
            this.sourceMap = resolved.sourceMap;
            this.sendYamlToEditorWithSourceMap(resolved.yaml, resolved.sourceMap, this.document!.fileName);
          } catch { /* ignore resolution errors */ }
        }
      }
    });

    // Watch for cursor position changes
    const cursorSyncDisposable = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document === this.document) {
        const pos = e.selections[0].active;
        const line = pos.line + 1;
        const col = pos.character + 1;
        this.panel?.webview.postMessage({ type: 'cursorMoved', line, col });
        // Also send navigateToNode so the webview can select the corresponding node
        this.panel?.webview.postMessage({
          type: 'navigateToNode',
          filePath: this.document.uri.fsPath,
          line,
        });
      }
    });

    // Clean up listeners when panel is disposed
    this.panel!.onDidDispose(() => {
      docSyncDisposable.dispose();
      cursorSyncDisposable.dispose();
    });
  }

  /** Returns true when filePath is one of the imported files tracked in the source map. */
  private isTrackedImport(filePath: string): boolean {
    return Object.values(this.sourceMap).includes(filePath);
  }

  private async sendYamlToEditor(content: string) {
    // Extract and store top-level name/version preamble before sending to webview
    if (!this.updatingFromWebview) {
      this.yamlPreamble = extractYamlPreamble(content);
    }
    const msg: Record<string, unknown> = { type: 'yamlChanged', content };
    if (Object.keys(this.sourceMap).length > 0) {
      msg.sourceMap = this.sourceMap;
      msg.activeFile = this.document?.fileName;
    }
    this.panel?.webview.postMessage(msg);
    await this.loadSidecarLayout();
  }

  private async sendYamlToEditorWithSourceMap(
    content: string,
    sourceMap: Record<string, string>,
    activeFile: string
  ) {
    if (!this.updatingFromWebview) {
      this.yamlPreamble = extractYamlPreamble(content);
    }
    this.panel?.webview.postMessage({ type: 'yamlChanged', content, sourceMap, activeFile });
    await this.loadSidecarLayout();
  }

  private async loadSidecarLayout() {
    if (this.document) {
      const uri = this.document.uri;
      const sidecarUri = vscode.Uri.file(uri.fsPath.replace(/\.ya?ml$/, '.workflow-editor.json'));
      try {
        const sidecarContent = await vscode.workspace.fs.readFile(sidecarUri);
        this.panel?.webview.postMessage({ type: 'layoutLoaded', layout: JSON.parse(new TextDecoder().decode(sidecarContent)) });
      } catch (err) {
        // No sidecar file — editor will use auto-layout
        console.warn('No sidecar file found, using auto-layout:', sidecarUri.fsPath, err);
      }
    }
  }

  private async handleYamlFromWebview(content: string) {
    if (!this.document || this.updatingFromEditor) return;
    this.updatingFromWebview = true;

    // Re-inject preamble (name/version) if the webview stripped it
    const merged = mergeYamlPreamble(this.yamlPreamble, content);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(0, 0, this.document.lineCount, 0),
      merged
    );
    await vscode.workspace.applyEdit(edit);

    this.updatingFromWebview = false;
  }

  private navigateToLine(line: number, col: number, filePath?: string | null) {
    const pos = new vscode.Position(line - 1, Math.max(0, col - 1));

    // Cross-file navigation: open the target file if different from current document
    if (filePath && filePath !== this.document?.uri.fsPath) {
      vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then((doc) => {
        vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true }).then((editor) => {
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        });
      }).catch(() => {
        vscode.window.showErrorMessage(`Workflow editor: could not open file '${filePath}'`);
      });
      return;
    }

    // Same-file navigation
    if (!this.document) return;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document === this.document
    );
    if (editor) {
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  public sendTestResults(results: Record<string, { status: 'pass' | 'fail' | 'skip'; error?: string }>) {
    this.panel?.webview.postMessage({ type: 'testResults', results });
  }

  private async sendSchemas() {
    const schemaPath = path.join(this.context.extensionPath, 'schemas', 'workflow-config.schema.json');
    try {
      const content = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(content);
      this.panel?.webview.postMessage({ type: 'schemasLoaded', schemas: schema });
    } catch (err) {
      // Schema file not available — editor degrades gracefully
      console.warn('Schema file not available:', schemaPath, err);
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
      } catch (err) {
        // Chat panel may not be available
        console.warn('Chat panel could not be opened:', err);
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
        // Main file — update the open document, restoring preamble
        this.updatingFromWebview = true;
        const merged = mergeYamlPreamble(this.yamlPreamble, entry.content);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          this.document.uri,
          new vscode.Range(0, 0, this.document.lineCount, 0),
          merged
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

  private async handleSaveToFile(filePath: string, content: string) {
    const targetUri = vscode.Uri.file(filePath);
    const encoder = new TextEncoder();
    const targetDir = path.dirname(filePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    await vscode.workspace.fs.writeFile(targetUri, encoder.encode(content));
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

export function isWorkflowFile(document: vscode.TextDocument): boolean {
  const configPaths: string[] = vscode.workspace.getConfiguration('workflow').get('configPaths', []);
  if (isExplicitMatch(document, configPaths)) return true;
  const type = detectWorkflowFileType(document);
  return type === 'config' || type === 'partial';
}

export function promptWorkflowDetection(document: vscode.TextDocument) {
  if (document.languageId !== 'yaml') return;
  const configPaths: string[] = vscode.workspace.getConfiguration('workflow').get('configPaths', []);
  if (isExplicitMatch(document, configPaths)) return;
  if (vscode.workspace.getConfiguration('workflow').get('suppressDetectionPrompt', false)) return;

  const fileType = detectWorkflowFileType(document);

  if (fileType === 'partial') {
    discoverConfigRoot(document.fileName).then((rootConfig) => {
      if (rootConfig) {
        vscode.window.showInformationMessage(
          `This is a partial workflow config. Open the visual editor? (Workspace config: ${path.basename(rootConfig)})`,
          'Open Visual Editor'
        ).then((choice) => {
          if (choice === 'Open Visual Editor') {
            vscode.commands.executeCommand('workflow.openVisualEditor');
          }
        });
      } else {
        vscode.window.showInformationMessage(
          'This file appears to be a partial workflow config. Open the root config file to use the visual editor.'
        );
      }
    });
    return;
  }

  if (fileType !== 'config') return;

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

/**
 * Resolve a full merged workflow config from a root config file, following
 * imports and building a sourceMap that tracks which file each top-level
 * entity (module name, pipeline name) originated from.
 */
export function resolveFullConfig(rootPath: string): { yaml: string; sourceMap: Record<string, string> } {
  const rootDir = path.dirname(rootPath);
  const rootContent = fs.readFileSync(rootPath, 'utf-8');
  const sourceMap: Record<string, string> = {};

  // Track entities from root
  for (const name of parseYamlModuleNames(rootContent)) {
    sourceMap[name] = rootPath;
  }
  for (const name of parseYamlMappingKeys(rootContent, 'pipelines')) {
    sourceMap[name] = rootPath;
  }

  // Follow imports
  const imports = parseYamlStringList(rootContent, 'imports');
  const importedSections: string[] = [];

  for (const importPath of imports) {
    const fullPath = path.resolve(rootDir, importPath);
    let importContent: string;
    try {
      importContent = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    for (const name of parseYamlModuleNames(importContent)) {
      sourceMap[name] = fullPath;
    }
    for (const name of parseYamlMappingKeys(importContent, 'pipelines')) {
      sourceMap[name] = fullPath;
    }

    // Collect sections to merge (strip top-level keys we'll merge into root)
    const modulesBlock = extractYamlSection(importContent, 'modules');
    const pipelinesBlock = extractYamlSection(importContent, 'pipelines');
    const workflowsBlock = extractYamlSection(importContent, 'workflows');
    if (modulesBlock) importedSections.push(modulesBlock);
    if (pipelinesBlock) importedSections.push(pipelinesBlock);
    if (workflowsBlock) importedSections.push(workflowsBlock);
  }

  // Build merged YAML: root without imports section + appended import sections
  const rootWithoutImports = removeYamlSection(rootContent, 'imports');
  const yaml = importedSections.length > 0
    ? rootWithoutImports.trimEnd() + '\n' + importedSections.join('\n')
    : rootWithoutImports;

  return { yaml, sourceMap };
}

/** Extract a top-level YAML section block (key + its indented content). */
function extractYamlSection(content: string, key: string): string {
  const lines = content.split('\n');
  let inSection = false;
  const result: string[] = [];

  for (const line of lines) {
    if (!inSection) {
      if (new RegExp(`^${key}:`).test(line)) {
        inSection = true;
        result.push(line);
      }
    } else {
      // Continue while indented or blank
      if (line === '' || /^\s/.test(line)) {
        result.push(line);
      } else {
        break;
      }
    }
  }

  return result.length > 0 ? result.join('\n') : '';
}

/** Remove a top-level YAML section block from content. */
function removeYamlSection(content: string, key: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (!inSection) {
      if (new RegExp(`^${key}:`).test(line)) {
        inSection = true;
      } else {
        result.push(line);
      }
    } else {
      // End section when non-indented, non-blank line appears
      if (line !== '' && !/^\s/.test(line)) {
        inSection = false;
        result.push(line);
      }
    }
  }

  return result.join('\n');
}

/** Parse a YAML list of strings under a top-level key (e.g. imports: [...]). */
export function parseYamlStringList(content: string, key: string): string[] {
  const lines = content.split('\n');
  let inSection = false;
  const items: string[] = [];

  for (const line of lines) {
    if (!inSection) {
      if (new RegExp(`^${key}:`).test(line)) {
        // Inline list: imports: [a, b]
        const inline = line.match(/\[([^\]]+)\]/);
        if (inline) {
          return inline[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
        }
        inSection = true;
      }
    } else {
      const item = line.match(/^\s+-\s+(.+)/);
      if (item) {
        items.push(item[1].trim().replace(/['"]/g, ''));
      } else if (line !== '' && !/^\s/.test(line)) {
        break;
      }
    }
  }

  return items;
}

/** Parse module names from a YAML modules: array (looks for `name:` keys). */
export function parseYamlModuleNames(content: string): string[] {
  const lines = content.split('\n');
  let inModules = false;
  const names: string[] = [];

  for (const line of lines) {
    if (!inModules) {
      if (/^modules:/.test(line)) {
        inModules = true;
      }
    } else {
      if (line !== '' && !/^\s/.test(line)) {
        break; // Left modules section
      }
      // Match both "  - name: web" (list item) and "    name: web" (property)
      const m = line.match(/^\s+(?:-\s+)?name:\s+(\S+)/);
      if (m) {
        names.push(m[1].replace(/['"]/g, ''));
      }
    }
  }

  return names;
}

/** Parse keys of a YAML mapping section (e.g. pipelines: { key1: ..., key2: ... }). */
export function parseYamlMappingKeys(content: string, section: string): string[] {
  const lines = content.split('\n');
  let inSection = false;
  const keys: string[] = [];

  for (const line of lines) {
    if (!inSection) {
      if (new RegExp(`^${section}:`).test(line)) {
        inSection = true;
      }
    } else {
      if (line !== '' && !/^\s/.test(line)) {
        break;
      }
      // Two-space indented keys (direct children of the section)
      const m = line.match(/^  (\S[^:]+):/);
      if (m) {
        keys.push(m[1].trim());
      }
    }
  }

  return keys;
}

// Preamble keys that live at the top level of a workflow config and may be
// stripped by the visual editor's serialiser.
const PREAMBLE_KEYS = ['name', 'version'];

/**
 * Extract top-level name/version lines from YAML content so they can be
 * re-injected after the webview round-trip.
 */
export function extractYamlPreamble(yaml: string): string {
  const lines: string[] = [];
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m && PREAMBLE_KEYS.includes(m[1])) {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * Merge preamble lines back into YAML that may have lost them.
 * If the YAML already contains a preamble key, it is left unchanged.
 */
export function mergeYamlPreamble(preamble: string, yaml: string): string {
  if (!preamble) return yaml;
  const toInject: string[] = [];
  for (const line of preamble.split('\n')) {
    const m = line.match(/^(\w+):/);
    if (m && !new RegExp(`^${m[1]}:`, 'm').test(yaml)) {
      toInject.push(line);
    }
  }
  if (toInject.length === 0) return yaml;
  return toInject.join('\n') + '\n' + yaml;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
