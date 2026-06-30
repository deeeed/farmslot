const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
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

result = spawnSync(process.execPath, [helper, task, signal, '2'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.checklistTiming.events.length, 2);

result = spawnSync(process.execPath, [helper, task, signal, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'complete');
assert.equal(parsed.outcome, 'success');
assert.equal(parsed.disposition, 'fixed');
assert.equal(parsed.checklistTiming.events.length, 2);

const noChangeDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-nochange-'));
const noChangeTask = path.join(noChangeDir, 'TASK.md');
const noChangeSignal = path.join(noChangeDir, 'SIGNAL.json');
const reportDir = path.join(noChangeDir, 'artifacts');
mkdirSync(reportDir, { recursive: true });
writeFileSync(path.join(reportDir, 'no-change-report.md'), '# no change\n');
writeFileSync(noChangeTask, '- [ ] Investigate bug');
spawnSync(process.execPath, [helper, noChangeTask, noChangeSignal, 'start'], { encoding: 'utf8' });
spawnSync(process.execPath, [helper, noChangeTask, noChangeSignal, '1'], { encoding: 'utf8' });
result = spawnSync(
  process.execPath,
  [
    helper,
    noChangeTask,
    noChangeSignal,
    'no-change',
    '--reason',
    'bug not reproducible',
    '--mark-last',
  ],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(noChangeSignal, 'utf8'));
assert.equal(parsed.disposition, 'not_reproducible');
assert.equal(parsed.evidence.reportPath, 'artifacts/no-change-report.md');

const missingReportDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-nochange-missing-'));
const missingReportTask = path.join(missingReportDir, 'TASK.md');
const missingReportSignal = path.join(missingReportDir, 'SIGNAL.json');
writeFileSync(missingReportTask, '- [ ] Investigate bug');
result = spawnSync(
  process.execPath,
  [helper, missingReportTask, missingReportSignal, 'no-change', '--reason', 'missing report'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);

const blockedDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-blocked-'));
const blockedTask = path.join(blockedDir, 'TASK.md');
const blockedSignal = path.join(blockedDir, 'SIGNAL.json');
writeFileSync(blockedTask, '- [ ] Step A');
spawnSync(process.execPath, [helper, blockedTask, blockedSignal, 'start'], { encoding: 'utf8' });
result = spawnSync(
  process.execPath,
  [helper, blockedTask, blockedSignal, 'blocked', '--reason', 'CDP offline'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(blockedSignal, 'utf8'));
assert.equal(parsed.status, 'blocked');
assert.equal(parsed.outcome, 'partial');
assert.equal(parsed.disposition, 'blocked');
assert.equal(parsed.reason, 'CDP offline');

const startDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-start-'));
const startTask = path.join(startDir, 'TASK.md');
const startSignal = path.join(startDir, 'SIGNAL.json');
writeFileSync(startTask, '- [ ] **1. Update Status** — begin work');
result = spawnSync(process.execPath, [helper, startTask, startSignal, 'start'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(startSignal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.step, 'started');
assert.equal(parsed.checklistTiming.events.length, 0);

result = spawnSync(process.execPath, [helper, task, signal, '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0);
assert.match(result.stdout, /mark no-change/);
assert.match(result.stdout, /mark blocked/);
