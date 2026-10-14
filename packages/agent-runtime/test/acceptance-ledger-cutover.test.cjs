const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AcceptanceRefusal,
  acceptanceContractIssues,
  readAcceptanceLedger,
  setDerivedClaims,
  writeAcceptanceLedger,
} = require('../scripts/acceptance-ledger.cjs');
const { main: acceptanceCli } = require('../scripts/acceptance-cli.cjs');

// Reduced retained shapes: one four-criterion task beside a recorded attempt,
// and two three-criterion tasks without a recorded claim ledger. Criterion text
// and evidence contents are synthetic. Schema 1 has no execution or moments.
const RETAINED_SHAPES = [
  { name: 'task beside a recorded attempt', count: 4 },
  { name: 'task with summary but no claim ledger', count: 3 },
  { name: 'task with media inventory but no claim ledger', count: 3 },
];
const LEDGER_ARTIFACT = path.join('artifacts', 'acceptance-status.json');

function legacyLedger(count = 1) {
  return {
    schemaVersion: 1,
    criteria: Array.from({ length: count }, (_, index) => ({
      id: `AC-${index + 1}`,
      text: `Registered behavior ${index + 1}`,
      verdict: 'proven',
      evidence: ['artifacts/proof.txt'],
      recipeNodes: [],
      updatedAt: '2026-10-12T10:00:00.000Z',
    })),
  };
}

function engineLedger() {
  return {
    schemaVersion: 2,
    recipeRunId: 'engine-execution',
    recording: { status: 'not-required', segments: [] },
    criteria: [
      {
        id: 'AC-1',
        text: 'Registered behavior 1',
        kind: 'acceptance',
        verdict: 'proven',
        proofMode: 'state',
        evidence: ['artifacts/proof.txt'],
        recipeNodes: ['assert-command-exit'],
        assertionIndices: [1],
        moments: [],
      },
    ],
  };
}

function taskFixture(t, stored = null, count = 1) {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'acceptance-cutover-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(taskDir, 'inputs', 'handoff.json'),
    JSON.stringify({
      task: { acceptanceCriteria: legacyLedger(count).criteria.map((row) => row.text) },
    }),
  );
  writeFileSync(path.join(taskDir, 'artifacts', 'proof.txt'), 'observed command output\n');
  if (stored) writeFileSync(path.join(taskDir, LEDGER_ARTIFACT), JSON.stringify(stored));
  return taskDir;
}

function fileBytes(taskDir) {
  const file = path.join(taskDir, LEDGER_ARTIFACT);
  return existsSync(file) ? readFileSync(file) : null;
}

const writerRefusal = (error) =>
  error instanceof AcceptanceRefusal && /engine|schema.?2|legacy|human/i.test(error.message);

for (const storedKind of ['absent', 'legacy']) {
  for (const verdict of ['proven', 'weak', 'missing', 'failed', 'awaiting-review', 'untestable']) {
    test(`manual ${verdict} cannot write the ${storedKind} task ledger`, (t) => {
      const taskDir = taskFixture(t, storedKind === 'legacy' ? legacyLedger() : null);
      const before = fileBytes(taskDir);
      assert.throws(
        () =>
          acceptanceCli([
            'set',
            'AC-1',
            verdict,
            '--task-dir',
            taskDir,
            '--actor',
            'worker-supplied-identity',
            '--note',
            'A worker-supplied reason grants no gateway authority.',
          ]),
        writerRefusal,
      );
      assert.deepEqual(fileBytes(taskDir), before, 'refusal preserves existing bytes');
    });
  }
}

for (const storedKind of ['absent', 'engine']) {
  test(`the shared task writer rejects schema 1 with the ${storedKind} ledger`, (t) => {
    const taskDir = taskFixture(t, storedKind === 'engine' ? engineLedger() : null);
    const before = fileBytes(taskDir);
    assert.throws(() => writeAcceptanceLedger(taskDir, legacyLedger()), writerRefusal);
    assert.deepEqual(fileBytes(taskDir), before, 'a rejected schema cannot replace engine bytes');
  });
}

