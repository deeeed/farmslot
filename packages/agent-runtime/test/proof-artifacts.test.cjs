const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts', 'mark-checklist-step.cjs');
const proofArtifacts = require('../scripts/proof-artifacts.cjs');
const { CHECKLIST_TARGET_MANIFEST } = require('../scripts/checklist-target.cjs');

function task(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `farmslot-proof-${name}-`));
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(dir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'CHECKLIST.md' }, null, 2)}\n`,
  );
  return dir;
}

function writeChecklist(dir, lines) {
  writeFileSync(
    path.join(dir, 'CHECKLIST.md'),
    `# Worker: Proof — DEMO-1\n\n${lines.join('\n')}\n`,
  );
}

function writeContract(dir, contract) {
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  writeFileSync(
    path.join(dir, 'inputs', 'worker-terminal-contract.json'),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
}

const BASELINE = 'artifacts/recipe-baseline-run';
const DECLARED = `- [ ] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`;

// A declaration is read off the row and frozen, exactly as ADR-064 freezes a
// step's command.
{
  const declarations = proofArtifacts.declarations(
    [DECLARED, '- [ ] 2. Something else'].join('\n'),
    'CHECKLIST.md',
  );
  assert.deepEqual(declarations, [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }]);
  const frozen = proofArtifacts.freeze({ schemaVersion: 1 }, DECLARED, 'CHECKLIST.md');
  assert.deepEqual(frozen.proofArtifacts, [
    { checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE },
  ]);
  // A checklist that declares nothing leaves the contract untouched, so an
  // unadopted template keeps today's behaviour.
  const untouched = proofArtifacts.freeze(
    { schemaVersion: 1 },
    '- [ ] 1. Plain step',
    'CHECKLIST.md',
  );
  assert.equal('proofArtifacts' in untouched, false);
}

// A malformed or escaping declaration is a template error, reported where it is.
{
  assert.throws(
    () => proofArtifacts.declarations('- [ ] 1. Broken [PROOF]', 'CHECKLIST.md'),
    /Invalid proof declaration in CHECKLIST.md step 1/,
  );
  for (const bad of ['/etc/passwd', '../outside', '']) {
    assert.throws(
      () => proofArtifacts.declarations(`- [ ] 1. Escapes [PROOF: ${bad}]`, 'CHECKLIST.md'),
      /Invalid proof declaration in CHECKLIST.md step 1/,
      `expected ${bad || 'an empty path'} to be refused`,
    );
  }
}

// Evidence means a path that holds something: an empty directory is the shape of
// a retained run that never ran.
{
  const dir = task('evidence');
  assert.equal(proofArtifacts.evidence(dir, BASELINE).present, false);
  assert.equal(proofArtifacts.evidence(dir, BASELINE).reason, 'missing');
  mkdirSync(path.join(dir, BASELINE), { recursive: true });
  assert.equal(proofArtifacts.evidence(dir, BASELINE).reason, 'empty');
  writeFileSync(path.join(dir, BASELINE, 'trace.json'), '{}\n');
  assert.equal(proofArtifacts.evidence(dir, BASELINE).present, true);
}

// `./mark N` refuses a tick whose evidence is not there, and takes it once it is.
{
  const dir = task('mark');
  writeChecklist(dir, [DECLARED]);
  writeContract(dir, {
    schemaVersion: 1,
    flowType: 'fix-bug',
    requireSignal: true,
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  });

  const refused = spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /step 1 declares its proof at artifacts\/recipe-baseline-run/);
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /- \[ \] 1\./);

  mkdirSync(path.join(dir, BASELINE), { recursive: true });
  writeFileSync(path.join(dir, BASELINE, 'trace.json'), '{"entries":[]}\n');
  const taken = spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' });
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /- \[x\] 1\./);
}

// A step with no declaration is not inspected: the same checklist row without a
// marker ticks with nothing on disk.
{
  const dir = task('undeclared');
  writeChecklist(dir, ['- [ ] 1. Retain the failing baseline run']);
  writeContract(dir, { schemaVersion: 1, flowType: 'fix-bug', requireSignal: true });
  const taken = spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' });
  assert.equal(taken.status, 0, taken.stderr);
}

