import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowEditor } from '@gocodealone/workflow-editor';
import { useModuleSchemaStore } from '@gocodealone/workflow-editor/stores';
import { initBridge, sendYamlUpdated, sendNavigateToLine } from './bridge';
import '@xyflow/react/dist/style.css';

function App() {
  const [yaml, setYaml] = useState<string>('');
  const initializedRef = useRef(false);

  const loadSchemas = useModuleSchemaStore((s) => s.loadSchemas);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    initBridge({
      onYamlChanged: (content) => setYaml(content),
      onCursorMoved: (_line, _col) => {
        // TODO: highlight corresponding node in editor
      },
      onSchemasLoaded: (schemas) => {
        if (schemas && typeof schemas === 'object') {
          loadSchemas(schemas as Record<string, never>);
        }
      },
    });
  }, [loadSchemas]);

  return (
    <WorkflowEditor
      initialYaml={yaml}
      onChange={(newYaml) => sendYamlUpdated(newYaml)}
      onSave={async (newYaml) => sendYamlUpdated(newYaml)}
      onNavigateToSource={(line, col) => sendNavigateToLine(line, col)}
      onSchemaRequest={async () => {
        // Schemas arrive async via bridge callback; return null to skip direct loading
        return null;
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);
