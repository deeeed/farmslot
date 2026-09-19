import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// The acceptance ledger has one definition in @farmslot/protocol and one CJS
// mirror in scripts/acceptance-ledger.cjs, because the mark engine and the `ac`
// CLI are CJS and must run on a slot without a built protocol package. Drift
// would let `ac` write a ledger the gateway panel and the PR body cannot read.
import * as protocol from '@farmslot/protocol/contracts/acceptance';

const require = createRequire(import.meta.url);
const cjs = require('../scripts/acceptance-ledger.cjs');

const SYNC_KEYS = [
  'ACCEPTANCE_STATUS_ARTIFACT',
  'ACCEPTANCE_VERDICTS',
  'ACCEPTANCE_PROOF_MODES',
  'ACCEPTANCE_CRITERION_ID_PATTERN',
];

const LEDGER = {
  schemaVersion: 1,
  criteria: [
    {
      id: 'AC-1',
      text: 'The panel lists every criterion\nwith its verdict | and evidence',
      verdict: 'proven',
      proofMode: 'visual',
      evidence: ['artifacts/after-panel.png'],
      recipeNodes: ['assert-panel', 'screenshot-panel'],
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    {
      id: 'AC-2',
      text: 'A weak verdict blocks the terminal mark',
      verdict: 'weak',
      evidence: [],
      recipeNodes: [],
      note: 'Unit test only.',
      updatedAt: '2026-09-19T10:05:00.000Z',
    },
    {
      id: 'AC-3',
      text: 'No client reaches it yet',
      verdict: 'untestable',
      evidence: [],
      recipeNodes: [],
      updatedAt: '2026-09-19T10:06:00.000Z',
    },
  ],
};

const INVALID = [
  null,
  [],
  {},
  { schemaVersion: 2, criteria: [] },
  { schemaVersion: 1, criteria: {} },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], id: 'AC-0' }] },
  { schemaVersion: 1, criteria: [LEDGER.criteria[0], LEDGER.criteria[0]] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], verdict: 'nope' }] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], proofMode: 'nope' }] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], evidence: [' '] }] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], recipeNodes: 'assert-panel' }] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], note: 7 }] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], text: 7 }] },
  { schemaVersion: 1, criteria: [{ ...LEDGER.criteria[0], updatedAt: '' }] },
];

test('acceptance-ledger.cjs stays aligned with @farmslot/protocol/contracts/acceptance', () => {
  for (const key of SYNC_KEYS) {
    assert.deepEqual(cjs[key], protocol[key], `${key} drifted from the protocol contract`);
  }
  for (let index = 0; index < 4; index += 1) {
    assert.equal(cjs.acceptanceCriterionId(index), protocol.acceptanceCriterionId(index));
  }
  assert.deepEqual(
    cjs.summarizeAcceptanceStatus(LEDGER),
    protocol.summarizeAcceptanceStatus(LEDGER),
  );
  // With the registered criteria, the summary counts what has no verdict yet.
  const registered = [
    { id: 'AC-1', text: LEDGER.criteria[0].text },
    { id: 'AC-2', text: LEDGER.criteria[1].text },
    { id: 'AC-3', text: LEDGER.criteria[2].text },
    { id: 'AC-4', text: 'Not judged yet' },
  ];
  assert.deepEqual(
    cjs.summarizeAcceptanceStatus(LEDGER, registered),
    protocol.summarizeAcceptanceStatus(LEDGER, registered),
  );
  assert.equal(protocol.summarizeAcceptanceStatus(LEDGER, registered).unrecorded, 1);
  assert.equal(protocol.summarizeAcceptanceStatus(LEDGER, registered).total, 4);
  assert.deepEqual(
    cjs.acceptanceCriteriaView(registered, LEDGER),
    protocol.acceptanceCriteriaView(registered, LEDGER),
  );
  assert.deepEqual(
    protocol.acceptanceCriteriaView(registered, LEDGER).map((row) => row.status?.verdict ?? null),
    ['proven', 'weak', 'untestable', null],
  );
  // A ledger entry the handoff no longer lists is still surfaced.
  assert.deepEqual(
    protocol.acceptanceCriteriaView([registered[0]], LEDGER).map((row) => row.id),
    ['AC-1', 'AC-2', 'AC-3'],
  );
  assert.deepEqual(cjs.renderAcceptanceCoverage(LEDGER), protocol.renderAcceptanceCoverage(LEDGER));
  assert.deepEqual(cjs.validateAcceptanceStatusLedger(LEDGER), []);
  for (const value of INVALID) {
    const mirrored = cjs.validateAcceptanceStatusLedger(value);
    assert.deepEqual(
      mirrored,
      protocol.validateAcceptanceStatusLedger(value),
      `validation drifted for ${JSON.stringify(value)}`,
    );
    assert.ok(mirrored.length > 0, `${JSON.stringify(value)} must be rejected`);
  }
});
