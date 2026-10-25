import assert from 'node:assert/strict';
import test from 'node:test';

import type { AcceptanceRegistration, AcceptanceStatusLedger } from '@farmslot/protocol';

import { acceptanceClaimRows } from '../src/publication-gate.js';
import { acceptancePanelPresentation } from '../src/run-results.js';

function registration(): AcceptanceRegistration {
  return {
    schemaVersion: 1,
    runId: 'child',
    revision: 2,
    intake: {
      provider: 'github',
      repository: 'example/repo',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      capturedAt: '2026-10-25T00:00:00Z',
    },
    original: [{ id: 'AC-1', text: 'Original criterion' }],
    derived: [
      {
        id: 'AC-2',
        text: 'Resolve the review comment',
        proofMode: 'state',
        source: {
          kind: 'review-comment',
          sourceId: 'comment:1',
          sourceVersion: 'v1',
          obligationIndex: 0,
          url: 'https://example.test/comments/1',
        },
      },
    ],
    units: [
      {
        id: 'derive-acceptance',
        sources: [
          {
            id: 'comment:1',
            kind: 'review-comment',
            version: 'v1',
            body: 'Correct the stale price',
            url: 'https://example.test/comments/1',
          },
          {
            id: 'comment:2',
            kind: 'review-comment',
            version: 'v1',
            body: 'Thanks',
            url: 'https://example.test/comments/2',
          },
        ],
        result: {
          schemaVersion: 1,
          runId: 'child',
          generation: 1,
          registrationRevision: 1,
          unitId: 'derive-acceptance',
          classifications: [
            {
              sourceId: 'comment:1',
              sourceVersion: 'v1',
              obligations: [{ text: 'Resolve the review comment', proofMode: 'state' }],
            },
            {
              sourceId: 'comment:2',
              sourceVersion: 'v1',
              obligations: [],
              exclusion: 'No actionable request',
            },
          ],
        },
      },
    ],
  };
}
function ledger(): AcceptanceStatusLedger {
  return {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Original criterion',
        verdict: 'proven',
        evidence: [],
        recipeNodes: [],
        inheritedFrom: {
          source: 'parent-run',
          parentRunId: 'parent',
          headSha: 'b'.repeat(40),
          ledgerHash: 'c'.repeat(64),
        },
      },
    ],
  };
}

test('one shared projection counts original plus derived rows and keeps exclusions outside the AC count', () => {
  const registry = registration();
  const presentation = acceptancePanelPresentation(ledger(), [], undefined, registry);
  assert.equal(presentation.counts, '1/2 assessed · 1 proven');
  assert.equal(presentation.unassessed, 1);
  assert.equal(presentation.registration?.exclusions.length, 1);
  assert.equal(presentation.registration?.exclusions[0].url, 'https://example.test/comments/2');
  const rows = acceptanceClaimRows({ claims: [], registration: registry, ledger: ledger() });
  assert.deepEqual(
    rows.map(({ id }) => id),
    ['AC-1', 'AC-2'],
  );
  assert.equal(rows[0].state, 'Proven');
  assert.equal(rows[0].origin?.reference, 'parent');
  assert.equal(rows[1].state, 'Not assessed');
  assert.equal(rows[1].origin?.url, 'https://example.test/comments/1');
  assert.equal(rows[1].origin?.body, 'Correct the stale price');
});

test('a pending steer is visible without inventing an AC or changing an inherited verdict', () => {
  const registry = registration();
  registry.units.push({
    id: 'derive-message-3',
    sources: [
      { id: 'message:3', kind: 'instruction', body: 'Also preserve the balance', version: 'v1' },
    ],
    delivery: { status: 'pending', principalId: 'operator' },
  });
  const presentation = acceptancePanelPresentation(ledger(), [], undefined, registry);
  assert.match(presentation.counts, /1\/2 assessed.*acceptance update pending/);
  assert.deepEqual(presentation.registration?.pending, ['Instruction delivery is not confirmed.']);
  assert.equal(presentation.defaultOpen, true);
  const rows = acceptanceClaimRows({
    registration: registry,
    ledger: ledger(),
    pendingVisualClaimIds: ['AC-1'],
  });
  assert.equal(rows[0].state, 'Proven');
  assert.equal(rows[0].pending, false);
  assert.equal(rows.length, 2);
});
