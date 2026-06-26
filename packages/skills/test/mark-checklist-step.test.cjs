const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-'));
const task = path.join(dir, 'CHECKLIST.md');
const signal = path.join(dir, 'SIGNAL.json');

writeFileSync(
  task,
  ['# Checklist', '', '- [ ] First gate', '- [ ] **Second gate** — validate'].join('\n'),
);

let result = spawnSync(process.execPath, [helper, task, signal, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(task, 'utf8'), /- \[x\] First gate/);
let parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.checklistTiming.events.length, 1);
assert.equal(parsed.checklistTiming.events[0].stepNumber, 1);
assert.equal(parsed.checklistTiming.events[0].label, 'First gate');

result = spawnSync(
  process.execPath,
  [helper, task, signal, '2', '--status', 'complete', '--outcome', 'success'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'complete');
assert.equal(parsed.outcome, 'success');
assert.equal(parsed.checklistTiming.events.length, 2);
assert.equal(parsed.checklistTiming.events[1].stepNumber, 2);
assert.equal(parsed.checklistTiming.events[1].label, 'Second gate validate');

result = spawnSync(process.execPath, [helper, task, signal, '1', '--status', 'complet'], {
  encoding: 'utf8',
});
assert.equal(result.status, 2);

const poisonDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-poison-'));
const poisonTask = path.join(poisonDir, 'TASK.md');
const poisonSignal = path.join(poisonDir, 'SIGNAL.json');
writeFileSync(poisonTask, ['- [ ] Gate step'].join('\n'));
writeFileSync(
  poisonSignal,
  JSON.stringify({
    status: 'working',
    outcome: 'in_progress',
    step: 'stale',
    timestamp: '2026-06-26T19:00:00.000Z',
  }),
);
result = spawnSync(process.execPath, [helper, poisonTask, poisonSignal, '1'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(poisonSignal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.outcome, undefined);
assert.equal(parsed.checklistTiming.events.length, 1);

const completeDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-complete-'));
const completeTask = path.join(completeDir, 'CHECKLIST.md');
const completeSignal = path.join(completeDir, 'SIGNAL.json');
writeFileSync(completeTask, ['- [ ] Step A', '- [ ] Step B'].join('\n'));
result = spawnSync(process.execPath, [helper, completeTask, completeSignal, '1'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
result = spawnSync(
  process.execPath,
  [helper, completeTask, completeSignal, 'complete', '--outcome', 'success'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(completeSignal, 'utf8'));
assert.equal(parsed.status, 'complete');
assert.equal(parsed.outcome, 'success');
assert.equal(parsed.checklistTiming.events.length, 1);

const echoRiskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-echo-risk-'));
const echoTask = path.join(echoRiskDir, 'CHECKLIST.md');
const echoSignal = path.join(echoRiskDir, 'SIGNAL.json');
writeFileSync(echoTask, '- [ ] Only step');
spawnSync(process.execPath, [helper, echoTask, echoSignal, '1'], { encoding: 'utf8' });
result = spawnSync(
  process.execPath,
  [helper, echoTask, echoSignal, 'complete', '--outcome', 'success', '--mark-last'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(echoSignal, 'utf8'));
assert.equal(parsed.checklistTiming.events.length, 1);
assert.match(readFileSync(echoTask, 'utf8'), /- \[x\] Only step/);

const startDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-start-'));
const startTask = path.join(startDir, 'TASK.md');
const startSignal = path.join(startDir, 'SIGNAL.json');
writeFileSync(startTask, '- [ ] **1. Update Status** — begin work');
result = spawnSync(process.execPath, [helper, startTask, startSignal, 'start'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(startTask, 'utf8'), /- \[ \] \*\*1\. Update Status\*\*/);
parsed = JSON.parse(readFileSync(startSignal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.step, 'started');
assert.equal(parsed.checklistTiming.events.length, 0);
assert.match(result.stdout, /signal started/);

result = spawnSync(process.execPath, [helper, startTask, startSignal, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(startSignal, 'utf8'));
assert.equal(parsed.checklistTiming.events.length, 1);

result = spawnSync(process.execPath, [helper, task, signal, '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0);
assert.match(result.stdout, /Terminal: \.\/mark complete/);
assert.match(result.stdout, /Bootstrap: \.\/mark start/);