for (const shape of RETAINED_SHAPES) {
  test(`retained ${shape.name} cannot satisfy current completion`, (t) => {
    const stored = legacyLedger(shape.count);
    const taskDir = taskFixture(t, stored, shape.count);
    const before = fileBytes(taskDir);
    const issues = acceptanceContractIssues(taskDir, { deferClaimVerdicts: true, allowWeak: true });
    assert.ok(issues.length > 0, 'a complete schema-1 verdict table is display-only');
    assert.match(issues.join('\n'), /legacy|schema.?2|engine|selected.*recipe/i);
    assert.deepEqual(fileBytes(taskDir), before, 'completion checks never migrate retained bytes');
  });
}

test('missing-ledger recovery names recipe proof rather than a manual writer', (t) => {
  const taskDir = taskFixture(t);
  const issues = acceptanceContractIssues(taskDir);
  assert.ok(issues.length > 0);
  assert.doesNotMatch(issues.join('\n'), /ac set/);
  assert.match(issues.join('\n'), /recipe|engine/i);
});

test('missing-claim recovery names recipe proof rather than a manual writer', (t) => {
  const taskDir = taskFixture(t, { ...engineLedger(), criteria: [] });
  const issues = acceptanceContractIssues(taskDir);
  assert.ok(issues.length > 0);
  assert.doesNotMatch(issues.join('\n'), /ac set/);
  assert.match(issues.join('\n'), /recipe|engine/i);
});

test('a registered headless engine projection retains execution and claim fields', (t) => {
  const taskDir = taskFixture(t);
  const claims = engineLedger();
  assert.deepEqual(setDerivedClaims(taskDir, claims), claims);
  assert.deepEqual(readAcceptanceLedger(taskDir), claims);
  assert.deepEqual(acceptanceContractIssues(taskDir), []);
});

test('a recorded engine projection preserves its segment identity and moment references', (t) => {
  const taskDir = taskFixture(t);
  const claims = engineLedger();
  const videoDigest = `sha256:${'a'.repeat(64)}`;
  claims.recording = {
    status: 'complete',
    segments: [
      {
        videoPath: 'videos/recording.mp4',
        videoDigest,
        timelinePath: 'videos/recording.mp4.timeline.json',
      },
    ],
  };
  claims.criteria[0].moments = [{ recipeRunId: claims.recipeRunId, videoDigest, traceIndex: 1 }];
  setDerivedClaims(taskDir, claims);
  assert.deepEqual(readAcceptanceLedger(taskDir), claims);
  assert.deepEqual(acceptanceContractIssues(taskDir), []);
});

for (const verdict of ['proven', 'untestable']) {
  test(`local ${verdict} cannot change an engine projection`, (t) => {
    const taskDir = taskFixture(t, engineLedger());
    const before = fileBytes(taskDir);
    assert.throws(
      () =>
        acceptanceCli([
          'set',
          'AC-1',
          verdict,
          '--task-dir',
          taskDir,
          '--actor',
          'worker-supplied-identity',
        ]),
      writerRefusal,
    );
    assert.deepEqual(fileBytes(taskDir), before);
  });
}

test('engine projection refuses a legacy ledger and preserves the selected projection', (t) => {
  const taskDir = taskFixture(t, engineLedger());
  const before = fileBytes(taskDir);
  assert.throws(() => setDerivedClaims(taskDir, legacyLedger()), writerRefusal);
  assert.deepEqual(fileBytes(taskDir), before);
});

test('engine projection refuses a mismatched registered criterion', (t) => {
  const taskDir = taskFixture(t, engineLedger());
  const before = fileBytes(taskDir);
  const claims = engineLedger();
  claims.criteria[0].text = 'Different behavior';
  assert.throws(() => setDerivedClaims(taskDir, claims), /does not match the registered task/);
  assert.deepEqual(fileBytes(taskDir), before);
});

test('retained legacy display reads preserve the original ledger without invented moments', (t) => {
  const stored = legacyLedger();
  const taskDir = taskFixture(t, stored);
  const before = fileBytes(taskDir);
  assert.deepEqual(readAcceptanceLedger(taskDir), stored);
  assert.equal(readAcceptanceLedger(taskDir).criteria[0].moments, undefined);
  assert.deepEqual(fileBytes(taskDir), before);
});
