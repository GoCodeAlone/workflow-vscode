'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const workflowPath = process.env.RELEASE_WORKFLOW_PATH ||
  path.resolve(__dirname, '../workflows/release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const release = releaseJob(workflow);
assert.ok(release.startsWith('\n  release:\n'), 'release job must exist');
const owned = [];
let cleaned = 0;

// Extract only this repository's literal step format, not arbitrary YAML.
// actionlint/GitHub validate YAML; fail closed if these steps change shape.
function releaseJob(text) {
  const lines = text.split('\n');
  const matches = lines.flatMap((line, i) => line === '  release:' ? [i] : []);
  assert.equal(matches.length, 1, 'one literal release job');
  const start = matches[0];
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && !line.startsWith('    ')) break;
    end++;
  }
  return '\n' + lines.slice(start, end).join('\n');
}

function step(name, job = release) {
  const lines = job.split('\n');
  const marker = '      - name: ' + name;
  const matches = lines.flatMap((line, i) => line === marker ? [i] : []);
  assert.equal(matches.length, 1, 'one step named ' + name);
  const start = matches[0];
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('      - ')) end++;
  return lines.slice(start, end).join('\n');
}

function script(block) {
  const lines = block.split('\n');
  const start = lines.findIndex(line => line.startsWith('        run: '));
  assert.ok(start >= 0, 'step must have a run command');
  const value = lines[start].slice('        run: '.length);
  if (value !== '|') {
    assert.ok(value && !['>', '|-', '>-'].includes(value), 'supported literal run format');
    return value;
  }
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) { body.push(''); continue; }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  assert.ok(body.some(line => line.trim()), 'run block must not be empty');
  const result = body.join('\n');
  assert.ok(!result.includes('$' + '{{'), 'bind Actions expressions through env');
  return result;
}

function execute(command, env = {}, initialSummary = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-release-status-'));
  owned.push(root);
  const calls = path.join(root, 'calls');
  const summary = path.join(root, 'summary');
  try {
    fs.writeFileSync(summary, initialSummary);
    fs.writeFileSync(path.join(root, 'npm'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS_FILE"\nprintf "%s\\n" "fixture publisher result" >&2\nexit "$FAKE_NPM_EXIT"\n',
      { mode: 0o700 });
    const child = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], {
      cwd: root,
      env: {
        PATH: root, CALLS_FILE: calls, FAKE_NPM_EXIT: '0',
        GITHUB_STEP_SUMMARY: summary, ...env,
      },
      encoding: 'utf8', timeout: 3000, maxBuffer: 16384,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, 'fixture must exit normally');
    return {
      status: child.status, stdout: child.stdout, stderr: child.stderr,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
      summary: fs.readFileSync(summary, 'utf8'),
    };
  } finally {
    fs.rmSync(root, { recursive: true });
    assert.equal(fs.existsSync(root), false, 'owned fixture removed');
    cleaned++;
  }
}

test('publication failures cannot be ignored by step or job configuration', () => {
  for (const match of release.matchAll(/^\s*continue-on-error:\s*(.*)$/gm)) {
    assert.equal(match[1].trim(), 'false', 'publication failure must fail the job');
  }
});

test('later jobs cannot supply a missing release publication step', () => {
  const name = 'Publish to VS Code Marketplace';
  for (const key of ['unrelated:', "'unrelated':", 'unrelated: &anchor']) {
    const fixture = workflow.replace('      - name: ' + name, '      - name: Removed publication') +
      '\n  ' + key + '\n    steps:\n      - name: ' + name + '\n        run: echo fixture\n';
    assert.throws(() => step(name, releaseJob(fixture)), /one step named/);
  }
});

test('publication remains tag-gated and ordered after the GitHub release', () => {
  assert.match(release, /^    needs: build$/m);
  assert.match(release, /^    if: startsWith\(github.ref, 'refs\/tags\/v'\)$/m);
  assert.ok(release.indexOf('      - name: Create GitHub Release') <
    release.indexOf('      - name: Publish to VS Code Marketplace'));
  assert.doesNotMatch(step('Publish to VS Code Marketplace'), /^        if:/m,
    'Marketplace must retain the default success condition');
  assert.match(step('Create GitHub Release'), /^        id: github_release$/m);
  assert.match(step('Publish to VS Code Marketplace'), /^        id: marketplace$/m);
  assert.match(step('Publish to VS Code Marketplace'),
    /^          VSCE_PAT: \$\{\{ secrets\.VSCE_PAT \}\}$/m,
    'publisher must receive only the existing configured secret binding');
});

