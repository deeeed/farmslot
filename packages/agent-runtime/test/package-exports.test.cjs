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
assert.ok(packageJson.exports['./scripts/mark-checklist-step.cjs']);
assert.ok(packageJson.exports['./scripts/checklist-target.cjs']);
assert.ok(packageJson.exports['./scripts/worker-terminal-contract.cjs']);
assert.ok(packageJson.exports['./scripts/check-task-artifact-contract.mjs']);
assert.ok(packageJson.exports['./scripts/execution-template-cli.mjs']);

const cli = path.join(packageRoot, 'bin', 'farmslot-agent.mjs');
let result = spawnSync(process.execPath, [cli, 'contract', 'resolve', '--flow', 'fix-bug'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).commands.complete.report, 'artifacts/pr-description.md');

const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-agent-install-mark-'));
writeFileSync(path.join(dir, 'TASK.md'), '- [ ] Check\n');
result = spawnSync(process.execPath, [cli, 'install-mark', dir], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.ok(fs.existsSync(path.join(dir, 'mark')));

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
