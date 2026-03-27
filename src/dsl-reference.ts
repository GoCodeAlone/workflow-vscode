import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface FieldDoc {
  name: string;
  type: string;
  description: string;
}

interface DSLSection {
  id: string;
  title: string;
  description: string;
  requiredFields: FieldDoc[];
  optionalFields: FieldDoc[];
  example: string;
  relationships: string[];
  parent?: string;
}

export class DslReferenceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'workflowDslReference';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const sections = this.loadSections();
    const sectionsHtml = sections.map((s) => this.renderSection(s)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
      margin: 0;
    }
    h1 { font-size: 1.1em; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
    details { margin-bottom: 8px; }
    summary {
      cursor: pointer;
      font-weight: 600;
      padding: 4px 6px;
      border-radius: 3px;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    summary:hover { background: var(--vscode-list-hoverBackground); }
    summary::before { content: '▶'; font-size: 0.7em; transition: transform 0.15s; }
    details[open] > summary::before { transform: rotate(90deg); }
    .section-body { padding: 6px 6px 6px 16px; }
    .description { margin-bottom: 8px; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 8px; }
    th { text-align: left; padding: 3px 6px; background: var(--vscode-editor-inactiveSelectionBackground); font-size: 0.85em; }
    td { padding: 3px 6px; border-top: 1px solid var(--vscode-panel-border); vertical-align: top; }
    .field-name { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
    .field-type { font-family: var(--vscode-editor-font-family); color: var(--vscode-symbolIcon-typeParameterForeground); font-size: 0.85em; }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 3px;
      overflow-x: auto;
      font-size: 0.85em;
      margin: 0 0 8px;
    }
    .section-label { font-size: 0.75em; font-weight: normal; color: var(--vscode-descriptionForeground); margin-left: 4px; }
    ul { margin: 4px 0; padding-left: 18px; }
    li { margin-bottom: 3px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  </style>
</head>
<body>
  <h1>Workflow DSL Reference</h1>
  ${sections.length === 0 ? '<p class="empty">No reference available.</p>' : sectionsHtml}
</body>
</html>`;
  }

  private renderSection(s: DSLSection): string {
    const requiredTable = s.requiredFields.length > 0
      ? `<table><tr><th>Field</th><th>Type</th><th>Description</th></tr>${s.requiredFields.map((f) =>
          `<tr><td class="field-name">${esc(f.name)}</td><td class="field-type">${esc(f.type)}</td><td>${esc(f.description)}</td></tr>`
        ).join('')}</table>`
      : '';

    const optionalTable = s.optionalFields.length > 0
      ? `<table><tr><th>Field (optional)</th><th>Type</th><th>Description</th></tr>${s.optionalFields.map((f) =>
          `<tr><td class="field-name">${esc(f.name)}</td><td class="field-type">${esc(f.type)}</td><td>${esc(f.description)}</td></tr>`
        ).join('')}</table>`
      : '';

    const exampleBlock = s.example
      ? `<pre>${esc(s.example)}</pre>`
      : '';

    const relsList = s.relationships.length > 0
      ? `<ul>${s.relationships.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
      : '';

    return `<details>
  <summary>${esc(s.title)}</summary>
  <div class="section-body">
    <p class="description">${esc(s.description)}</p>
    ${requiredTable}
    ${optionalTable}
    ${exampleBlock}
    ${relsList}
  </div>
</details>`;
  }

  private loadSections(): DSLSection[] {
    try {
      const jsonPath = path.join(this.context.extensionPath, 'schemas', 'dsl-reference.json');
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data.sections) ? data.sections : [];
    } catch {
      return [];
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