// Completion issues: the 9b117108 shape — a proof step checked by hand with no
// retained run — and evidence rewritten after the claim.
{
  const dir = task('issues');
  writeChecklist(dir, [`- [x] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`]);
  const contract = {
    schemaVersion: 1,
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  };
  writeFileSync(
    path.join(dir, 'SIGNAL.json'),
    `${JSON.stringify({
      checklistTiming: {
        schemaVersion: 1,
        source: 'CHECKLIST.md',
        events: [
          {
            stepNumber: 1,
            label: '1. Retain the failing baseline run',
            checkedAt: '2026-11-13T19:23:23.060Z',
          },
        ],
      },
    })}\n`,
  );
  const missing = proofArtifacts.issues(dir, 'CHECKLIST.md', contract);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /step 1 is checked but its declared proof .* is missing/);

  // Evidence that appeared after the tick: the claim came first, so the step
  // has to be marked again over the current proof.
  mkdirSync(path.join(dir, BASELINE), { recursive: true });
  const trace = path.join(dir, BASELINE, 'trace.json');
  writeFileSync(trace, '{}\n');
  const after = new Date('2026-11-13T20:05:05.971Z');
  utimesSync(trace, after, after);
  utimesSync(path.join(dir, BASELINE), after, after);
  const late = proofArtifacts.issues(dir, 'CHECKLIST.md', contract);
  assert.equal(late.length, 1);
  // ext4 and APFS round utimes differently, so this pins the second rather than
  // the exact millisecond the fixture asked for.
  assert.match(late[0], /was written 2026-11-13T20:05:05\.\d{3}Z, after the step was marked/);

  // Evidence older than the tick is what the step claimed.
  const before = new Date('2026-11-13T19:20:00.000Z');
  utimesSync(trace, before, before);
  utimesSync(path.join(dir, BASELINE), before, before);
  assert.deepEqual(proofArtifacts.issues(dir, 'CHECKLIST.md', contract), []);
}

// An unchecked declared step is unfinished work, not a completion issue.
{
  const dir = task('unchecked');
  writeChecklist(dir, [DECLARED]);
  assert.deepEqual(
    proofArtifacts.issues(dir, 'CHECKLIST.md', {
      schemaVersion: 1,
      proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
    }),
    [],
  );
}

// Marks recorded after a later-numbered step are kept with the run record. This
// is 9b117108's real order: step 11 was ticked last, after step 21.
{
  const anomalies = proofArtifacts.outOfOrderMarks([
    { stepNumber: 20, checkedAt: '2026-11-13T19:31:40.583Z' },
    { stepNumber: 21, checkedAt: '2026-11-13T20:09:12.822Z' },
    { stepNumber: 11, checkedAt: '2026-11-13T20:09:19.038Z' },
  ]);
  assert.deepEqual(anomalies, [
    { stepNumber: 11, checkedAt: '2026-11-13T20:09:19.038Z', after: 21 },
  ]);
}

// The signal records the out-of-order marks and refuses nothing for them.
{
  const dir = task('order');
  writeChecklist(dir, ['- [ ] 1. First', '- [ ] 2. Second']);
  writeContract(dir, { schemaVersion: 1, flowType: 'fix-bug', requireSignal: true });
  assert.equal(spawnSync(process.execPath, [helper, dir, '2'], { encoding: 'utf8' }).status, 0);
  const second = spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  const signal = JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'));
  assert.deepEqual(
    signal.checklistTiming.outOfOrder.map(({ stepNumber, after }) => ({ stepNumber, after })),
    [{ stepNumber: 1, after: 2 }],
  );
}

