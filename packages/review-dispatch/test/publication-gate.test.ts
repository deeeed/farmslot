import assert from 'node:assert/strict';
import test from 'node:test';

import { EVIDENCE_ATTESTATION_ACTION, type RunGateReadiness } from '@farmslot/protocol';

import {
  acceptanceClaimRows,
  type PublicationGateClaim,
  publicationGateCriteria,
  publicationGateView,
} from '../src/publication-gate.js';

const evidenceOnly: RunGateReadiness = {
  state: 'not-ready',
  identity: { runId: 'run', generation: 1 },
  reasons: [
    {
      code: 'evidence-policy-unsatisfied',
      prerequisite: 'evidence',
      evidencePolicy: 'execution-verdict',
      message: 'Evidence policy needs attestation.',
    },
  ],
};

test('pending judgments have separate labeled rows and withhold attestation and approval', () => {
  const view = publicationGateView({
    actions: [EVIDENCE_ATTESTATION_ACTION],
    readiness: evidenceOnly,
    claims: [{ id: 'AC-1', text: 'Order lines hide the position size.', status: null }],
    pendingVisualClaimIds: ['AC-1', 'AC-2'],
  });
  assert.equal(view.status, '2 criteria need a check');
  assert.equal(view.claims[0].text, 'Order lines hide the position size.');
  assert.equal(view.claims[1].id, 'AC-2');
  assert.equal(view.attestation, null);
  assert.equal(view.approval, null);
});

test('review labels alone never imply proven visual meaning', () => {
  const view = publicationGateView({
    actions: [],
    claims: [
      { id: 'AC-1', text: 'Visual proof', status: null, reviewLabels: ['Person reviewed'] },
      {
        id: 'AC-2',
        text: 'State proof',
        status: {
          id: 'AC-2',
          text: 'State proof',
          verdict: 'proven',
          evidence: [],
          recipeNodes: [],
        },
      },
    ],
  });
  assert.deepEqual(
    view.claims.map((claim) => claim.state),
    ['Not assessed', 'Proven'],
  );
});

test('all AC views distinguish assertions, qualified reviews and required person checks', () => {
  const proven = (
    id: string,
    proofKinds: PublicationGateClaim['proofKinds'],
  ): PublicationGateClaim => ({
    id,
    text: id,
    status: { id, text: id, verdict: 'proven', evidence: [], recipeNodes: [] },
    proofKinds,
  });
  const rows = acceptanceClaimRows({
    claims: [
      proven('AC-1', ['assertion']),
      proven('AC-2', ['agent-reviewed']),
      proven('AC-3', ['person-reviewed']),
      { id: 'AC-4', text: 'Visual proof missing', status: null },
      { id: 'AC-5', text: 'Person check required', status: null, requiresPersonReview: true },
    ],
    pendingVisualClaimIds: ['AC-4', 'AC-5'],
  });
  assert.deepEqual(
    rows.map((row) => row.state),
    ['Proven', 'Verified by agent', 'Checked', 'Needs a check', 'Needs your check'],
  );
  assert.deepEqual(
    rows.map((row) => row.tone),
    ['proven', 'verified', 'checked', 'pending', 'pending'],
  );
});

test('eligible attestation requires a written reason and is never invented', () => {
  const input = {
    actions: [EVIDENCE_ATTESTATION_ACTION],
    readiness: evidenceOnly,
    attesting: true,
  };
  assert.ok(publicationGateView(input).blockedReason);
  assert.equal(
    publicationGateView({ ...input, attestationReason: 'Reviewed the retained proof.' })
      .blockedReason,
    '',
  );
  assert.equal(publicationGateView({ ...input, actions: [] }).attestation, null);
});

test('CI and integrity blockers cannot turn into an attestation form', () => {
  const readiness: RunGateReadiness = {
    ...evidenceOnly,
    reasons: [
      {
        code: 'deterministic-not-passed',
        prerequisite: 'deterministic',
        message: 'CI has not passed.',
      },
    ],
  };
  const view = publicationGateView({ actions: [EVIDENCE_ATTESTATION_ACTION], readiness });
  assert.equal(view.attestation, null);
  assert.equal(view.approval, null);
});

