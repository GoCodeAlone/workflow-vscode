import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

class PipelineCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;

      // @pipeline:name tag
      const tagMatch = line.match(/@pipeline:(\S+)/);
      if (tagMatch) {
        lenses.push(new vscode.CodeLens(
          new vscode.Range(i, 0, i, line.length),
          { title: `→ pipeline: ${tagMatch[1]}`, command: 'workflow.goToPipeline', arguments: [tagMatch[1]] }
        ));
      }

      // When I POST/GET/PUT/DELETE/PATCH "/path" — extract path as possible pipeline hint
      const httpMatch = line.match(/When I (POST|GET|PUT|DELETE|PATCH)\s+"([^"]+)"/);
      if (httpMatch) {
        const httpPath = httpMatch[2];
        lenses.push(new vscode.CodeLens(
          new vscode.Range(i, 0, i, line.length),
          { title: `→ find pipeline for ${httpMatch[1]} ${httpPath}`, command: 'workflow.goToPipelineByPath', arguments: [httpMatch[1], httpPath] }
        ));
      }
    }

    return lenses;
  }
}

async function findPipelineInWorkspace(pipelineName: string): Promise<{ file: string; line: number } | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return null;

  const yamlFiles = await vscode.workspace.findFiles('**/*.{yaml,yml}', '**/node_modules/**');

  for (const fileUri of yamlFiles) {
    try {
      const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Match pipeline definition: "  name:" under pipelines: section, or "- name: pipelineName"
        const nameMatch = lines[i].match(/^\s*-?\s*name:\s*["']?(\S+?)["']?\s*$/);
        if (nameMatch && nameMatch[1] === pipelineName) {
          // Verify we're in a pipelines: section by looking back
          for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
            if (lines[j].match(/^pipelines:/)) {
              return { file: fileUri.fsPath, line: i };
            }
            if (lines[j].match(/^[a-z]/)) break; // hit another top-level key
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return null;
}

async function findPipelineByHttpPath(method: string, httpPath: string): Promise<{ file: string; line: number } | null> {
  const yamlFiles = await vscode.workspace.findFiles('**/*.{yaml,yml}', '**/node_modules/**');

  for (const fileUri of yamlFiles) {
    try {
      const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Look for path: "/path" or method: GET patterns near each other
        if (lines[i].includes(`path: "${httpPath}"`) || lines[i].includes(`path: '${httpPath}'`) ||
            lines[i].includes(`path: ${httpPath}`)) {
          return { file: fileUri.fsPath, line: i };
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return null;
}

async function navigateToLocation(location: { file: string; line: number }) {
  const doc = await vscode.workspace.openTextDocument(location.file);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(location.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export function registerPipelineNavigation(context: vscode.ExtensionContext) {
  // Register CodeLens provider for .feature files
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { pattern: '**/*.feature' },
      new PipelineCodeLensProvider()
    )
  );

  // Register goToPipeline command
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.goToPipeline', async (pipelineName: string) => {
      const location = await findPipelineInWorkspace(pipelineName);
      if (location) {
        await navigateToLocation(location);
      } else {
        vscode.window.showWarningMessage(`Pipeline "${pipelineName}" not found in workspace YAML files.`);
      }
    })
  );

  // Register goToPipelineByPath command
  context.subscriptions.push(
    vscode.commands.registerCommand('workflow.goToPipelineByPath', async (method: string, httpPath: string) => {
      const location = await findPipelineByHttpPath(method, httpPath);
      if (location) {
        await navigateToLocation(location);
      } else {
        vscode.window.showWarningMessage(`No pipeline found for ${method} ${httpPath} in workspace YAML files.`);
      }
    })
  );
}
