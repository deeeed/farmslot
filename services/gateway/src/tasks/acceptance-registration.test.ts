import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AcceptanceDerivationResult,
  AcceptanceDerivationSource,
  AcceptanceRegistration,
} from '@farmslot/protocol';

import {
  acceptAcceptanceDerivation,
  acceptanceDerivationPending,
  admitAcceptanceInstruction,
  initializeAcceptanceRegistration,
  parseAcceptanceDerivationResult,
} from './acceptance-registration.js';

const sources: AcceptanceDerivationSource[] = [
  {
    id: 'github:thread:1:comment:2',
    kind: 'review-comment',
    body: 'Fix stale price',
    version: 'v1',
    url: 'https://example.test/comments/2',
  },
  {
    id: 'dispatch:1',
    kind: 'instruction',
    body: 'Preserve the existing fee and prove the switch',
    version: 'v1',
  },
];
const intake = {
  provider: 'github' as const,
  repository: 'example/repo',
  prNumber: 1,
  headSha: 'a'.repeat(40),
  capturedAt: '2026-10-25T00:00:00Z',
};

function registration(): AcceptanceRegistration {
  return initializeAcceptanceRegistration(
    'run-1',
    [{ id: 'AC-1', text: 'Original ticket criterion' }],
    sources,
    intake,
  );
}

function result(): AcceptanceDerivationResult {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    generation: 3,
    registrationRevision: 1,
    unitId: 'derive-acceptance',
    classifications: [
      {
        sourceId: sources[0].id,
        sourceVersion: 'v1',
        obligations: [{ text: 'Switching markets refreshes the price', proofMode: 'state' }],
      },
      {
        sourceId: sources[1].id,
        sourceVersion: 'v1',
        obligations: [
          { text: 'Fees remain correct', proofMode: 'review' },
          { text: 'Show the switched market', proofMode: 'visual' },
        ],
      },
    ],
  };
}

test('derivation extends the original list with source-linked ACs and no verdicts', () => {
  const before = registration();
  const after = acceptAcceptanceDerivation(before, result(), 3);
  assert.deepEqual(after.original, before.original);
  assert.equal(before.revision, 1);
  assert.equal(after.revision, 2);
  assert.deepEqual(
    after.derived.map(({ id }) => id),
    ['AC-2', 'AC-3', 'AC-4'],
  );
  assert.equal(after.derived[0].source.url, sources[0].url);
  assert.deepEqual(
    after.derived.map(({ source }) => source.obligationIndex),
    [0, 0, 1],
  );
  assert.ok(after.derived.every((row) => !('verdict' in row)));
  assert.equal(acceptanceDerivationPending(after), false);
  assert.strictEqual(acceptAcceptanceDerivation(after, result(), 3), after);
});

test('a restarted owner reuses the stored classification and IDs', () => {
  const accepted = acceptAcceptanceDerivation(registration(), result(), 3);
  const restarted: AcceptanceRegistration = JSON.parse(JSON.stringify(accepted));
  assert.deepEqual(acceptAcceptanceDerivation(restarted, result(), 3), accepted);
  const changed = result();
  changed.classifications[0].obligations[0].text = 'Different requirement';
  assert.throws(() => acceptAcceptanceDerivation(restarted, changed, 3), /cannot be rewritten/);
});

test('coverage rejects missing, duplicate, invented and changed sources', () => {
  for (const change of ['missing', 'duplicate', 'invented', 'version'] as const) {
    const proposal = result();
    if (change === 'missing') proposal.classifications.pop();
    if (change === 'duplicate') proposal.classifications[1] = proposal.classifications[0];
    if (change === 'invented') proposal.classifications[1].sourceId = 'foreign';
    if (change === 'version') proposal.classifications[0].sourceVersion = 'v2';
    assert.throws(() => acceptAcceptanceDerivation(registration(), proposal, 3), /source/);
  }
});

test('one actionable comment produces one AC; resolved comments require an exclusion', () => {
  const proposal = result();
  proposal.classifications[0].obligations.push({ text: 'Extra', proofMode: 'state' });
  assert.throws(() => acceptAcceptanceDerivation(registration(), proposal, 3), /one criterion/);
  const resolved = registration();
  resolved.units[0].sources = sources.map((source) => ({ ...source, resolved: true }));
  assert.throws(() => acceptAcceptanceDerivation(resolved, result(), 3), /resolved comment/);
  const excluded = result();
  excluded.classifications = excluded.classifications.map((row) => ({
    ...row,
    obligations: [],
    exclusion: 'Already resolved or no extra obligation',
  }));
  const after = acceptAcceptanceDerivation(resolved, excluded, 3);
  assert.equal(after.derived.length, 0);
  assert.equal(acceptanceDerivationPending(after), false);
});

test('worker replies refuse the wrong run, generation and registration revision', () => {
  for (const change of [{ runId: 'foreign' }, { generation: 2 }, { registrationRevision: 0 }]) {
    assert.throws(
      () => acceptAcceptanceDerivation(registration(), { ...result(), ...change }, 3),
      /wrong run|stale|changed/,
    );
  }
});

test('interactive instructions append a distinct pending child and invalidate old readiness', () => {
  const settled = acceptAcceptanceDerivation(registration(), result(), 3);
  const unit = {
    id: 'derive-message-7',
    sources: [
      {
        id: 'message:7',
        kind: 'instruction' as const,
        body: 'Also retain the balance',
        version: 'v1',
      },
    ],
  };
  const pending = admitAcceptanceInstruction(settled, unit);
  assert.equal(pending.revision, 3);
  assert.equal(acceptanceDerivationPending(pending), true);
  assert.deepEqual(pending.units[0], settled.units[0]);
  assert.strictEqual(admitAcceptanceInstruction(pending, unit), pending);
  assert.throws(
    () =>
      admitAcceptanceInstruction(pending, {
        ...unit,
        sources: [{ ...unit.sources[0], body: 'Changed steer' }],
      }),
    /changed contents/,
  );
  const append: AcceptanceDerivationResult = {
    ...result(),
    registrationRevision: 3,
    unitId: unit.id,
    classifications: [
      {
        sourceId: 'message:7',
        sourceVersion: 'v1',
        obligations: [{ text: 'Retain the balance', proofMode: 'mixed' }],
      },
    ],
  };
  const after = acceptAcceptanceDerivation(pending, append, 3);
  assert.equal(after.derived.at(-1)?.id, 'AC-5');
  assert.equal(after.revision, 4);
  assert.equal(acceptanceDerivationPending(after), false);
});

test('a zero-obligation steer settles without adding a criterion', () => {
  const original = initializeAcceptanceRegistration('run-1', [], [], intake);
  const proposal = { ...result(), classifications: [] };
  const after = acceptAcceptanceDerivation(original, proposal, 3);
  assert.equal(after.revision, 2);
  assert.deepEqual(after.derived, []);
});

test('typed boundary names malformed obligation and classification fields', () => {
  assert.deepEqual(parseAcceptanceDerivationResult(result()), result());
  assert.throws(
    () =>
      parseAcceptanceDerivationResult({
        ...result(),
        classifications: [{ sourceId: 'x', sourceVersion: 'v1', obligations: [] }],
      }),
    /exclusion/,
  );
  assert.throws(
    () =>
      parseAcceptanceDerivationResult({
        ...result(),
        classifications: [
          { sourceId: 'x', sourceVersion: 'v1', obligations: [{ text: 'x', proofMode: 'magic' }] },
        ],
      }),
    /proofMode/,
  );
  assert.throws(
    () => parseAcceptanceDerivationResult({ ...result(), generation: -1 }),
    /generation/,
  );
});
