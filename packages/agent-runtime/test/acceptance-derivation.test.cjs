const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { registeredAcceptanceCriteria } = require('@farmslot/protocol/scripts/acceptance.mjs');
const {
  acceptanceContractIssues,
  handoffAcceptanceCriteria,
  setDerivedClaims,
} = require('../scripts/acceptance-ledger.cjs');
const { engineClaims } = require('./acceptance-fixtures.cjs');
const { runSubtaskCommand } = require('../scripts/subtask-unit.cjs');

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acceptance-derive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'inputs'));
  writeFileSync(
    path.join(dir, 'CHECKLIST.md'),
    '# Complete PR\n\n## Work\n\n- [ ] **1. Derive acceptance**\n- [ ] **2. Fix**\n',
  );
  writeFileSync(
    path.join(dir, 'inputs/handoff.json'),
    JSON.stringify({
      attemptId: 'run-1',
      project: 'example',
      flow: 'pr-complete',
      executionTemplate: { firstSubtask: 'derive-acceptance' },
      task: { acceptanceCriteria: ['Original'] },
    }),
  );
  const registration = {
    schemaVersion: 1,
    runId: 'run-1',
    revision: 1,
    original: [{ id: 'AC-1', text: 'Original' }],
    derived: [],
    units: [{ id: 'derive-acceptance', sources: [] }],
  };
  const project = () =>
    writeFileSync(
      path.join(dir, 'inputs/acceptance-registration.json'),
      JSON.stringify({ schemaVersion: 1, generation: 3, registration }),
    );
  project();
  return { dir, registration, project };
}

test('shared projection preserves original rows and rejects changed or invented AC identities', () => {
  const registration = {
    schemaVersion: 1,
    revision: 2,
    original: [{ id: 'AC-1', text: 'Original' }],
    units: [],
    derived: [
      {
        id: 'AC-2',
        text: 'Fix review',
        proofMode: 'review',
        source: {
          kind: 'review-comment',
          sourceId: 'comment:1',
          sourceVersion: 'v1',
          obligationIndex: 0,
        },
      },
    ],
  };
  assert.deepEqual(
    registeredAcceptanceCriteria(['Original'], registration).map(({ id }) => id),
    ['AC-1', 'AC-2'],
  );
  assert.throws(() => registeredAcceptanceCriteria(['Changed'], registration), /original criteria/);
  assert.throws(
    () =>
      registeredAcceptanceCriteria(['Original'], {
        ...registration,
        derived: [{ ...registration.derived[0], id: 'AC-7' }],
      }),
    /derived criterion/,
  );
});

test('child completion waits for the gateway acknowledgement before ticking its parent', (t) => {
  const { dir, registration, project } = fixture(t);
  assert.equal(
    runSubtaskCommand(dir, [
      'start',
      'derive-acceptance',
      '--step',
      '1',
      '--from',
      'inline:# Derive\n\n- [ ] **1. Classify sources**',
    ]),
    0,
  );
  const result = {
    schemaVersion: 1,
    runId: 'run-1',
    generation: 3,
    registrationRevision: 1,
    unitId: 'derive-acceptance',
    classifications: [],
  };
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  const command = [
    'derive-acceptance',
    'complete',
    '--mark-last',
    '--acceptance-result',
    'result.json',
  ];
  assert.equal(runSubtaskCommand(dir, command), 1);
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /\[ \] \*\*1\./);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, 'subtasks/derive-acceptance-SIGNAL.json'), 'utf8'))
      .acceptanceDerivation,
    result,
  );
  assert.match(acceptanceContractIssues(dir).join(';'), /derivation.*pending/);
  registration.units[0].result = result;
  registration.revision = 2;
  project();
  assert.equal(runSubtaskCommand(dir, command), 0);
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /\[x\] \*\*1\./);
  assert.deepEqual(handoffAcceptanceCriteria(dir), [{ id: 'AC-1', text: 'Original' }]);
});

test('opted-out children cannot append and a missing opted-in projection refuses', (t) => {
  const { dir } = fixture(t);
  writeFileSync(path.join(dir, 'inputs/acceptance-registration.json'), '{}');
  assert.throws(() => handoffAcceptanceCriteria(dir), /transport is missing/);
});

test('the declared derivation is the first child and cannot be bypassed by marking later steps', (t) => {
  const { dir } = fixture(t);
  assert.equal(
    runSubtaskCommand(dir, ['start', 'skip-derive', '--step', '2', '--from', 'inline:- [ ] Fix']),
    1,
  );
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../scripts/mark-checklist-step.cjs'), dir, '2'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /derive-acceptance/);
  assert.match(readFileSync(path.join(dir, 'CHECKLIST.md'), 'utf8'), /\[ \] \*\*2\./);
});

test('original evidence coexists with required derived proof without changing parent references', (t) => {
  const { dir, registration, project } = fixture(t);
  registration.units[0].result = {
    schemaVersion: 1,
    runId: 'run-1',
    unitId: 'derive-acceptance',
    generation: 3,
    registrationRevision: 1,
    classifications: [],
  };
  registration.derived = [
    {
      id: 'AC-2',
      text: 'Fresh obligation',
      proofMode: 'state',
      source: {
        kind: 'instruction',
        sourceId: 'message:1',
        sourceVersion: 'v1',
        obligationIndex: 0,
      },
    },
  ];
  registration.revision = 2;
  project();
  const reference = {
    schemaVersion: 1,
    source: 'parent-run',
    childRunId: 'run-1',
    project: 'example',
    parentRunId: 'parent',
    headSha: 'a'.repeat(40),
    ledgerHash: 'b'.repeat(64),
    criteria: registration.original,
  };
  const referencePath = path.join(dir, 'inputs/inherited-acceptance.json');
  const before = JSON.stringify(reference);
  writeFileSync(referencePath, before);
  const claims = engineClaims(['Fresh obligation']);
  claims.criteria[0].id = 'AC-2';
  setDerivedClaims(dir, claims);
  assert.deepEqual(acceptanceContractIssues(dir), []);
  assert.equal(readFileSync(referencePath, 'utf8'), before);
  assert.deepEqual(acceptanceContractIssues(dir, { requireFresh: true }), []);
  writeFileSync(
    path.join(dir, 'artifacts/acceptance-status.json'),
    JSON.stringify({ ...claims, criteria: [] }),
  );
  assert.match(acceptanceContractIssues(dir).join(';'), /AC-2 has no engine verdict/);
  writeFileSync(
    referencePath,
    JSON.stringify({ ...reference, criteria: [...registration.original, ...registration.derived] }),
  );
  assert.match(acceptanceContractIssues(dir).join(';'), /does not match/);
});
