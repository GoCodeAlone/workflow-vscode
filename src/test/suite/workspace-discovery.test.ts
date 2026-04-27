import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverConfigRoot } from '../../workspace-discovery.js';

suite('Workspace Discovery', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-discovery-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function assertDiscoversRootFile(fileName: string): Promise<void> {
    const rootPath = path.join(tmpDir, fileName);
    const childDir = path.join(tmpDir, 'services', 'api');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(rootPath, [
      'modules:',
      '  - name: web',
      '    type: http.server',
      'workflows:',
      '  default:',
      '    routes: []',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(childDir, 'partial.yaml'), 'pipelines:\n  build:\n    steps: []\n');

    const discovered = await discoverConfigRoot(path.join(childDir, 'partial.yaml'));

    assert.strictEqual(discovered, rootPath, `Expected ${fileName} to be discovered as the config root`);
  }

  for (const fileName of [
    'app.yaml',
    'app.yml',
    'workflow.yaml',
    'workflow.yml',
    'wfctl.yaml',
    'wfctl.yml',
    'infra.yaml',
    'infra.yml',
  ]) {
    test(`discoverConfigRoot recognizes ${fileName}`, async () => {
      await assertDiscoversRootFile(fileName);
    });
  }
});
