const assert = require('node:assert/strict');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const {
  CHECKLIST_TARGET_MANIFEST,
  terminalContractInputForChecklist,
} = require('../scripts/checklist-target.cjs');

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
// The bold lead is the name; the instruction tail after it is not recorded.
assert.equal(parsed.checklistTiming.events[1].label, 'Second gate');

// A recipe-free task completes without the built protocol package (source-checkout slots).
const noProtocol = path.join(dir, 'no-protocol.cjs');
writeFileSync(
  noProtocol,
  `const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@farmslot/protocol/recipe') {
    const error = new Error('Cannot find module ' + request);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return load.call(this, request, ...rest);
};
`,
);
result = spawnSync(process.execPath, [helper, dir, 'complete', '--mark-last'], {
  encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: `--require ${noProtocol}` },
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

const qaDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-qa-html-'));
writeManifest(qaDir, 'CHECKLIST.md');
mkdirSync(path.join(qaDir, 'artifacts'));
mkdirSync(path.join(qaDir, 'inputs'));
writeFileSync(path.join(qaDir, 'CHECKLIST.md'), '# Worker: qa\n\n- [x] Validate selected checks\n');
writeFileSync(
  path.join(qaDir, 'artifacts/report.html'),
  '<h1>QA report</h1><p>Proof retained.</p>',
);
writeFileSync(path.join(qaDir, 'artifacts/learnings.md'), 'Reused the existing smoke recipe.\n');
const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');
writeFileSync(
  path.join(qaDir, 'inputs/worker-terminal-contract.json'),
  JSON.stringify(resolveWorkerTerminalContract(null, 'qa')),
);
result = spawnSync(process.execPath, [helper, qaDir, 'complete'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const qaSignal = JSON.parse(readFileSync(path.join(qaDir, 'SIGNAL.json'), 'utf8'));
assert.equal(qaSignal.evidence.reportPath, 'artifacts/report.html');
assert.equal(existsSync(path.join(qaDir, 'artifacts/report.md')), false);

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

// The launcher supplies one identity to the reviewer and all its descendants.
const launchAttempt = '11111111-1111-4111-8111-111111111111';
const launchEnv = { ...process.env, FARMSLOT_SIGNAL_ATTEMPT_ID: launchAttempt };
result = spawnSync(process.execPath, [helper, startDir, 'start'], {
  env: launchEnv,
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(readFileSync(startSignal, 'utf8')).attemptId, launchAttempt);
result = spawnSync(process.execPath, [helper, startDir, '1'], { env: launchEnv, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const beforeRepeatedStart = readFileSync(startSignal, 'utf8');
result = spawnSync(process.execPath, [helper, startDir, 'start'], {
  env: launchEnv,
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(readFileSync(startSignal, 'utf8'), beforeRepeatedStart);
const nextAttempt = '22222222-2222-4222-8222-222222222222';
result = spawnSync(process.execPath, [helper, startDir, 'start'], {
  env: { ...launchEnv, FARMSLOT_SIGNAL_ATTEMPT_ID: nextAttempt },
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(readFileSync(startSignal, 'utf8')).attemptId, nextAttempt);

result = spawnSync(process.execPath, [helper, dir, '--help'], { encoding: 'utf8' });
assert.equal(result.status, 0);
assert.match(result.stdout, /mark no-change/);
assert.match(result.stdout, /mark blocked/);
assert.doesNotMatch(result.stdout, /Explicit mode/);

const { REVIEW_CHECKLIST_TARGET } = require('../scripts/checklist-target.cjs');
const manifestDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-manifest-'));
const reviewTask = path.join(manifestDir, REVIEW_CHECKLIST_TARGET.checklist);
const reviewSignal = path.join(manifestDir, REVIEW_CHECKLIST_TARGET.signal);
writeFileSync(reviewTask, '- [ ] **1. Review step** — inspect diff');
writeFileSync(
  path.join(manifestDir, CHECKLIST_TARGET_MANIFEST),
  JSON.stringify(REVIEW_CHECKLIST_TARGET, null, 2),
);
result = spawnSync(process.execPath, [helper, manifestDir, 'start'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
parsed = JSON.parse(readFileSync(reviewSignal, 'utf8'));
assert.equal(parsed.status, 'running');
result = spawnSync(process.execPath, [helper, manifestDir, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(readFileSync(reviewTask, 'utf8'), /- \[x\] \*\*1\. Review step\*\*/);

const overrideDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-override-'));
const overrideTask = path.join(overrideDir, REVIEW_CHECKLIST_TARGET.checklist);
const overrideSignal = path.join(overrideDir, REVIEW_CHECKLIST_TARGET.signal);
writeFileSync(overrideTask, '- [ ] **1. Override step** — review');
writeFileSync(path.join(overrideDir, 'TASK.md'), '- [ ] worker step');
result = spawnSync(
  process.execPath,
  [helper, overrideDir, '--checklist', REVIEW_CHECKLIST_TARGET.checklist, '1'],
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
const scopedChecklist = 'REVIEW.rev-codex.md';
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
  path.join(scopedContractDir, 'inputs', 'worker-terminal-contract.REVIEW.rev-codex.json'),
  JSON.stringify({
    schemaVersion: 1,
    flowType: 'review',
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
  readFileSync(path.join(scopedContractDir, 'REVIEW.rev-codex-SIGNAL.json'), 'utf8'),
);
assert.equal(parsed.evidence.reportPath, scopedReport);

// Absent manifest means the worker default: CHECKLIST.md when present, else TASK.md.
const missingManifestDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-no-manifest-'));
writeFileSync(path.join(missingManifestDir, 'TASK.md'), '- [ ] worker step');
result = spawnSync(process.execPath, [helper, missingManifestDir, 'start'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.ok(existsSync(path.join(missingManifestDir, 'SIGNAL.json')));
const defaultChecklistDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-default-checklist-'));
writeFileSync(path.join(defaultChecklistDir, 'TASK.md'), '- [ ] never counted');
writeFileSync(path.join(defaultChecklistDir, 'CHECKLIST.md'), '- [ ] 1. worker step');
result = spawnSync(process.execPath, [helper, defaultChecklistDir, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(
  readFileSync(path.join(defaultChecklistDir, 'CHECKLIST.md'), 'utf8'),
  /- \[x\] 1\. worker step/,
);
assert.match(
  readFileSync(path.join(defaultChecklistDir, 'TASK.md'), 'utf8'),
  /- \[ \] never counted/,
);

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

// Regression: checkbox-formatted Acceptance Criteria (and other informational
// sections) must not shift step numbering — `mark 1` targets the first real
// checklist step, and terminal completion ignores informational boxes.
const acSkewDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-ac-skew-'));
writeManifest(acSkewDir, 'TASK.md');
const acSkewTask = path.join(acSkewDir, 'TASK.md');
const acSkewSignal = path.join(acSkewDir, 'SIGNAL.json');
mkdirSync(path.join(acSkewDir, 'artifacts'), { recursive: true });
writeFileSync(path.join(acSkewDir, 'artifacts', 'learnings.md'), '- AC skew regression.\n');
writeFileSync(path.join(acSkewDir, 'artifacts', 'report.md'), '# Report\n\nDone.\n');
writeFileSync(
  acSkewTask,
  [
    '# Worker: Feature — DEMO-AC',
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] Informational AC one',
    '- [ ] Informational AC two',
    '',
    '## Checklist',
    '',
    '- [ ] **1. Real first step**',
    '- [ ] **2. Real second step**',
  ].join('\n'),
);
result = spawnSync(process.execPath, [helper, acSkewDir, '1'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
let acSkewContent = readFileSync(acSkewTask, 'utf8');
assert.match(acSkewContent, /- \[x\] \*\*1\. Real first step\*\*/, 'mark 1 must check step 1');
assert.match(
  acSkewContent,
  /- \[ \] Informational AC one/,
  'AC checkboxes must not be touched by mark',
);
parsed = JSON.parse(readFileSync(acSkewSignal, 'utf8'));
assert.equal(parsed.checklistTiming.events[0].stepNumber, 1);
assert.equal(parsed.checklistTiming.events[0].label, '1. Real first step');

result = spawnSync(process.execPath, [helper, acSkewDir, '2'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);

// Terminal completion must succeed with informational AC boxes still [ ].
result = spawnSync(process.execPath, [helper, acSkewDir, 'complete', '--mark-last'], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
acSkewContent = readFileSync(acSkewTask, 'utf8');
assert.match(acSkewContent, /- \[ \] Informational AC two/, 'AC boxes stay unchecked at complete');

// A frozen review-fix contract may still name the logical task-root manifest.
// Completion must resolve it exactly as artifact-check does, without a link/copy.
const selectedStarted = performance.now();
const selectedDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-selected-manifest-'));
try {
  writeManifest(selectedDir, 'REVIEW-FIX.md');
  writeFileSync(
    path.join(selectedDir, 'REVIEW-FIX.md'),
    '# Worker: review-fix\n\n- [x] Fix findings\n',
  );
  const artifacts = path.join(selectedDir, 'artifacts');
  const inputs = path.join(selectedDir, 'inputs');
  const attempt = path.join(artifacts, 'recipe-runs', 'selected');
  mkdirSync(attempt, { recursive: true });
  mkdirSync(inputs, { recursive: true });
  writeFileSync(path.join(artifacts, 'report.md'), '# Report\n\nThe fix and validation passed.\n');
  writeFileSync(
    path.join(artifacts, 'recipe-coverage.md'),
    'The selected execution is retained.\n',
  );
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Retain the selected execution.',
    workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
  };
  const { digestRecipeDocument } = require('@farmslot/protocol/recipe');
  writeFileSync(path.join(artifacts, 'recipe.json'), JSON.stringify(recipe));
  writeFileSync(path.join(attempt, 'recipe.json'), JSON.stringify(recipe));
  writeFileSync(
    path.join(attempt, 'recipe-resolution.json'),
    JSON.stringify({
      schema_version: 1,
      root: { ref: 'task', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    }),
  );
  writeFileSync(
    path.join(attempt, 'artifact-manifest.json'),
    '{"version":1,"runStatus":"pass","artifacts":[]}',
  );
  writeFileSync(path.join(attempt, 'trace.json'), '[{"nodeId":"done","action":"end","ok":true}]');
  writeFileSync(
    path.join(attempt, 'summary.json'),
    JSON.stringify({
      status: 'pass',
      total: 1,
      passed: 1,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
    }),
  );
  const manifestPath = path.join(attempt, 'evidence-manifest.json');
  const manifestBytes = '{"version":1,"standalone":[]}\n';
  writeFileSync(manifestPath, manifestBytes);
  const { recordRecipeAttemptSelection } = require('../scripts/retained-recipe-attempt.cjs');
  assert.equal(recordRecipeAttemptSelection(selectedDir, attempt), true);
  const pointerPath = path.join(artifacts, 'latest-valid-recipe-run.json');
  const pointerBytes = readFileSync(pointerPath);
  writeFileSync(
    path.join(selectedDir, terminalContractInputForChecklist('REVIEW-FIX.md')),
    JSON.stringify({
      schemaVersion: 1,
      flowType: 'review-fix',
      recordedEvidenceContractVersion: 1,
      commands: { complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] } },
      whenPresent: [
        {
          path: 'artifacts/recipe.json',
          alsoRequire: ['artifacts/recipe-coverage.md', 'artifacts/evidence-manifest.json'],
        },
      ],
    }),
  );
  const complete = () =>
    spawnSync(process.execPath, [helper, selectedDir, 'complete', '--mark-last'], {
      encoding: 'utf8',
    });
  let completed = complete();
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(existsSync(path.join(artifacts, 'evidence-manifest.json')), false);
  assert.deepEqual(readFileSync(manifestPath), Buffer.from(manifestBytes));
  assert.deepEqual(readFileSync(pointerPath), pointerBytes);
  assert.equal(
    JSON.parse(readFileSync(path.join(selectedDir, 'REVIEW-FIX-SIGNAL.json'), 'utf8')).status,
    'complete',
  );
  // A stale root declaration must never rescue a missing current selected manifest.
  rmSync(manifestPath);
  writeFileSync(path.join(artifacts, 'evidence-manifest.json'), manifestBytes);
  completed = complete();
  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /recipe-runs\/selected\/evidence-manifest\.json/);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(pointerPath, '{"version":1,"relativeArtifactRoot":"../outside"}');
  completed = complete();
  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /Invalid retained recipe attempt selection/);
} finally {
  rmSync(selectedDir, { recursive: true, force: true });
}
console.log(
  `Selected-manifest completion regression: ${(performance.now() - selectedStarted).toFixed(0)}ms`,
);

// audiolab #529 (run 6937512d) shape: engine proof attempts (an after run and a separate base
// run) that nothing selects. Completion checked no evidence and publication had none to use.
// It must name the attempt to select, and never pick one itself.
const unselectedStarted = performance.now();
const unselectedDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-unselected-attempt-'));
try {
  writeManifest(unselectedDir, 'CHECKLIST.md');
  writeFileSync(path.join(unselectedDir, 'CHECKLIST.md'), '# Worker: dev\n\n- [x] Prove the fix\n');
  const artifacts = path.join(unselectedDir, 'artifacts');
  mkdirSync(path.join(unselectedDir, 'inputs'), { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, 'report.md'), '# Report\n\nThe fix is proven.\n');
  const recipe = '{"description":"Prove the flag","workflow":{"entry":"done","nodes":{}}}';
  for (const name of ['after-flag-09425041', 'before-flag-6f0e66fa']) {
    const attempt = path.join(artifacts, 'recipe-runs', name);
    mkdirSync(attempt, { recursive: true });
    writeFileSync(path.join(attempt, 'recipe.json'), recipe);
    writeFileSync(path.join(attempt, 'summary.json'), '{"status":"pass"}');
    writeFileSync(path.join(attempt, 'evidence-manifest.json'), '{"version":1,"standalone":[]}\n');
  }
  writeFileSync(
    path.join(unselectedDir, terminalContractInputForChecklist('CHECKLIST.md')),
    JSON.stringify({
      schemaVersion: 1,
      flowType: 'dev',
      recordedEvidenceContractVersion: 1,
      commands: { complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] } },
      whenPresent: [
        {
          path: 'artifacts/recipe.json',
          alsoRequire: ['artifacts/recipe-coverage.md', 'artifacts/evidence-manifest.json'],
        },
      ],
    }),
  );
  const complete = () =>
    spawnSync(process.execPath, [helper, unselectedDir, 'complete', '--mark-last'], {
      encoding: 'utf8',
    });
  const signalFile = path.join(unselectedDir, 'SIGNAL.json');
  let completed = complete();
  assert.notEqual(completed.status, 0, 'unselected proof attempts must refuse completion');
  assert.match(completed.stderr, /latest-valid-recipe-run\.json selects none/);
  assert.match(
    completed.stderr,
    /recipe-runs\/after-flag-09425041, recipe-runs\/before-flag-6f0e66fa/,
  );
  assert.match(
    completed.stderr,
    /retained-recipe-attempt\.cjs' '.*' '.*recipe-runs\/after-flag-09425041'/,
  );
  assert.equal(existsSync(path.join(artifacts, 'latest-valid-recipe-run.json')), false);
  assert.equal(
    existsSync(signalFile) && JSON.parse(readFileSync(signalFile, 'utf8')).status,
    false,
  );

  // A selection without artifacts/recipe.json still requires no manifest.
  writeFileSync(
    path.join(artifacts, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      relativeArtifactRoot: 'recipe-runs/after-flag-09425041',
      updatedAt: new Date().toISOString(),
    }),
  );
  completed = complete();
  assert.notEqual(completed.status, 0, 'a selection with no task recipe must refuse completion');
  assert.match(
    completed.stderr,
    /Copy artifacts\/recipe-runs\/after-flag-09425041\/recipe\.json to artifacts\/recipe\.json/,
  );
  assert.equal(existsSync(path.join(artifacts, 'recipe.json')), false);
  // A directory named recipe.json is not a task recipe.
  mkdirSync(path.join(artifacts, 'recipe.json'));
  completed = complete();
  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /Copy artifacts\/recipe-runs\/after-flag-09425041\/recipe\.json/);
  rmSync(path.join(artifacts, 'recipe.json'), { recursive: true });

  // Attempts nest under recipe-runs/attempts/<id> (harness) or a deeper --artifacts-dir; an
  // unreadable summary is reported as such, not as a failed proof.
  rmSync(path.join(artifacts, 'latest-valid-recipe-run.json'));
  rmSync(path.join(artifacts, 'recipe-runs'), { recursive: true });
  for (const nested of ['attempts/a1', 'group/subgroup/a2', 'attempts/a1/retry']) {
    const dir = path.join(artifacts, 'recipe-runs', nested);
    mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
    writeFileSync(path.join(dir, 'evidence-manifest.json'), '{"version":1,"standalone":[]}\n');
    writeFileSync(path.join(dir, 'summary.json'), '{');
  }
  completed = complete();
  assert.notEqual(completed.status, 0, 'nested attempts must be selected too');
  assert.match(
    completed.stderr,
    /proof attempts \(recipe-runs\/attempts\/a1, recipe-runs\/attempts\/a1\/retry, recipe-runs\/group\/subgroup\/a2\)/,
  );
  assert.match(completed.stderr, /No passing attempt could be verified/);
  assert.match(completed.stderr, /Unreadable summaries: recipe-runs\/attempts\/a1\/summary\.json/);

  // A qa-result.json does not exempt a dev task; the QA contract keeps its own selection.
  writeFileSync(path.join(artifacts, 'qa-result.json'), '{}');
  completed = complete();
  assert.match(completed.stderr, /selects none/);
  const contractFile = path.join(unselectedDir, terminalContractInputForChecklist('CHECKLIST.md'));
  writeFileSync(
    contractFile,
    JSON.stringify({ ...JSON.parse(readFileSync(contractFile, 'utf8')), flowType: 'qa' }),
  );
  completed = complete();
  assert.doesNotMatch(completed.stderr, /selects none/);
} finally {
  rmSync(unselectedDir, { recursive: true, force: true });
}
console.log(
  `Unselected-attempt completion regression: ${(performance.now() - unselectedStarted).toFixed(0)}ms`,
);

// A run's reviewer completes beside a blocked worker's recipe.json (F312): the worker's
// recipe artifacts are the worker's obligation, so they never bind the reviewer's own mark.
const reviewerStarted = performance.now();
const reviewerDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-reviewer-recipe-'));
try {
  writeManifest(reviewerDir, 'CHECKLIST.md');
  mkdirSync(path.join(reviewerDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(reviewerDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(reviewerDir, 'CHECKLIST.md'), '- [x] Worker step');
  writeFileSync(path.join(reviewerDir, 'REVIEW.md'), '- [x] Review step');
  // The worker wrote its recipe but stopped before its coverage report and evidence manifest.
  writeFileSync(path.join(reviewerDir, 'artifacts', 'recipe.json'), '{"title":"blocked worker"}');
  writeFileSync(path.join(reviewerDir, 'artifacts', 'review-feedback.md'), '# Review\n\nISSUES\n');
  const reviewContract = resolveWorkerTerminalContract(null, 'review');
  assert.deepEqual(reviewContract.whenPresent, []);
  assert.ok(resolveWorkerTerminalContract(null, 'dev').whenPresent.length > 0);
  writeFileSync(
    path.join(reviewerDir, terminalContractInputForChecklist('REVIEW.md')),
    JSON.stringify(reviewContract),
  );
  const reviewed = spawnSync(
    process.execPath,
    [helper, reviewerDir, '--checklist', 'REVIEW.md', 'complete', '--mark-last'],
    { encoding: 'utf8' },
  );
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(
    JSON.parse(readFileSync(path.join(reviewerDir, 'REVIEW-SIGNAL.json'), 'utf8')).status,
    'complete',
  );
} finally {
  rmSync(reviewerDir, { recursive: true, force: true });
}
console.log(
  `Reviewer beside a worker recipe: ${(performance.now() - reviewerStarted).toFixed(0)}ms`,
);

// A note on a numbered mark. Live run 8dde9cf8 ran
// `./mark 11 --reason "the bug reproduces"` on an exit-early step: doing the
// step is checking reproduction and recording what was found, so the mark is
// right and the row is done, not skipped. The flag was accepted and the text
// dropped, so the rationale a reviewer wants later went nowhere.
{
  const noteDir = mkdtempSync(path.join(tmpdir(), 'farmslot-mark-note-'));
  try {
    writeManifest(noteDir, 'CHECKLIST.md');
    mkdirSync(path.join(noteDir, 'artifacts'), { recursive: true });
    writeFileSync(
      path.join(noteDir, 'CHECKLIST.md'),
      ['- [ ] 1. Exit early if already fixed', '- [ ] 2. Fix it'].join('\n'),
    );
    const mark = (...args) =>
      spawnSync(process.execPath, [helper, noteDir, ...args], { encoding: 'utf8' });
    const events = () =>
      JSON.parse(readFileSync(path.join(noteDir, 'SIGNAL.json'), 'utf8')).checklistTiming.events;

    const noted = mark('1', '--reason', 'the bug still reproduces, continuing');
    assert.equal(noted.status, 0, noted.stderr);
    const event = events().at(-1);
    assert.equal(event.stepNumber, 1);
    assert.equal(event.note, 'the bug still reproduces, continuing');
    // A note is not a waiver, so it never lands in the waiver field.
    assert.equal(event.reason, undefined);
    // Done is not skipped: the work was performed, and only `--skip` waives it.
    assert.equal(event.skipped, undefined);
    const checklistOrder = require('../scripts/checklist-order.cjs');
    assert.equal(checklistOrder.skipped(noteDir, 'CHECKLIST.md').has(1), false);

    // Re-marking restates the claim, so the note follows the latest statement
    // rather than leaving stale rationale on the row.
    const remarked = mark('1', '--reason', 'reproduced again after the rebase');
    assert.equal(remarked.status, 0, remarked.stderr);
    assert.equal(events().at(-1).note, 'reproduced again after the rebase');

    // Two reasons on one event is ambiguous about which one persisted.
    const both = mark('2', '--reason', 'a note', '--skip', 'does not apply');
    assert.equal(both.status, 2, both.stdout + both.stderr);
    assert.match(both.stderr, /--reason and --skip/);

    // An empty note is a usage error, as an empty skip reason already is.
    const empty = mark('2', '--reason', '   ');
    assert.equal(empty.status, 2, empty.stdout + empty.stderr);
    assert.match(empty.stderr, /--reason needs text/);

    // A skip still records both fields, unchanged.
    mkdirSync(path.join(noteDir, 'inputs'), { recursive: true });
    writeFileSync(
      path.join(noteDir, 'inputs', 'worker-terminal-contract.json'),
      JSON.stringify({
        optionalSteps: [{ checklist: 'CHECKLIST.md', stepNumber: 2, when: 'nothing to fix' }],
      }),
    );
    const skipped = mark('2', '--skip', 'nothing left to fix');
    assert.equal(skipped.status, 0, skipped.stderr);
    const skipEvent = events().at(-1);
    assert.equal(skipEvent.skipped, true);
    assert.equal(skipEvent.reason, 'nothing left to fix');
    assert.equal(skipEvent.note, undefined);

    // A waived step rechecked later: the worker skipped it, rebased, found the
    // bug reproducing after all, and records that. The waiver's rationale is
    // what the order check quotes back when a skip was not declared, so a note
    // must not overwrite it — both records survive on the one event.
    const rechecked = mark('2', '--reason', 'rebased, it reproduces after all');
    assert.equal(rechecked.status, 0, rechecked.stderr);
    const waivedAndNoted = events().at(-1);
    assert.equal(waivedAndNoted.skipped, true, 'the skip itself is unchanged');
    assert.equal(waivedAndNoted.reason, 'nothing left to fix', 'the waiver rationale survives');
    assert.equal(waivedAndNoted.note, 'rebased, it reproduces after all');
    const order = require('../scripts/checklist-order.cjs');
    assert.equal(order.skipped(noteDir, 'CHECKLIST.md').get(2), 'nothing left to fix');
  } finally {
    rmSync(noteDir, { recursive: true, force: true });
  }
  console.log('Numbered mark records its note');
}

// GLM evals 4cba5c2f and ee2a98b8 both called complete with zero steps marked.
// Three things were wrong and each is checked here.
{
  const gapDir = mkdtempSync(path.join(tmpdir(), 'farmslot-premature-'));
  try {
    const contract = (extra = {}) =>
      JSON.stringify({
        schemaVersion: 1,
        flowType: 'fix-bug',
        mode: 'autonomous',
        requireSignal: true,
        commands: {
          complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] },
          'no-change': { artifacts: [] },
          blocked: { artifacts: [] },
        },
        whenPresent: [],
        ...extra,
      });
    const fresh = (name, extra) => {
      const dir = path.join(gapDir, name);
      mkdirSync(path.join(dir, 'inputs'), { recursive: true });
      mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
      writeManifest(dir, 'CHECKLIST.md');
      writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [ ] 1. First\n- [ ] 2. Second\n');
      writeFileSync(path.join(dir, 'inputs', 'worker-terminal-contract.json'), contract(extra));
      return dir;
    };
    const mark = (dir, ...args) =>
      spawnSync(process.execPath, [helper, dir, ...args], { encoding: 'utf8' });
    const status = (dir) =>
      existsSync(path.join(dir, 'SIGNAL.json'))
        ? JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8')).status
        : 'none';

    // (3) A plain `complete` checks its checklist. This was gated on
    // --mark-last, so a complete with nothing marked was simply accepted and
    // the run was reported successful over an untouched checklist.
    const premature = fresh('premature', { unattendedCompletion: true });
    writeFileSync(path.join(premature, 'artifacts', 'report.md'), '# Report\n');
    const refused = mark(premature, 'complete');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /checklist incomplete — 2 step\(s\) still \[ \]/);
    // (1) A refusal with steps outstanding must not end the run: the worker is
    // still working, and ending it sent the run to review underneath it.
    assert.equal(status(premature), 'none', 'the refusal left no terminal signal');

    // (1) With every step marked and the refusal still standing, the worker has
    // nothing left to try, so the run ends as a scorable refusal (F6).
    const exhausted = fresh('exhausted', { unattendedCompletion: true });
    assert.equal(mark(exhausted, '1').status, 0);
    assert.equal(mark(exhausted, '2').status, 0);
    const ended = mark(exhausted, 'complete');
    assert.equal(ended.status, 1, ended.stdout + ended.stderr);
    assert.match(ended.stderr, /missing required artifact: artifacts\/report\.md/);
    assert.equal(status(exhausted), 'blocked', 'an exhausted worker ends the run');

    // (2) A blocked run stays resumable: a worker told to carry on calls start
    // and keeps its boxes, which is the existing contract. The eval only reached
    // that door because the premature complete above had manufactured a blocked
    // signal, and with (3) and (1) fixed that signal never exists.
    const resumable = fresh('resumable');
    assert.equal(mark(resumable, '1').status, 0);
    assert.equal(mark(resumable, 'blocked', '--reason', 'target unavailable').status, 0);
    assert.equal(status(resumable), 'blocked');
    assert.equal(mark(resumable, 'start').status, 0, 'a blocked run still resumes');
    assert.equal(status(resumable), 'running');
    assert.match(readFileSync(path.join(resumable, 'CHECKLIST.md'), 'utf8'), /\[x\] 1\. First/);

    // (2) A finished run is not resumable. Before this, start on a complete
    // signal fell straight through and destroyed the record of a run parked at
    // its human gate.
    const finished = fresh('finished');
    writeFileSync(path.join(finished, 'artifacts', 'report.md'), '# Report\n');
    assert.equal(mark(finished, '1').status, 0);
    assert.equal(mark(finished, '2').status, 0);
    assert.equal(mark(finished, 'complete').status, 0);
    assert.equal(status(finished), 'complete');
    const afterComplete = mark(finished, 'start');
    assert.equal(afterComplete.status, 1, afterComplete.stdout + afterComplete.stderr);
    assert.match(afterComplete.stderr, /start does not re-open it/);
    assert.equal(status(finished), 'complete', 'a finished run keeps its signal');

    // A re-dispatch clears the signal first (replay-step.ts), and then start is
    // the ordinary beginning of a new attempt.
    rmSync(path.join(finished, 'SIGNAL.json'));
    assert.equal(mark(finished, 'start').status, 0);
    assert.equal(status(finished), 'running', 'a cleared signal starts again');

    // Grok graded this a blocker and Codex a major: `no-change` is the
    // documented early exit. fix-bug.md:7 tells a worker that finds the bug
    // already fixed or not reproducible to write its reports and run
    // `mark no-change`, and the core 21-step checklist puts that at step 11
    // with steps 12-21 still ahead and not optional, so it cannot skip them.
    const earlyExit = fresh('early-exit');
    writeFileSync(path.join(earlyExit, 'artifacts', 'no-change-report.md'), '# Not reproduced\n');
    writeFileSync(path.join(earlyExit, 'artifacts', 'learnings.md'), '- Nothing to fix.\n');
    assert.equal(mark(earlyExit, '1').status, 0);
    const exited = mark(earlyExit, 'no-change', '--reason', 'already fixed on this base');
    assert.equal(exited.status, 0, exited.stdout + exited.stderr);
    assert.equal(status(earlyExit), 'complete', 'the early exit still signals');
    assert.match(readFileSync(path.join(earlyExit, 'CHECKLIST.md'), 'utf8'), /\[ \] 2\. Second/);

    // Codex's second major: `complete --mark-last` ticks its final row AFTER
    // the exit handler is installed, and every standard template finishes that
    // way. Sampling completeness early left a fully marked run looking
    // unfinished, so a refusal it could never clear would have parked it - the
    // F6 stall rebuilt. The handler reads the checklist at refusal time.
    const markLast = fresh('mark-last', { unattendedCompletion: true });
    assert.equal(mark(markLast, '1').status, 0);
    const lastRow = mark(markLast, 'complete', '--mark-last');
    assert.equal(lastRow.status, 1, lastRow.stdout + lastRow.stderr);
    assert.match(lastRow.stderr, /missing required artifact: artifacts\/report\.md/);
    assert.match(readFileSync(path.join(markLast, 'CHECKLIST.md'), 'utf8'), /\[x\] 2\. Second/);
    assert.equal(status(markLast), 'blocked', 'a run marked to its last row still ends');
  } finally {
    rmSync(gapDir, { recursive: true, force: true });
  }
  console.log('Premature complete and start re-open are refused');
}

// #2234 r1, found by both reviewers: inheriting the stamp was not enough. The
// exit hook that ends an unattended run was gated on `mode === 'autonomous'`
// too, and a role contract carries no mode — the gateway syncs it without one —
// so the stamp the role inherits could never be consulted and the stall stayed
// exactly where it was. This drives the shape the gateway actually writes: a
// scoped role contract with the stamp and no mode.
{
  const roleDir = mkdtempSync(path.join(tmpdir(), 'farmslot-role-unattended-'));
  try {
    mkdirSync(path.join(roleDir, 'inputs'), { recursive: true });
    mkdirSync(path.join(roleDir, 'artifacts'), { recursive: true });
    // The manifest points the mark engine at the role checklist, as a role
    // dispatch does, so `complete` resolves to REVIEW.md and its scoped
    // contract rather than the worker's own.
    writeManifest(roleDir, 'REVIEW.md');
    writeFileSync(path.join(roleDir, 'REVIEW.md'), '- [ ] 1. Read the diff\n');
    writeFileSync(
      path.join(roleDir, terminalContractInputForChecklist('REVIEW.md')),
      JSON.stringify({
        schemaVersion: 1,
        flowType: 'review',
        requireSignal: true,
        // No `mode`: this is what syncTerminalContractForFlowOnSlot writes.
        unattendedCompletion: true,
        commands: {
          complete: {
            report: 'artifacts/review-feedback.md',
            artifacts: ['artifacts/review-feedback.md'],
          },
          'no-change': { artifacts: [] },
          blocked: { artifacts: [] },
        },
        whenPresent: [],
      }),
    );

    const mark = (...args) =>
      spawnSync(process.execPath, [helper, roleDir, ...args], { encoding: 'utf8' });
    assert.equal(mark('1').status, 0);
    // Its required artifact is missing, so completion refuses. With every row
    // marked and nobody attending, that refusal has to end the run.
    const refused = mark('complete');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /missing required artifact: artifacts\/review-feedback\.md/);
    const signal = JSON.parse(readFileSync(path.join(roleDir, 'REVIEW-SIGNAL.json'), 'utf8'));
    assert.equal(signal.status, 'blocked', 'the role refusal ends the run');
    assert.match(String(signal.reason), /review-feedback\.md/);
  } finally {
    rmSync(roleDir, { recursive: true, force: true });
  }
  console.log('A role checklist on an unattended run ends it');
}