test('normal approval follows readiness; hold and review remain secondary', () => {
  const actions = [
    { id: 'approve-publish', label: 'Approve publish', style: 'primary' as const },
    { id: 'hold', label: 'Hold', style: 'secondary' as const },
    { id: 'request-review', label: 'Request review', style: 'secondary' as const },
  ];
  const view = publicationGateView({ actions, readiness: evidenceOnly });
  assert.ok(view.blockedReason);
  assert.deepEqual(
    view.secondaryActions.map((action) => action.id),
    ['hold', 'request-review'],
  );
  const ready = publicationGateView({
    actions,
    readiness: { state: 'ready', identity: evidenceOnly.identity, reasons: [] },
  });
  assert.equal(ready.status, 'Ready to publish');
  assert.equal(ready.approval?.id, 'approve-publish');
});

test('resolved gates do not expose attestation', () => {
  const view = publicationGateView({
    actions: [EVIDENCE_ATTESTATION_ACTION],
    readiness: evidenceOnly,
    resolved: true,
  });
  assert.equal(view.attestation, null);
  assert.equal(view.status, 'This decision is resolved.');
});

test('changed visual judgments require a visible refresh, never approval', () => {
  const view = publicationGateView({
    actions: [
      { id: 'approve-publish-evidence-refresh', label: 'Approve publish', style: 'primary' },
    ],
    readiness: {
      ...evidenceOnly,
      reasons: [
        {
          code: 'evidence-override-refresh-required',
          prerequisite: 'evidence',
          message: 'Visual review changed.',
        },
      ],
    },
  });
  assert.equal(view.refreshRequired, true);
  assert.equal(view.blockedReason, 'Refresh package');
  const refreshed = publicationGateView({
    actions: [
      { id: 'approve-publish-evidence-refresh', label: 'Approve publish', style: 'primary' },
    ],
    readiness: {
      ...evidenceOnly,
      reasons: [
        {
          code: 'review-result-required',
          prerequisite: 'review',
          message: 'Reviews bound to previous evidence.',
          allowedReviewOverrides: ['approve-publish-evidence-refresh'],
        },
      ],
    },
  });
  assert.equal(refreshed.blockedReason, '');
  assert.equal(refreshed.approval?.id, 'approve-publish-evidence-refresh');
});

test('declared gate criteria keep unassessed rows when the recorded ledger is partial', () => {
  const criteria = publicationGateCriteria({
    acceptanceCriteria: ['First requirement', 'Second requirement'],
    acceptanceStatus: {
      schemaVersion: 2,
      criteria: [
        { id: 'AC-1', text: 'First requirement', verdict: 'proven', evidence: [], recipeNodes: [] },
      ],
    },
  });
  assert.deepEqual(criteria, [
    { id: 'AC-1', text: 'First requirement' },
    { id: 'AC-2', text: 'Second requirement' },
  ]);
  assert.equal(
    publicationGateCriteria({
      acceptanceCriteria: ['First', 'Second'],
      acceptanceStatus: { schemaVersion: 2, criteria: [] },
    }).length,
    2,
  );
});

test('older gate row counts use the same recorded fallback in both clients', () => {
  const rows = [
    {
      id: 'retained-criterion',
      text: 'Recorded requirement',
      verdict: 'proven' as const,
      evidence: [],
      recipeNodes: [],
    },
  ];
  assert.deepEqual(
    publicationGateCriteria({ acceptanceStatus: { schemaVersion: 1, criteria: rows } }),
    rows,
  );
  assert.deepEqual(
    publicationGateCriteria({
      acceptanceCriteria: [],
      acceptanceStatus: { schemaVersion: 1, criteria: rows },
    }),
    rows,
  );
  assert.deepEqual(publicationGateCriteria(undefined), []);
});
