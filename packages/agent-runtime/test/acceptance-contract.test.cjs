const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { effectiveAcceptanceContract } = require('../scripts/acceptance-contract.cjs');
const { acceptanceContractIssues } = require('../scripts/acceptance-ledger.cjs');
const { engineClaims } = require('./acceptance-fixtures.cjs');

function fixture(t, mode = 'state') {
  const dir = mkdtempSync(path.join(tmpdir(), 'acceptance-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'inputs/acceptance-contracts'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'));
  writeFileSync(
    path.join(dir, 'inputs/handoff.json'),
    JSON.stringify({ attemptId: 'run-1', task: { acceptanceCriteria: ['Original'] } }),
  );
  const base = {
    schemaVersion: 1,
    acceptanceContractVersion: 1,
    flowType: 'pr-complete',
    commands: {},
  };
  const baseBytes = JSON.stringify(base);
  const revision = {
    schemaVersion: 1,
    runId: 'run-1',
    revision: 1,
    registrationRevision: 0,
    baseContractHash: createHash('sha256').update(baseBytes).digest('hex'),
    proofModes: [{ id: 'AC-1', text: 'Original', proofMode: mode }],
    claimReviewGate: ['visual', 'mixed'].includes(mode),
    publicationReview: mode === 'review',
  };
  const project = () => {
    const text = JSON.stringify(revision);
    writeFileSync(path.join(dir, 'inputs/acceptance-contracts/1.json'), text);
    writeFileSync(path.join(dir, 'inputs/acceptance-contract.json'), text);
  };
  project();
  const ledger = engineClaims(['Original'], [mode === 'state' ? 'proven' : 'awaiting-review']);
  ledger.criteria[0].proofMode = mode;
  writeFileSync(path.join(dir, 'artifacts/acceptance-status.json'), JSON.stringify(ledger));
  return { dir, base, baseBytes, revision, project, ledger };
}

test('effective proof destinations support every mode without changing the frozen base', (t) => {
  for (const mode of ['state', 'visual', 'mixed', 'review']) {
    const { dir, base, baseBytes } = fixture(t, mode);
    const effective = effectiveAcceptanceContract(dir, base, baseBytes);
    assert.equal(effective.claimReviewGate, mode === 'visual' || mode === 'mixed');
    assert.equal(effective.publicationReview, mode === 'review');
    assert.equal(base.claimReviewGate, undefined);
    assert.deepEqual(effective.acceptanceReviewCriteria, mode === 'review' ? ['AC-1'] : []);
  }
});

test('review deferral permits only the scheduled criterion and leaves state failures blocking', (t) => {
  const { dir, ledger } = fixture(t, 'review');
  assert.match(acceptanceContractIssues(dir).join(';'), /awaiting-review/);
  assert.deepEqual(acceptanceContractIssues(dir, { deferReviewCriteria: ['AC-1'] }), []);
  ledger.criteria[0].proofMode = 'state';
  ledger.criteria[0].verdict = 'failed';
  writeFileSync(path.join(dir, 'artifacts/acceptance-status.json'), JSON.stringify(ledger));
  assert.match(
    acceptanceContractIssues(dir, { deferReviewCriteria: ['AC-1'] }).join(';'),
    /failed/,
  );
});

test('stale, wrong-run, changed-base and changed immutable revisions refuse explicitly', (t) => {
  const { dir, base, baseBytes, revision, project } = fixture(t);
  assert.throws(
    () => effectiveAcceptanceContract(dir, { ...base, acceptanceContractVersion: 2 }, baseBytes),
    /Unsupported/,
  );
  assert.throws(() => effectiveAcceptanceContract(dir, base, baseBytes + '\n'), /frozen base/);
  revision.runId = 'foreign';
  project();
  assert.throws(() => effectiveAcceptanceContract(dir, base, baseBytes), /identity/);
  revision.runId = 'run-1';
  project();
  writeFileSync(path.join(dir, 'inputs/acceptance-contracts/1.json'), '{}');
  assert.throws(() => effectiveAcceptanceContract(dir, base, baseBytes), /revision was changed/);
});

test('changing a declared proof mode needs a new confirmed revision', (t) => {
  const { dir, base, baseBytes, ledger } = fixture(t);
  ledger.criteria[0].proofMode = 'visual';
  writeFileSync(path.join(dir, 'artifacts/acceptance-status.json'), JSON.stringify(ledger));
  assert.throws(() => effectiveAcceptanceContract(dir, base, baseBytes), /proof mode changed/);
  assert.equal(
    readFileSync(path.join(dir, 'inputs/acceptance-contract.json'), 'utf8').includes(
      '"revision":1',
    ),
    true,
  );
});

test('a review-fix contract keeps its artifacts and reads the root policy revision', (t) => {
  const { dir, base, baseBytes } = fixture(t, 'visual');
  writeFileSync(path.join(dir, 'inputs/worker-terminal-contract.json'), baseBytes);
  const role = {
    ...base,
    flowType: 'review-fix',
    acceptanceParentContract: 'inputs/worker-terminal-contract.json',
    commands: { complete: { artifacts: ['artifacts/fix-report.md'] } },
  };
  const effective = effectiveAcceptanceContract(dir, role, JSON.stringify(role));
  assert.equal(effective.claimReviewGate, true);
  assert.deepEqual(effective.commands, role.commands);
});

test('legacy opted-out contracts keep their original policy for every proof mode', (t) => {
  for (const mode of ['state', 'visual', 'mixed', 'review']) {
    const { dir, base, baseBytes } = fixture(t, mode);
    const legacy = {
      ...base,
      acceptanceContractVersion: undefined,
      claimReviewGate: false,
      publicationReview: false,
    };
    assert.strictEqual(effectiveAcceptanceContract(dir, legacy, baseBytes), legacy);
    assert.equal(legacy.claimReviewGate, false);
    assert.equal(legacy.publicationReview, false);
  }
});
