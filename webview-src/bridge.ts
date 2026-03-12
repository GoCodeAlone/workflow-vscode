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
}

let callbacks: BridgeCallbacks | null = null;

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