// A refused completion on an unattended run ends the run instead of waiting for
// a human who is not watching the batch (run 8cb5aea2's stall).
{
  const dir = task('unattended');
  writeChecklist(dir, [`- [x] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`]);
  writeContract(dir, {
    schemaVersion: 1,
    flowType: 'fix-bug',
    mode: 'autonomous',
    requireSignal: true,
    unattendedCompletion: true,
    acceptance: { require: true },
    commands: {
      complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  });
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Nothing relevant.\n');
  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nDone.\n');

  const refused = spawnSync(process.execPath, [helper, dir, 'complete'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /the refusal above ended it/);
  const signal = JSON.parse(readFileSync(path.join(dir, 'SIGNAL.json'), 'utf8'));
  assert.equal(signal.status, 'blocked');
  // The reason carries the cause, so the trial is scorable as a refusal.
  assert.match(signal.reason, /declared proof artifacts\/recipe-baseline-run is missing/);
}

// The same refusal on an attended run keeps today's behaviour: it refuses and
// leaves the run for its operator.
{
  const dir = task('attended');
  writeChecklist(dir, [`- [x] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`]);
  writeContract(dir, {
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
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  });
  writeFileSync(path.join(dir, 'artifacts', 'learnings.md'), '- Nothing relevant.\n');
  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nDone.\n');

  const refused = spawnSync(process.execPath, [helper, dir, 'complete'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has no operator: a refused completion reaches no gate/);
  // Nothing terminal was written: the refusal left the run as it was, for its
  // operator to resolve.
  assert.equal(existsSync(path.join(dir, 'SIGNAL.json')), false);
}

// A reviewer answers for its own checklist only. Completing REVIEW.md must not
// refuse because the worker's CHECKLIST.md has an unproven proof step: that is
// the thing the reviewer is reporting on.
{
  const dir = task('reviewer');
  const contract = {
    schemaVersion: 1,
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  };
  writeChecklist(dir, [`- [x] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`]);
  writeFileSync(path.join(dir, 'REVIEW.md'), '# Reviewer\n\n- [x] 1. Report findings\n');
  assert.equal(proofArtifacts.issues(dir, 'CHECKLIST.md', contract).length, 1);
  assert.deepEqual(proofArtifacts.issues(dir, 'REVIEW.md', contract), []);
}

// Evidence reached through a symlink out of the task directory is not evidence:
// a populated directory the run never produced cannot stand in for the proof.
{
  const dir = task('symlink');
  const outside = mkdtempSync(path.join(tmpdir(), 'farmslot-proof-outside-'));
  mkdirSync(path.join(outside, 'run'), { recursive: true });
  writeFileSync(path.join(outside, 'run', 'trace.json'), '{"entries":[]}\n');
  symlinkSync(path.join(outside, 'run'), path.join(dir, BASELINE));
  const evidence = proofArtifacts.evidence(dir, BASELINE);
  assert.equal(evidence.present, false);
  assert.equal(evidence.reason, 'outside');
  writeChecklist(dir, [`- [x] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`]);
  const issues = proofArtifacts.issues(dir, 'CHECKLIST.md', {
    schemaVersion: 1,
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /outside the task directory/);
}

// Repairing the proof after the claim: completion refuses until the step is
// marked again, and the re-mark restates it. One helper decides that for both
// the mark path and completion.
{
  const dir = task('remark');
  const contract = {
    schemaVersion: 1,
    flowType: 'fix-bug',
    requireSignal: true,
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  };
  writeChecklist(dir, [DECLARED]);
  writeContract(dir, contract);
  mkdirSync(path.join(dir, BASELINE), { recursive: true });
  writeFileSync(path.join(dir, BASELINE, 'trace.json'), '{"entries":[]}\n');
  assert.equal(spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' }).status, 0);
  const signalPath = path.join(dir, 'SIGNAL.json');
  const first = JSON.parse(readFileSync(signalPath, 'utf8'));
  assert.equal(first.checklistTiming.events[0].remarkedAt, undefined);
  assert.deepEqual(proofArtifacts.issues(dir, 'CHECKLIST.md', contract), []);

  // Rewind the recorded claim so the evidence on disk is the newer of the two,
  // which is the shape of a proof rebuilt after its step was checked.
  // Relative to the evidence, not to the clock: a cold `mark` can take over a
  // second, which would leave the rewound claim still newer than the proof.
  const claimedAt = new Date(proofArtifacts.evidence(dir, BASELINE).mtimeMs - 1000);
  writeFileSync(
    signalPath,
    `${JSON.stringify(
      {
        ...first,
        checklistTiming: {
          ...first.checklistTiming,
          events: [{ ...first.checklistTiming.events[0], checkedAt: claimedAt.toISOString() }],
        },
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(proofArtifacts.issues(dir, 'CHECKLIST.md', contract).length, 1);

  const again = spawnSync(process.execPath, [helper, dir, '1'], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  const refreshed = JSON.parse(readFileSync(signalPath, 'utf8'));
  assert.equal(typeof refreshed.checklistTiming.events[0].remarkedAt, 'string');
  assert.deepEqual(proofArtifacts.issues(dir, 'CHECKLIST.md', contract), []);
}

// The same rule through the completion checker, which is the path a terminal
// mark actually takes. A reviewer completing REVIEW.md passes while the worker's
// CHECKLIST.md carries a checked, unproven declaration, and the reviewer's own
// declaration still refuses it.
{
  const checker = path.join(root, 'scripts', 'check-task-artifact-contract.mjs');
  const run = (dir, checklist) =>
    spawnSync(
      process.execPath,
      [
        checker,
        dir,
        '--contract',
        path.join(dir, 'inputs', 'worker-terminal-contract.json'),
        '--terminal',
        'complete',
        '--proof-checklist',
        checklist,
      ],
      { encoding: 'utf8' },
    );

  const dir = task('checker-reviewer');
  // The manifest deliberately names the worker checklist: the caller's own
  // selection has to win, because a role completion may not have written one.
  writeFileSync(
    path.join(dir, CHECKLIST_TARGET_MANIFEST),
    `${JSON.stringify({ checklist: 'CHECKLIST.md' }, null, 2)}\n`,
  );
  writeChecklist(dir, [`- [x] 1. Retain the failing baseline run [PROOF: ${BASELINE}]`]);
  writeFileSync(path.join(dir, 'REVIEW.md'), '# Reviewer\n\n- [x] 1. Report findings\n');
  writeFileSync(path.join(dir, 'artifacts', 'report.md'), '# Report\n\nREQUEST_CHANGES.\n');
  writeContract(dir, {
    schemaVersion: 1,
    flowType: 'review',
    requireSignal: true,
    commands: {
      complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
    whenPresent: [],
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  });

  const reviewer = run(dir, 'REVIEW.md');
  assert.equal(reviewer.status, 0, reviewer.stdout + reviewer.stderr);
  assert.match(reviewer.stdout, /TASK_ARTIFACT_CONTRACT_PASS/);

  const worker = run(dir, 'CHECKLIST.md');
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /CHECKLIST\.md step 1 is checked but its declared proof/);

  // A declaration on the reviewer's own checklist still binds its completion.
  writeFileSync(
    path.join(dir, 'REVIEW.md'),
    `# Reviewer\n\n- [x] 1. Rerun the proof [PROOF: ${BASELINE}]\n`,
  );
  const ownDeclaration = run(dir, 'REVIEW.md');
  assert.equal(ownDeclaration.status, 1);
  assert.match(ownDeclaration.stderr, /REVIEW\.md step 1 is checked but its declared proof/);
}

// A run using the documented `--signal` escape hatch keeps its claims there, so
// the freshness decision has to read that file and not a derived name.
{
  const dir = task('custom-signal');
  const contract = {
    schemaVersion: 1,
    flowType: 'fix-bug',
    requireSignal: true,
    proofArtifacts: [{ checklist: 'CHECKLIST.md', stepNumber: 1, path: BASELINE }],
  };
  writeChecklist(dir, [DECLARED]);
  writeContract(dir, contract);
  mkdirSync(path.join(dir, BASELINE), { recursive: true });
  writeFileSync(path.join(dir, BASELINE, 'trace.json'), '{"entries":[]}\n');
  const marked = spawnSync(
    process.execPath,
    [helper, dir, '--checklist', 'CHECKLIST.md', '--signal', 'custom.json', '1'],
    { encoding: 'utf8' },
  );
  assert.equal(marked.status, 0, marked.stderr);
  const custom = path.join(dir, 'custom.json');
  const first = JSON.parse(readFileSync(custom, 'utf8'));
  assert.equal(existsSync(path.join(dir, 'SIGNAL.json')), false);

  const claimedAt = new Date(proofArtifacts.evidence(dir, BASELINE).mtimeMs - 1000);
  writeFileSync(
    custom,
    `${JSON.stringify(
      {
        ...first,
        checklistTiming: {
          ...first.checklistTiming,
          events: [{ ...first.checklistTiming.events[0], checkedAt: claimedAt.toISOString() }],
        },
      },
      null,
      2,
    )}\n`,
  );
  // Reading the selected signal finds the claim; the derived name has none.
  assert.equal(
    proofArtifacts.issues(dir, 'CHECKLIST.md', contract, 'custom.json').length,
    1,
    'the selected signal holds the claim this step was marked with',
  );
  const again = spawnSync(
    process.execPath,
    [helper, dir, '--checklist', 'CHECKLIST.md', '--signal', 'custom.json', '1'],
    { encoding: 'utf8' },
  );
  assert.equal(again.status, 0, again.stderr);
  const refreshed = JSON.parse(readFileSync(custom, 'utf8'));
  assert.equal(typeof refreshed.checklistTiming.events[0].remarkedAt, 'string');
  assert.deepEqual(proofArtifacts.issues(dir, 'CHECKLIST.md', contract, 'custom.json'), []);
}

// A directory of symlinks is not proof: the files have to be the run's own.
{
  const dir = task('child-symlink');
  const outside = mkdtempSync(path.join(tmpdir(), 'farmslot-proof-child-'));
  writeFileSync(path.join(outside, 'trace.json'), '{"entries":[]}\n');
  mkdirSync(path.join(dir, BASELINE), { recursive: true });
  symlinkSync(path.join(outside, 'trace.json'), path.join(dir, BASELINE, 'trace.json'));
  const evidence = proofArtifacts.evidence(dir, BASELINE);
  assert.equal(evidence.present, false);
  assert.equal(evidence.reason, 'empty');
}

console.log('proof-artifacts tests passed');
