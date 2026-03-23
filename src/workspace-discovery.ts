import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkflowFileType, detectWorkflowFileType } from './file-detection';

export interface WorkflowFileInfo {
  path: string;
  type: WorkflowFileType;
}

export interface WorkflowWorkspace {
  rootConfig: string;
  files: Map<string, WorkflowFileInfo>;
  testFiles: string[];
  featureFiles: string[];
}

interface WorkflowJsonOverride {
  configRoot?: string;
  testDirs?: string[];
  configDirs?: string[];
}

function readWorkflowJson(dir: string): WorkflowJsonOverride | null {
  const overridePath = path.join(dir, '.workflow.json');
  try {
    const content = fs.readFileSync(overridePath, 'utf-8');
    return JSON.parse(content) as WorkflowJsonOverride;
  } catch {
    return null;
  }
}

function isRootConfig(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.includes('modules:') && content.includes('workflows:');
  } catch {
    return false;
  }
}

const ROOT_YAML_NAMES = ['app.yaml', 'app.yml', 'workflow.yaml', 'workflow.yml', 'config.yaml', 'config.yml'];

/**
 * Walk up directories from fromPath to find the workflow config root.
 * Priority:
 * 1. .workflow.json configRoot override in any parent directory
 * 2. IDE setting workflow.configRoot
 * 3. Known root filenames (app.yaml, workflow.yaml, config.yaml)
 * 4. Any YAML with modules: + workflows:
 */
export async function discoverConfigRoot(fromPath: string): Promise<string | null> {
  // Check IDE setting first
  const configRootSetting = vscode.workspace.getConfiguration('workflow').get<string>('configRoot', '');
  if (configRootSetting) {
    // Resolve relative to workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resolved = workspaceRoot ? path.resolve(workspaceRoot, configRootSetting) : configRootSetting;
    if (fs.existsSync(resolved)) return resolved;
  }

  const startDir = fs.statSync(fromPath).isDirectory() ? fromPath : path.dirname(fromPath);
  let dir = startDir;
  const root = path.parse(dir).root;

  while (dir !== root) {
    // Check .workflow.json override
    const override = readWorkflowJson(dir);
    if (override?.configRoot) {
      const resolved = path.resolve(dir, override.configRoot);
      if (fs.existsSync(resolved)) return resolved;
    }

    // Check known root filenames
    for (const name of ROOT_YAML_NAMES) {
      const candidate = path.join(dir, name);
      if (isRootConfig(candidate)) return candidate;
    }

    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Scan a directory for all workflow-related files.
 */
export async function scanWorkspace(rootDir: string): Promise<WorkflowWorkspace> {
  const files = new Map<string, WorkflowFileInfo>();
  const testFiles: string[] = [];
  const featureFiles: string[] = [];
  let rootConfig = '';

  const override = readWorkflowJson(rootDir);
  const configDirs = override?.configDirs ?? ['.'];
  const testDirs = override?.testDirs ?? ['.'];

  function walkDir(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        if (/\.ya?ml$/.test(entry.name) || entry.name.endsWith('.feature')) {
          try {
            const uri = vscode.Uri.file(fullPath);
            // Use a lightweight check without opening the document
            const content = fs.readFileSync(fullPath, 'utf-8');
            let type: WorkflowFileType | null = null;
            if (content.includes('modules:') && content.includes('workflows:')) {
              type = 'config';
              if (!rootConfig) rootConfig = fullPath;
            } else if (entry.name.match(/_test\.ya?ml$/) && (content.includes('tests:') || content.includes('config:'))) {
              type = 'test';
              testFiles.push(fullPath);
            } else if (content.includes('pipelines:') || content.includes('modules:') ||
                       content.includes('workflows:') || content.includes('imports:')) {
              type = 'partial';
            } else if (entry.name.endsWith('.feature')) {
              type = 'feature';
              featureFiles.push(fullPath);
            }
            if (type) {
              files.set(fullPath, { path: fullPath, type });
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  }

  walkDir(rootDir);

  return { rootConfig, files, testFiles, featureFiles };
}
