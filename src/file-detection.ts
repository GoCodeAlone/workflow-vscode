import * as vscode from 'vscode';

export type WorkflowFileType = 'config' | 'partial' | 'test' | 'feature';

export function detectWorkflowFileType(document: vscode.TextDocument): WorkflowFileType | null {
  const text = document.getText();
  const filePath = document.fileName;

  // Full config (existing behavior)
  if (text.includes('modules:') && text.includes('workflows:')) return 'config';

  // Test file (check before partial — test files may contain pipelines:)
  if (filePath.match(/_test\.ya?ml$/) && (text.includes('tests:') || text.includes('config:'))) return 'test';

  // Partial config
  if (text.includes('pipelines:') || text.includes('modules:') ||
      text.includes('workflows:') || text.includes('imports:')) return 'partial';

  // Feature file
  if (filePath.endsWith('.feature')) return 'feature';

  return null;
}

export function isTestFile(document: vscode.TextDocument): boolean {
  return detectWorkflowFileType(document) === 'test';
}

export function isFeatureFile(document: vscode.TextDocument): boolean {
  return detectWorkflowFileType(document) === 'feature';
}
