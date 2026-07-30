const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const { CHECKLIST_TARGET_MANIFEST } = require('../scripts/checklist-target.cjs');

function writeManifest(taskDir, checklistBasename) {
  writeFileSync(
    path.join(taskDir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: checklistBasename }, null, 2)}\n`,
  );
}

const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-'));
writeManifest(dir, 'CHECKLIST.md');
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

let result = spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(task, 'utf8'), /- \[x\] First gate/);
let parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.checklistTiming.events.length, 1);
assert.equal(parsed.checklistTiming.events[0].stepNumber, 1);
assert.equal(parsed.checklistTiming.events[0].label, 'First gate');

result = spawnSync(process.execPath, [helper, dir, '2'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.checklistTiming.events.length, 2);

result = spawnSync(process.execPath, [helper, dir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(signal, 'utf8'));
assert.equal(parsed.status, 'complete');
assert.equal(parsed.outcome, 'success');
assert.equal(parsed.disposition, 'fixed');
assert.equal(parsed.checklistTiming.events.length, 2);

const devDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-dev-pr-'));
writeManifest(devDir, 'TASK.md');
const devTask = path.join(devDir, 'TASK.md');
const devSignal = path.join(devDir, 'SIGNAL.json');
mkdirSync(path.join(devDir, 'artifacts'), { recursive: true });
writeFileSync(devTask, ['# Worker: dev — DEMO-PR', '', '- [x] Ship feature'].join('\n'));
writeFileSync(path.join(devDir, 'artifacts', 'learnings.md'), '- Shipped.\n');
writeFileSync(path.join(devDir, 'artifacts', 'pr-description.md'), '# PR\n\nDone.\n');
result = spawnSync(process.execPath, [helper, devDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(devSignal, 'utf8'));
assert.equal(parsed.evidence?.reportPath, 'artifacts/pr-description.md');

const ciFixHyphenDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-ci-fix-hyphen-'));
writeManifest(ciFixHyphenDir, 'CI-FIX.md');
const ciFixHyphenTask = path.join(ciFixHyphenDir, 'CI-FIX.md');
const ciFixHyphenSignal = path.join(ciFixHyphenDir, 'CI-FIX-SIGNAL.json');
mkdirSync(path.join(ciFixHyphenDir, 'artifacts'), { recursive: true });
writeFileSync(ciFixHyphenTask, ['# Worker: CI-Fix Pass', '', '- [x] Fix CI failure'].join('\n'));
writeFileSync(path.join(ciFixHyphenDir, 'artifacts', 'learnings.md'), '- Fixed CI.\n');
writeFileSync(path.join(ciFixHyphenDir, 'artifacts', 'review.md'), '# Review\n');
result = spawnSync(process.execPath, [helper, ciFixHyphenDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 1, 'CI-Fix heading must not fall back to review.md');
assert.match(result.stderr, /artifacts\/report\.md/);
writeFileSync(path.join(ciFixHyphenDir, 'artifacts', 'report.md'), '# CI fix report\n');
result = spawnSync(process.execPath, [helper, ciFixHyphenDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(ciFixHyphenSignal, 'utf8'));
assert.equal(parsed.status, 'complete');

const noChangeDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-nochange-'));
writeManifest(noChangeDir, 'TASK.md');
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
spawnSync(process.execPath, [helper, noChangeDir, 'start'], { encoding: 'utf8' });
spawnSync(process.execPath, [helper, noChangeDir, '1'], { encoding: 'utf8' });
result = spawnSync(
  process.execPath,
  [helper, noChangeDir, 'no-change', '--reason', 'bug not reproducible', '--mark-last'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(noChangeSignal, 'utf8'));
assert.equal(parsed.disposition, 'not_reproducible');
assert.equal(parsed.evidence.reportPath, 'artifacts/no-change-report.md');

result = spawnSync(
  process.execPath,
  [helper, noChangeDir, 'no-change', '--reason', 'already fixed on main', '--already-fixed'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(noChangeSignal, 'utf8'));
assert.equal(parsed.disposition, 'already_fixed');

const missingReportDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-nochange-missing-'));
writeManifest(missingReportDir, 'TASK.md');
const missingReportTask = path.join(missingReportDir, 'TASK.md');
writeFileSync(missingReportTask, '- [ ] Investigate bug');
result = spawnSync(
  process.execPath,
  [helper, missingReportDir, 'no-change', '--reason', 'missing report'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 1);

const missingLearningsDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-no-learn-'));
writeManifest(missingLearningsDir, 'TASK.md');
const missingLearningsTask = path.join(missingLearningsDir, 'TASK.md');
mkdirSync(path.join(missingLearningsDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(missingLearningsDir, 'artifacts', 'report.md'), '# report\n');
writeFileSync(
  missingLearningsTask,
  ['# Worker: Feature — DEMO-4', '', '- [x] Only step'].join('\n'),
);
result = spawnSync(process.execPath, [helper, missingLearningsDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 1);
assert.match(result.stderr, /learnings\.md/);

result = spawnSync(
  process.execPath,
  [helper, missingLearningsDir, 'complete', '--mark-last', '--skip-learnings'],
  {
    encoding: 'utf8',
  },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(path.join(missingLearningsDir, 'SIGNAL.json'), 'utf8'));
assert.deepEqual(parsed.artifactWaivers, { learnings: true });

const incompleteChecklistDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-checklist-'));
writeManifest(incompleteChecklistDir, 'TASK.md');
const incompleteTask = path.join(incompleteChecklistDir, 'TASK.md');
mkdirSync(path.join(incompleteChecklistDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(incompleteChecklistDir, 'artifacts', 'learnings.md'), '- ok\n');
writeFileSync(path.join(incompleteChecklistDir, 'artifacts', 'report.md'), '# report\n');
writeFileSync(
  incompleteTask,
  ['# Worker: Feature — DEMO-2', '', '- [ ] Step A', '- [ ] Step B'].join('\n'),
);
result = spawnSync(process.execPath, [helper, incompleteChecklistDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 1);
assert.match(result.stderr, /checklist incomplete/);

const missingWorkerReportDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-no-report-'));
writeManifest(missingWorkerReportDir, 'TASK.md');
const missingWorkerReportTask = path.join(missingWorkerReportDir, 'TASK.md');
mkdirSync(path.join(missingWorkerReportDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(missingWorkerReportDir, 'artifacts', 'learnings.md'), '- ok\n');
writeFileSync(
  missingWorkerReportTask,
  ['# Worker: Feature — DEMO-3', '', '- [x] Only step'].join('\n'),
);
result = spawnSync(process.execPath, [helper, missingWorkerReportDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 1);
assert.match(result.stderr, /missing required (artifact|worker report)/);

const blockedDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-blocked-'));
writeManifest(blockedDir, 'TASK.md');
const blockedTask = path.join(blockedDir, 'TASK.md');
const blockedSignal = path.join(blockedDir, 'SIGNAL.json');
writeFileSync(blockedTask, '- [ ] Step A');
spawnSync(process.execPath, [helper, blockedDir, 'start'], { encoding: 'utf8' });
result = spawnSync(process.execPath, [helper, blockedDir, 'blocked', '--reason', 'CDP offline'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(blockedSignal, 'utf8'));
assert.equal(parsed.status, 'blocked');
assert.equal(parsed.outcome, 'partial');
assert.equal(parsed.disposition, 'blocked');
assert.equal(parsed.reason, 'CDP offline');

const startDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-start-'));
writeManifest(startDir, 'TASK.md');
const startTask = path.join(startDir, 'TASK.md');
const startSignal = path.join(startDir, 'SIGNAL.json');
writeFileSync(startTask, '- [ ] **1. Update Status** — begin work');
result = spawnSync(process.execPath, [helper, startDir, 'start'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(startSignal, 'utf8'));
assert.equal(parsed.status, 'running');
assert.equal(parsed.step, 'started');
assert.equal(parsed.checklistTiming.events.length, 0);

result = spawnSync(process.execPath, [helper, dir, '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0);
assert.match(result.stdout, /mark no-change/);
assert.match(result.stdout, /mark blocked/);
assert.doesNotMatch(result.stdout, /Explicit mode/);

const { SELF_REVIEW_CHECKLIST_TARGET } = require('../scripts/checklist-target.cjs');
const manifestDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-manifest-'));
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

const scopedContractDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-scoped-contract-'));
const scopedChecklist = 'SELF-REVIEW.rev-codex.md';
const scopedReport = 'artifacts/review-feedback.rev-codex.md';
writeManifest(scopedContractDir, 'TASK.md');
mkdirSync(path.join(scopedContractDir, 'inputs'), { recursive: true });
mkdirSync(path.join(scopedContractDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(scopedContractDir, 'TASK.md'), '- [ ] Worker step');
writeFileSync(path.join(scopedContractDir, scopedChecklist), '- [x] Review step');
writeFileSync(path.join(scopedContractDir, scopedReport), '# Review\n\nPASS\n');
writeFileSync(
  path.join(scopedContractDir, 'inputs', 'worker-terminal-contract.json'),
  JSON.stringify({
    schemaVersion: 1,
    flowType: 'dev',
    requireSignal: true,
    commands: {
      complete: {
        report: 'artifacts/pr-description.md',
        artifacts: ['artifacts/pr-description.md', 'artifacts/learnings.md'],
      },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    resolvedAt: new Date().toISOString(),
    source: 'builtin',
  }),
);
writeFileSync(
  path.join(scopedContractDir, 'inputs', 'worker-terminal-contract.SELF-REVIEW.rev-codex.json'),
  JSON.stringify({
    schemaVersion: 1,
    flowType: 'self-review',
    requireSignal: true,
    commands: {
      complete: { report: scopedReport, artifacts: [scopedReport] },
      'no-change': { report: scopedReport, artifacts: [scopedReport] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    resolvedAt: new Date().toISOString(),
    source: 'builtin',
  }),
);
result = spawnSync(
  process.execPath,
  [helper, scopedContractDir, '--checklist', scopedChecklist, 'complete', '--mark-last'],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(
  readFileSync(path.join(scopedContractDir, 'SELF-REVIEW.rev-codex-SIGNAL.json'), 'utf8'),
);
assert.equal(parsed.evidence.reportPath, scopedReport);

const missingManifestDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-no-manifest-'));
writeFileSync(path.join(missingManifestDir, 'TASK.md'), '- [ ] worker step');
result = spawnSync(process.execPath, [helper, missingManifestDir, 'start'], { encoding: 'utf8' });
assert.notEqual(result.status, 0, 'task-dir mark must fail without checklist-target.json');
assert.match(result.stderr, /checklist-target\.json/);
assert.match(result.stderr, /--checklist FILE\.md/);

const invalidManifestDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-bad-manifest-'));
writeFileSync(path.join(invalidManifestDir, 'TASK.md'), '- [ ] worker step');
writeFileSync(path.join(invalidManifestDir, CHECKLIST_TARGET_MANIFEST), '{not json');
result = spawnSync(process.execPath, [helper, invalidManifestDir, 'start'], { encoding: 'utf8' });
assert.notEqual(result.status, 0, 'task-dir mark must fail with invalid checklist-target.json');
assert.match(result.stderr, /invalid JSON or checklist basename/);

const legacyExplicitDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-legacy-explicit-'));
writeManifest(legacyExplicitDir, 'TASK.md');
const legacyTask = path.join(legacyExplicitDir, 'TASK.md');
const legacySignal = path.join(legacyExplicitDir, 'SIGNAL.json');
writeFileSync(legacyTask, '- [ ] legacy step');
result = spawnSync(process.execPath, [helper, legacyTask, legacySignal, 'start'], {
  encoding: 'utf8',
});
assert.notEqual(result.status, 0, 'legacy explicit-args mark surface must be rejected');
assert.doesNotMatch(result.stderr, /Explicit mode/);
