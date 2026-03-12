import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const REGISTRY_BASE = 'https://raw.githubusercontent.com/GoCodeAlone/workflow-registry/main/plugins';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PluginSchemaData {
  name: string;
  stepTypes?: unknown[];
  moduleTypes?: unknown[];
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function parseGoModPlugins(goModContent: string): string[] {
  const plugins: string[] = [];
  const lines = goModContent.split('\n');
  for (const line of lines) {
    const match = line.match(/github\.com\/GoCodeAlone\/(workflow-plugin-\S+)/);
    if (match) plugins.push(match[1]);
  }
  return plugins;
}

export async function discoverPluginSchemas(
  workspaceRoot: string,
  globalStorageUri: vscode.Uri
): Promise<PluginSchemaData[]> {
  const goModPath = path.join(workspaceRoot, 'go.mod');
  if (!fs.existsSync(goModPath)) return [];

  const goMod = fs.readFileSync(goModPath, 'utf-8');
  const pluginNames = parseGoModPlugins(goMod);
  if (pluginNames.length === 0) return [];

  const cacheDir = path.join(globalStorageUri.fsPath, 'plugin-manifests');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const results: PluginSchemaData[] = [];
  for (const name of pluginNames) {
    const cacheFile = path.join(cacheDir, `${name}.json`);
    let manifest: PluginSchemaData | null = null;

    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        try {
          manifest = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as PluginSchemaData;
        } catch { /* ignore corrupt cache */ }
      }
    }

    if (!manifest) {
      try {
        manifest = await fetchJson(`${REGISTRY_BASE}/${name}/manifest.json`) as PluginSchemaData;
        fs.writeFileSync(cacheFile, JSON.stringify(manifest));
      } catch {
        continue; // Skip plugins that can't be fetched
      }
    }

    results.push(manifest);
  }
  return results;
}
