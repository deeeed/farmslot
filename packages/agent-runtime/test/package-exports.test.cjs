#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

assert.equal(packageJson.name, '@farmslot/agent-runtime');
assert.ok(packageJson.bin['farmslot-agent']);
assert.ok(packageJson.exports['./native']);
for (const entry of ['native/client.js', 'native/host.js', 'native/supervisor.js']) {
  assert.ok(
    fs.existsSync(path.join(packageRoot, 'dist', entry)),
    `Missing packaged native entry: ${entry}`,
  );
}
assert.ok(packageJson.exports['./scripts/mark-checklist-step.cjs']);
assert.ok(packageJson.exports['./scripts/checklist-target.cjs']);
// The mark engine's shared IO and the child-unit engine are published entry
// points: a consumer (harness, gateway) must be able to require them, and the
// declared subpath must resolve to a file that actually loads.
for (const subpath of [
  './scripts/mark-io.cjs',
  './scripts/subtask-unit.cjs',
  './scripts/acceptance-ledger.cjs',
  './scripts/acceptance-cli.cjs',
]) {
  assert.ok(packageJson.exports[subpath], `missing package export ${subpath}`);
  const target = path.join(packageRoot, packageJson.exports[subpath]);
  assert.ok(fs.existsSync(target), `package export ${subpath} points at a missing file`);
  assert.doesNotThrow(() => require(target), `package export ${subpath} must load`);
}
assert.ok(
  typeof require(path.join(packageRoot, 'scripts', 'subtask-unit.cjs')).runSubtaskCommand ===
    'function',
  'subtask-unit.cjs must export runSubtaskCommand',
);
assert.ok(
  typeof require(path.join(packageRoot, 'scripts', 'mark-io.cjs')).writeSignal === 'function',
  'mark-io.cjs must export writeSignal',
);
assert.ok(packageJson.exports['./scripts/worker-terminal-contract.cjs']);
assert.ok(packageJson.exports['./scripts/check-task-artifact-contract.mjs']);
assert.ok(packageJson.exports['./scripts/execution-template-cli.mjs']);

const cli = path.join(packageRoot, 'bin', 'farmslot-agent.mjs');
let result = spawnSync(process.execPath, [cli, 'contract', 'resolve', '--flow', 'fix-bug'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).commands.complete.report, 'artifacts/pr-description.md');

assert.ok(packageJson.exports['./scripts/task-init-cli.mjs']);
result = spawnSync(process.execPath, [cli, 'task', 'init', '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /task init <task-dir>/);

// `ac` is reachable through the published bin, the way a worker invokes it.
result = spawnSync(process.execPath, [cli, 'ac', '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /ac set <AC-N>/);

const templateRoot = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-template-'));
mkdirSync(path.join(templateRoot, 'dev'));
writeFileSync(path.join(templateRoot, 'dev', 'autonomous.extension.md'), '# Team dev\n');
const templateCli = path.join(packageRoot, 'scripts', 'execution-template-cli.mjs');
result = spawnSync(
  process.execPath,
  [
    templateCli,
    'list',
    '--domain-dir',
    `trading=${templateRoot}`,
    '--domain',
    'trading',
    '--flow',
    'dev',
    '--platform',
    'extension',
    '--run-mode',
    'autonomous',
    '--json',
  ],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).templates[0].sourceId, 'team:trading');

process.stdout.write('agent-runtime package exports tests: ok\n');
