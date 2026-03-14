import * as vscode from 'vscode';

const REGISTRY_URL = 'https://gocodealone.github.io/workflow-registry/v1';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface RegistryPlugin {
  name: string;
  description: string;
  version: string;
  tier: string;
  type: string;
  keywords: string[];
  private: boolean;
  repository: string;
  capabilities: {
    stepTypes: string[];
    moduleTypes: string[];
    triggerTypes: string[];
  };
}

export class MarketplaceProvider implements vscode.TreeDataProvider<MarketplaceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MarketplaceItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: RegistryPlugin[] | null = null;
  private cacheTime = 0;

  refresh(): void {
    this.cache = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(): Promise<MarketplaceItem[]> {
    const plugins = await this.fetchIndex();
    return plugins
      .filter(p => !p.private)
      .map(p => new MarketplaceItem(p));
  }

  getTreeItem(element: MarketplaceItem): vscode.TreeItem {
    return element;
  }

  private async fetchIndex(): Promise<RegistryPlugin[]> {
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      const resp = await fetch(`${REGISTRY_URL}/index.json`);
      if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
      this.cache = (await resp.json()) as RegistryPlugin[];
      this.cacheTime = Date.now();
      return this.cache;
    } catch (e) {
      vscode.window.showWarningMessage(`Failed to fetch plugin registry: ${e}`);
      return [];
    }
  }
}

export class MarketplaceItem extends vscode.TreeItem {
  constructor(public readonly plugin: RegistryPlugin) {
    super(plugin.name, vscode.TreeItemCollapsibleState.None);
    this.description = `v${plugin.version} · ${plugin.tier}`;
    this.tooltip = new vscode.MarkdownString(
      `**${plugin.name}** v${plugin.version}\n\n${plugin.description}\n\n` +
      `Steps: ${plugin.capabilities?.stepTypes?.length || 0} · ` +
      `Modules: ${plugin.capabilities?.moduleTypes?.length || 0}`
    );
    this.contextValue = 'pluginMarketplaceItem';
    this.iconPath = new vscode.ThemeIcon(
      plugin.tier === 'core' ? 'verified' : 'extensions'
    );
  }
}
