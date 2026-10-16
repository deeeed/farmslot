import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_ATTESTATION_ACTION,
  type ReviewStatus,
  type RunGateReadiness,
} from '@farmslot/protocol';

import {
  acceptanceClaimRows,
  type PublicationGateClaim,
  publicationGateCriteria,
  publicationGateView,
  publicationReviewBlockingReason,
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

test('a gateway skipped-review warning is visible without withholding approval', () => {
  const input = {
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    readiness: { ...evidenceOnly, state: 'ready' as const, reasons: [] },
    reviewSummary: {
      noCodeReview: true,
      reviews: [],
      passingReviews: 0,
      totalUnresolved: 0,
      didAnyReviewTriggerReWork: false,
    },
  };
  const view = publicationGateView(input);
  assert.deepEqual(view.warnings, ['No code review ran']);
  assert.equal(view.approval?.id, 'approve-publish');
  assert.equal(view.blockedReason, '');
  assert.equal(view.status, 'Ready to publish');
  assert.deepEqual(publicationGateView({ ...input, reviewSummary: undefined }).warnings, []);
  assert.ok(publicationGateView({ ...input, readiness: evidenceOnly }).blockedReason);
});

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

test('all AC views distinguish assertions, qualified reviews and unchecked visuals', () => {
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
    ],
    pendingVisualClaimIds: ['AC-4'],
  });
  assert.deepEqual(
    rows.map((row) => row.state),
    ['Proven', 'Verified by agent', 'Checked', 'Needs a check'],
  );
  assert.deepEqual(
    rows.map((row) => row.tone),
    ['proven', 'verified', 'checked', 'pending'],
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

test('both publication clients hide all approval variants behind an unresolved-review status', () => {
  const actions = [
    { id: 'approve-publish', label: 'Approve publish', style: 'primary' as const },
    { ...EVIDENCE_ATTESTATION_ACTION },
    {
      id: 'approve-publish-unresolved',
      label: 'Accept findings and publish',
      style: 'danger' as const,
    },
    { id: 'continue-review-fix', label: 'Continue fixing', style: 'primary' as const },
  ];
  for (const message of [
    'Review found 1 issue. Fix and pass review before publishing.',
    'Review found 1 issue, fix in progress.',
  ]) {
    const view = publicationGateView({
      actions,
      readiness: {
        state: 'not-ready',
        identity: evidenceOnly.identity,
        reasons: [{ code: 'review-fix-required', prerequisite: 'review', message }],
      },
    });
    assert.equal(view.status, message);
    assert.equal(view.approval, null);
    assert.equal(view.attestation, null);
    assert.deepEqual(
      view.secondaryActions.map((action) => action.id),
      ['continue-review-fix'],
    );
  }
  const ready = publicationGateView({
    actions,
    readiness: { state: 'ready', identity: evidenceOnly.identity, reasons: [] },
  });
  assert.equal(ready.approval?.id, 'approve-publish');
  assert.equal(publicationGateView({ actions, resolved: true }).approval, null);
});

test('live run state overrides stale approval actions even without a decision or readiness payload', () => {
  const run: NonNullable<Parameters<typeof publicationGateView>[0]['run']> = {
    status: 'human-gating',
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'rv3',
            source: 'human-gate',
            mode: 'cold',
            loopNumber: 3,
            verdict: 'issues',
            unresolvedCount: 1,
          },
        ],
      },
    },
  };
  const actions = [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }];
  const view = publicationGateView({ actions, run });
  assert.equal(view.approval, null);
  assert.match(view.status, /Review found 1 issue/);
  assert.deepEqual(view.secondaryActions, []);
  run.status = 'fixing';
  assert.equal(
    publicationGateView({ actions, run }).status,
    'Review found 1 issue, fix in progress.',
  );
});

test('failed same-ID continuations retain findings after the fix context is blocked', () => {
  const review: ReviewStatus[] = [
    {
      id: 'rv3',
      source: 'human-gate',
      mode: 'cold',
      loopNumber: 3,
      verdict: 'failed',
      unresolvedCount: 1,
      feedbackSent: true,
      attempts: [
        { mode: 'cold', loopNumber: 1, verdict: 'issues', unresolvedCount: 1 },
        { mode: 'warm', loopNumber: 2, verdict: 'failed', unresolvedCount: 1 },
      ],
    },
  ];
  const run: NonNullable<Parameters<typeof publicationGateView>[0]['run']> = {
    status: 'human-gating',
    engineState: { publishGate: { reviews: review } },
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Fix',
        status: 'blocked',
        runId: 'run',
        slotId: 'slot',
      },
    ],
  };
  const actions = [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }];
  assert.equal(publicationGateView({ actions, run }).approval, null);
  assert.match(publicationGateView({ actions, run }).status, /Review found 1 issue/);
});

test('unchanged-head PASS retains findings; a PASS on the fixed head clears them', () => {
  const issue: ReviewStatus = {
    id: 'a',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    reviewedHeadSha: 'bad-head',
  };
  const pass: ReviewStatus = { ...issue, id: 'b', verdict: 'pass', unresolvedCount: 0 };
  const run = {
    status: 'human-gating' as const,
    engineState: { publishGate: { reviews: [issue, pass] } },
  };
  assert.match(publicationReviewBlockingReason(run) ?? '', /Review found 1 issue/);
  assert.equal(
    publicationReviewBlockingReason(
      {
        ...run,
        engineState: {
          publishGate: { reviews: [issue, { ...pass, reviewedHeadSha: 'fixed-head' }] },
        },
      },
      { headSha: 'fixed-head' },
    ),
    undefined,
  );
});