for (const token of [undefined, '']) {
  test('missing ' + (token === undefined ? 'unset' : 'empty') + ' token stops before npm', () => {
    const env = token === undefined ? {} : { VSCE_PAT: token };
    const result = execute(script(step('Publish to VS Code Marketplace')), env);
    assert.equal(result.status, 1, 'missing token must fail publication');
    assert.equal(result.calls, '', 'must not launch npm or a credential prompt');
    assert.match(result.stdout + result.stderr, /VSCE_PAT.*unavailable/);
  });
}

test('publisher error and exact exit status survive without leaking the token', () => {
  const token = 'inert-release-test-value';
  const result = execute(script(step('Publish to VS Code Marketplace')),
    { VSCE_PAT: token, FAKE_NPM_EXIT: '37' });
  assert.equal(result.status, 37);
  assert.equal(result.calls, 'run publish\n');
  assert.match(result.stderr, /fixture publisher result/);
  assert.ok(!(result.stdout + result.stderr).includes(token));
});

test('successful publisher runs once and returns success', () => {
  const result = execute(script(step('Publish to VS Code Marketplace')),
    { VSCE_PAT: 'inert-release-test-value' });
  assert.equal(result.status, 0);
  assert.equal(result.calls, 'run publish\n');
});

test('summary always uses the original outcomes, never suppressed conclusions or secrets', () => {
  const block = step('Report publication outcomes');
  assert.match(block, /^        if: \$\{\{ always\(\) \}\}$/m);
  assert.match(block, /GITHUB_RELEASE_OUTCOME: \$\{\{ steps\.github_release\.outcome \}\}/);
  assert.match(block, /MARKETPLACE_OUTCOME: \$\{\{ steps\.marketplace\.outcome \}\}/);
  assert.doesNotMatch(block, /secrets\.|\.conclusion/);
});

const cases = [
  ['success', 'success', /GitHub release action completed successfully/, /public Marketplace indexing is not independently verified/],
  ['success', 'failure', /GitHub release action completed successfully/, /Marketplace publication is not confirmed/],
  ['failure', 'skipped', /Partial GitHub release or assets may exist/, /Marketplace publication was not attempted/],
  ['skipped', 'skipped', /GitHub release action was not attempted/, /Marketplace publication was not attempted/],
  ['cancelled', 'cancelled', /Partial GitHub release or assets may exist/, /Marketplace publication is not confirmed/],
  ['', '', /GitHub release outcome was not recorded/, /Marketplace outcome was not recorded/],
];
for (const [github, marketplace, githubMessage, marketplaceMessage] of cases) {
  test('summary distinguishes ' + (github || 'missing') + '/' + (marketplace || 'missing'), () => {
    const result = execute(script(step('Report publication outcomes')), {
      GITHUB_RELEASE_OUTCOME: github, MARKETPLACE_OUTCOME: marketplace,
    }, 'Earlier summary\n');
    assert.equal(result.status, 0);
    assert.equal(result.calls, '', 'summary must not invoke publication');
    assert.ok(result.summary.startsWith('Earlier summary\n'));
    assert.match(result.summary, githubMessage);
    assert.match(result.summary, marketplaceMessage);
    assert.ok(result.summary.includes('| GitHub release | ' + (github || 'not recorded') + ' |'));
    assert.ok(result.summary.includes('| Marketplace | ' + (marketplace || 'not recorded') + ' |'));
    if (github !== 'success') assert.doesNotMatch(result.summary, /GitHub release action completed successfully/);
    if (marketplace !== 'success') assert.doesNotMatch(result.summary, /Marketplace publish command succeeded/);
  });
}

after(() => {
  assert.equal(cleaned, owned.length);
  assert.ok(owned.every(root => !fs.existsSync(root)), 'all owned fixtures are absent');
});
