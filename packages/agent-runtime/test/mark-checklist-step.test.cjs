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
  ['# Worker: Feature — DEMO-1', '', '- [x] First gate', '- [x] **Second gate** — validate'].join(
    '\n',
  ),
);
mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Nothing relevant — smoke test.\n');
writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nSmoke test complete.\n');

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

const devDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-dev-pr-'));
const devTask = path.join(devDir, 'TASK.md');
const devSignal = path.join(devDir, 'SIGNAL.json');
mkdirSync(path.join(devDir, 'artifacts'), { recursive: true });
writeFileSync(devTask, ['# Worker: dev — DEMO-PR', '', '- [x] Ship feature'].join('\n'));
writeFileSync(path.join(devDir, 'artifacts', 'learnings.md'), '- Shipped.\n');
writeFileSync(path.join(devDir, 'artifacts', 'pr-description.md'), '# PR\n\nDone.\n');
result = spawnSync(process.execPath, [helper, devTask, devSignal, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(devSignal, 'utf8'));
assert.equal(parsed.evidence?.reportPath, 'artifacts/pr-description.md');

const noChangeDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-nochange-'));
const noChangeTask = path.join(noChangeDir, 'TASK.md');
const noChangeSignal = path.join(noChangeDir, 'SIGNAL.json');
const reportDir = path.join(noChangeDir, 'artifacts');
mkdirSync(reportDir, { recursive: true });
writeFileSync(path.join(reportDir, 'no-change-report.md'), '# no change\n');
writeFileSync(
  path.join(reportDir, 'learnings.md'),
  '- Bug not reproducible after investigation.\n',
);
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

result = spawnSync(
  process.execPath,
  [
    helper,
    noChangeTask,
    noChangeSignal,
    'no-change',
    '--reason',
    'already fixed on main',
    '--already-fixed',
  ],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(noChangeSignal, 'utf8'));
assert.equal(parsed.disposition, 'already_fixed');

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

const missingLearningsDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-no-learn-'));
const missingLearningsTask = path.join(missingLearningsDir, 'TASK.md');
const missingLearningsSignal = path.join(missingLearningsDir, 'SIGNAL.json');
mkdirSync(path.join(missingLearningsDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(missingLearningsDir, 'artifacts', 'report.md'), '# report\n');
writeFileSync(
  missingLearningsTask,
  ['# Worker: Feature — DEMO-4', '', '- [x] Only step'].join('\n'),
);
result = spawnSync(
  process.execPath,
  [helper, missingLearningsTask, missingLearningsSignal, 'complete', '--mark-last'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);
assert.match(result.stderr, /learnings\.md/);

const incompleteChecklistDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-checklist-'));
const incompleteTask = path.join(incompleteChecklistDir, 'TASK.md');
const incompleteSignal = path.join(incompleteChecklistDir, 'SIGNAL.json');
mkdirSync(path.join(incompleteChecklistDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(incompleteChecklistDir, 'artifacts', 'learnings.md'), '- ok\n');
writeFileSync(path.join(incompleteChecklistDir, 'artifacts', 'report.md'), '# report\n');
writeFileSync(
  incompleteTask,
  ['# Worker: Feature — DEMO-2', '', '- [ ] Step A', '- [ ] Step B'].join('\n'),
);
result = spawnSync(
  process.execPath,
  [helper, incompleteTask, incompleteSignal, 'complete', '--mark-last'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);
assert.match(result.stderr, /checklist incomplete/);

const missingWorkerReportDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-no-report-'));
const missingWorkerReportTask = path.join(missingWorkerReportDir, 'TASK.md');
const missingWorkerReportSignal = path.join(missingWorkerReportDir, 'SIGNAL.json');
mkdirSync(path.join(missingWorkerReportDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(missingWorkerReportDir, 'artifacts', 'learnings.md'), '- ok\n');
writeFileSync(
  missingWorkerReportTask,
  ['# Worker: Feature — DEMO-3', '', '- [x] Only step'].join('\n'),
);
result = spawnSync(
  process.execPath,
  [helper, missingWorkerReportTask, missingWorkerReportSignal, 'complete', '--mark-last'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);
assert.match(result.stderr, /missing required (artifact|worker report)/);

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

const manifestDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-manifest-'));
const {
  CHECKLIST_TARGET_MANIFEST,
  SELF_REVIEW_CHECKLIST_TARGET,
} = require('../scripts/checklist-target.cjs');
const reviewTask = path.join(manifestDir, SELF_REVIEW_CHECKLIST_TARGET.checklist);
const reviewSignal = path.join(manifestDir, SELF_REVIEW_CHECKLIST_TARGET.signal);
writeFileSync(reviewTask, '- [ ] **1. Review step** — inspect diff');
writeFileSync(
  path.join(manifestDir, CHECKLIST_TARGET_MANIFEST),
  JSON.stringify(SELF_REVIEW_CHECKLIST_TARGET, null, 2),
);
result = spawnSync(process.execPath, [helper, manifestDir, 'start'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(reviewSignal, 'utf8'));
assert.equal(parsed.status, 'running');
result = spawnSync(process.execPath, [helper, manifestDir, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(reviewTask, 'utf8'), /- \[x\] \*\*1\. Review step\*\*/);

const overrideDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-override-'));
const overrideTask = path.join(overrideDir, SELF_REVIEW_CHECKLIST_TARGET.checklist);
const overrideSignal = path.join(overrideDir, SELF_REVIEW_CHECKLIST_TARGET.signal);
writeFileSync(overrideTask, '- [ ] **1. Override step** — review');
writeFileSync(path.join(overrideDir, 'TASK.md'), '- [ ] worker step');
result = spawnSync(
  process.execPath,
  [helper, overrideDir, '--checklist', SELF_REVIEW_CHECKLIST_TARGET.checklist, '1'],
  {
    encoding: 'utf8',
  },
);
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(overrideTask, 'utf8'), /- \[x\]/);
assert.doesNotMatch(readFileSync(path.join(overrideDir, 'TASK.md'), 'utf8'), /- \[x\]/);
parsed = JSON.parse(readFileSync(overrideSignal, 'utf8'));
assert.equal(parsed.status, 'running');
