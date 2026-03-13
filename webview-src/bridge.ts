// VS Code webview ↔ editor bridge
// vscode API is available via acquireVsCodeApi()

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
};

const vscode = acquireVsCodeApi();

export interface BridgeCallbacks {
  onYamlChanged: (content: string) => void;
  onCursorMoved: (line: number, col: number) => void;
  onSchemasLoaded: (schemas: unknown) => void;
  onPluginSchemasLoaded?: (plugins: unknown[]) => void;
  onAIResponse?: (content: string) => void;
}

let callbacks: BridgeCallbacks | null = null;

// Pending resolveFile requests keyed by request ID
const pendingResolveFile = new Map<string, { resolve: (content: string | null) => void }>();
let resolveFileCounter = 0;

export function initBridge(cb: BridgeCallbacks) {
  callbacks = cb;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'yamlChanged':
        callbacks?.onYamlChanged(msg.content);
        break;
      case 'cursorMoved':
        callbacks?.onCursorMoved(msg.line, msg.col);
        break;
      case 'schemasLoaded':
        callbacks?.onSchemasLoaded(msg.schemas);
        break;
      case 'pluginSchemasLoaded':
        callbacks?.onPluginSchemasLoaded?.(msg.plugins ?? []);
        break;
      case 'aiResponse':
        callbacks?.onAIResponse?.(msg.content);
        break;
      case 'resolveFileResponse': {
        const pending = pendingResolveFile.get(msg.requestId);
        if (pending) {
          pendingResolveFile.delete(msg.requestId);
          pending.resolve(msg.content ?? null);
        }
        break;
      }
    }
  });

  // Tell host we're ready
  vscode.postMessage({ type: 'ready' });
}

export function sendYamlUpdated(content: string) {
  vscode.postMessage({ type: 'yamlUpdated', content });
}

export function sendNavigateToLine(line: number, col: number) {
  vscode.postMessage({ type: 'navigateToLine', line, col });
}

export function sendRequestSchemas() {
  vscode.postMessage({ type: 'requestSchemas' });
}

export function sendAIRequest(yaml: string, moduleTypes: string[], userPrompt: string) {
  vscode.postMessage({ type: 'aiRequest', yaml, moduleTypes, userPrompt });
}

/** Request the host to read a file relative to the open document. Returns file content or null. */
export function sendResolveFile(relativePath: string): Promise<string | null> {
  const requestId = `rf-${++resolveFileCounter}`;
  return new Promise((resolve) => {
    pendingResolveFile.set(requestId, { resolve });
    vscode.postMessage({ type: 'resolveFile', requestId, relativePath });
    // Timeout after 5 seconds
    setTimeout(() => {
      if (pendingResolveFile.has(requestId)) {
        pendingResolveFile.delete(requestId);
        resolve(null);
      }
    }, 5000);
  });
}

/** Send multi-file save to host. fileMap keys are relative paths (null = main file). */
export function sendSaveFiles(fileMap: Map<string | null, string>) {
  const entries: Array<{ path: string | null; content: string }> = [];
  for (const [path, content] of fileMap.entries()) {
    entries.push({ path, content });
  }
  vscode.postMessage({ type: 'saveFiles', entries });
}
