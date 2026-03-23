import * as vscode from 'vscode';

export interface TestCaseResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  error?: string;
  line?: number;
}

// wfctl test output patterns:
//   PASS: test name
//   FAIL: test name
//   FAIL: test name — error detail
//   --- PASS: TestName (0.00s)
//   --- FAIL: TestName (0.00s)
const PASS_RE = /^(?:---\s+)?PASS[:\s]\s*(.+?)(?:\s+\([\d.]+s\))?\s*$/;
const FAIL_RE = /^(?:---\s+)?FAIL[:\s]\s*(.+?)(?:\s+\([\d.]+s\))?(?:[:\s—-]+(.+))?\s*$/;
const SKIP_RE = /^(?:---\s+)?SKIP[:\s]\s*(.+?)(?:\s+\([\d.]+s\))?\s*$/;

export function parseTestOutput(output: string): TestCaseResult[] {
  const results: TestCaseResult[] = [];

  for (const raw of output.split('\n')) {
    const line = raw.trim();

    const passMatch = line.match(PASS_RE);
    if (passMatch) {
      results.push({ name: passMatch[1].trim(), status: 'pass' });
      continue;
    }

    const failMatch = line.match(FAIL_RE);
    if (failMatch) {
      results.push({
        name: failMatch[1].trim(),
        status: 'fail',
        error: failMatch[2]?.trim(),
      });
      continue;
    }

    const skipMatch = line.match(SKIP_RE);
    if (skipMatch) {
      results.push({ name: skipMatch[1].trim(), status: 'skip' });
    }
  }

  return results;
}

export function mapResultsToLines(
  document: vscode.TextDocument,
  results: TestCaseResult[]
): Map<number, TestCaseResult> {
  const lineMap = new Map<number, TestCaseResult>();
  const docText = document.getText();
  const docLines = docText.split('\n');

  for (const result of results) {
    const escaped = result.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match "name: <test name>" with optional quotes
    const re = new RegExp(`^\\s*-?\\s*name:\\s*["']?${escaped}["']?\\s*$`);
    for (let i = 0; i < docLines.length; i++) {
      if (re.test(docLines[i])) {
        lineMap.set(i, result);
        break;
      }
    }
  }

  return lineMap;
}

let passDecorationType: vscode.TextEditorDecorationType | undefined;
let failDecorationType: vscode.TextEditorDecorationType | undefined;

export function ensureDecorationTypes(
  context: vscode.ExtensionContext
): { pass: vscode.TextEditorDecorationType; fail: vscode.TextEditorDecorationType } {
  if (!passDecorationType) {
    passDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'pass.svg'),
      gutterIconSize: 'contain',
    });
    context.subscriptions.push(passDecorationType);
  }
  if (!failDecorationType) {
    failDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'fail.svg'),
      gutterIconSize: 'contain',
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    });
    context.subscriptions.push(failDecorationType);
  }
  return { pass: passDecorationType, fail: failDecorationType };
}

export function applyTestDecorations(
  editor: vscode.TextEditor,
  results: TestCaseResult[],
  context: vscode.ExtensionContext
): void {
  const { pass, fail } = ensureDecorationTypes(context);
  const lineMap = mapResultsToLines(editor.document, results);

  const passRanges: vscode.DecorationOptions[] = [];
  const failRanges: vscode.DecorationOptions[] = [];

  for (const [lineNum, result] of lineMap) {
    const range = new vscode.Range(lineNum, 0, lineNum, 0);
    if (result.status === 'pass') {
      passRanges.push({ range });
    } else if (result.status === 'fail') {
      failRanges.push({
        range,
        hoverMessage: result.error ? `Test failed: ${result.error}` : 'Test failed',
      });
    }
  }

  editor.setDecorations(pass, passRanges);
  editor.setDecorations(fail, failRanges);
}
