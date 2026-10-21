import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AcceptanceVerdict,
  acceptanceVerdictLabel,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  EVIDENCE_ATTESTATION_ACTION,
  type RecipeRepairScope,
  renderAcceptanceCoverage,
  type ReviewStatus,
  type RunDecision,
  type RunGateReadiness,
  SEND_BACK_TO_AGENT_ACTION,
} from '@farmslot/protocol';

import {
  type AcceptanceClaimRow,
  acceptanceClaimRows,
  anotherReviewRoundParams,
  anotherReviewRoundView,
  humanGateBlockingReason,
  publicationGateBlockers,
  type PublicationGateClaim,
  publicationGateCriteria,
  publicationGateView,
  publicationReviewBlockingReason,
  untestableOverrideView,
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

test('review claims read as checked in review or awaiting code review, never missing', () => {
  const claim = (
    id: string,
    verdict: AcceptanceVerdict,
    proofMode: 'review' | 'state' = 'review',
  ): PublicationGateClaim => ({
    id,
    text: id,
    status: { id, text: id, verdict, proofMode, evidence: [], recipeNodes: [] },
  });
  const rows = acceptanceClaimRows({
    claims: [
      claim('AC-1', 'proven'),
      claim('AC-2', 'awaiting-review'),
      claim('AC-3', 'failed'),
      claim('AC-4', 'untestable'),
      claim('AC-5', 'missing', 'state'),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.state),
    ['Checked in review', 'Awaiting code review', 'Issue', 'Untestable', 'missing'],
  );
  assert.deepEqual(
    rows.map((row) => row.tone),
    ['checked', 'pending', 'issue', 'untestable', 'pending'],
  );
  assert.deepEqual(
    rows.map((row) => acceptanceVerdictLabel(row.source!.status!)),
    ['Checked in review', 'Awaiting code review', 'failed', 'untestable', 'missing'],
  );
  const coverage = renderAcceptanceCoverage({
    schemaVersion: 2,
    criteria: rows.slice(0, 2).map((row) => row.source!.status!),
  });
  assert.match(coverage, /\| AC-1 \| AC-1 \| CHECKED IN REVIEW \| review \|/);
  assert.match(coverage, /\| AC-2 \| AC-2 \| AWAITING CODE REVIEW \| review \|/);
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

test('normal approval follows readiness; review is primary and hold stays secondary', () => {
  const actions = [
    { id: 'approve-publish', label: 'Approve publish', style: 'primary' as const },
    { id: 'hold', label: 'Hold', style: 'secondary' as const },
    { id: 'request-review', label: 'Request review', style: 'secondary' as const },
  ];
  const view = publicationGateView({ actions, readiness: evidenceOnly });
  assert.ok(view.blockedReason);
  assert.deepEqual(
    view.secondaryActions.map((action) => action.id),
    ['hold'],
  );
  assert.deepEqual(
    view.primaryActions.map((action) => action.id),
    ['request-review'],
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

test('accepting the checked review findings is the one approval offered while they block', () => {
  const accept = {
    id: 'approve-publish-unresolved',
    label: 'Accept Review Findings and Publish',
    style: 'danger' as const,
  };
  const actions = [
    { id: 'approve-publish', label: 'Approve publish', style: 'primary' as const },
    accept,
    { id: 'hold', label: 'Hold', style: 'secondary' as const },
  ];
  const findings = [{ reviewId: 'review', file: 'src/a.ts', line: 3, description: 'Open' }];
  const readiness: RunGateReadiness = {
    state: 'not-ready',
    identity: evidenceOnly.identity,
    reasons: [
      {
        code: 'review-fix-required',
        prerequisite: 'review',
        message: 'Review rounds spent: 1 issue open',
        actionId: 'hold',
        allowedReviewOverrides: ['approve-publish-unresolved'],
      },
    ],
    findings,
    findingsDigest: 'sha256:findings',
  };
  const offered = publicationGateView({ actions, readiness });
  assert.equal(offered.acceptFindings?.id, 'approve-publish-unresolved');
  assert.deepEqual(offered.findings, findings);
  assert.equal(offered.approval, null);
  assert.equal(offered.status, 'Review rounds spent: 1 issue open');
  assert.deepEqual(
    offered.secondaryActions.map((action) => action.id),
    ['hold'],
  );
  const accepting = publicationGateView({ actions, readiness, acceptingFindings: true });
  assert.equal(accepting.approval?.id, 'approve-publish-unresolved');
  assert.equal(accepting.blockedReason, 'Enter a reason before accepting the findings.');
  const reasoned = publicationGateView({
    actions,
    readiness,
    acceptingFindings: true,
    attestationReason: 'The owner accepts this design choice.',
  });
  assert.equal(reasoned.blockedReason, '');
  assert.equal(reasoned.status, 'Publishing accepts the open review findings.');
  // Without the checked findings, or with another blocker, the shared rule withholds it.
  for (const withheld of [
    { ...readiness, findings: undefined, findingsDigest: undefined },
    {
      ...readiness,
      reasons: [
        ...readiness.reasons,
        { code: 'deterministic-not-passed', prerequisite: 'deterministic' as const, message: 'x' },
      ],
    },
  ]) {
    const view = publicationGateView({ actions, readiness: withheld, acceptingFindings: true });
    assert.equal(view.acceptFindings, null);
    assert.equal(view.approval, null);
  }
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

test('a passing continuation settles its own earlier findings after an evidence-only fix', () => {
  const snapshot = {
    source: 'local-git' as const,
    headSha: 'same-head',
    capturedAt: '2026-10-21T15:44:20.525Z',
  };
  const review: ReviewStatus = {
    id: 'pipeline-review',
    source: 'pipeline',
    mode: 'warm',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewedHeadSha: 'same-head',
    reviewSnapshot: snapshot,
    attempts: [
      {
        mode: 'cold',
        loopNumber: 1,
        verdict: 'issues',
        unresolvedCount: 1,
        issues: [{ file: 'artifacts/recipe.json', description: 'Compare original values.' }],
        reviewSnapshot: snapshot,
      },
      {
        mode: 'warm',
        loopNumber: 2,
        verdict: 'pass',
        unresolvedCount: 0,
        reviewSnapshot: snapshot,
      },
    ],
  };
  const run = {
    status: 'human-gating' as const,
    engineState: { publishGate: { reviews: [review] } },
  };
  assert.equal(publicationReviewBlockingReason(run, { headSha: 'same-head' }), undefined);
});

const repairScope: RecipeRepairScope = {
  schemaVersion: 1,
  repairId: 'repair-1',
  runId: 'run',
  generation: 1,
  decisionId: 'gate',
  packageHash: 'b'.repeat(64),
  packageHeadSha: 'c'.repeat(40),
  reviewBaseSha: 'd'.repeat(40),
  reviewId: 'review',
  workerContextId: 'run:dev',
  repairRecipe: 'recipes/repair-1.json',
  claims: [{ id: 'AC-1', claim: 'The chart renders.' }],
  sources: [],
  retained: [],
  rejected: [],
};

test('an offered Send back is the one primary action and shows its recovery state', () => {
  const actions = [
    { id: 'approve-publish', label: 'Approve publish', style: 'primary' as const },
    { id: SEND_BACK_TO_AGENT_ACTION, label: 'Send back to agent', style: 'primary' as const },
    { id: 'hold', label: 'Hold', style: 'secondary' as const },
  ];
  const view = publicationGateView({ actions, readiness: evidenceOnly });
  assert.equal(view.sendBack?.id, SEND_BACK_TO_AGENT_ACTION);
  assert.equal(
    view.approval,
    null,
    'an Issue blocks publication; approve is not offered beside it',
  );
  assert.deepEqual(
    view.secondaryActions.map(({ id }) => id),
    ['hold'],
  );
  assert.equal(view.status, 'Issues found');
  const undelivered = publicationGateView({
    actions,
    readiness: evidenceOnly,
    run: {
      status: 'human-gating',
      engineState: {
        publishGate: {
          visualRepairs: [
            {
              repairId: 'repair-1',
              scopeDigest: 'digest',
              decisionId: 'gate',
              packageHash: 'hash',
              reviewId: 'review',
              status: 'reserved',
              reservedRetryCount: 1,
              reservedAt: '2026-10-16T00:00:00.000Z',
              reason: 'The agent has not accepted the repair yet. Send back again to retry.',
              rejected: [],
              scope: repairScope,
            },
          ],
        },
      },
    },
  });
  assert.equal(
    undelivered.status,
    'The agent has not accepted the repair yet. Send back again to retry.',
  );
  assert.equal(publicationGateView({ actions, resolved: true }).sendBack, null);
});

test('retained criteria show their earlier proof revision in the shared row detail', () => {
  const [row] = acceptanceClaimRows({
    claims: [
      {
        id: 'AC-1',
        text: 'The header shows the price.',
        status: {
          id: 'AC-1',
          text: 'The header shows the price.',
          verdict: 'proven',
          evidence: [],
          recipeNodes: [],
        },
        retained: { recipeRunId: 'original', revision: 'c'.repeat(40) },
      },
    ],
  });
  assert.equal(row!.detail, 'Earlier proof · ccccccc');
});

// Run 7721a02b (TAT-4006) on 2026-10-20: 4 open findings, all review rounds spent, so
// its open gate offers only Hold and Request Review.
test('an open gate shows the reason a person can act on, not a fix it does not offer', () => {
  const findings: ReviewStatus = {
    id: 'review',
    source: 'pipeline',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 4,
    reviewedHeadSha: 'head',
  };
  const readiness: RunGateReadiness = {
    state: 'not-ready',
    identity: { runId: 'run', generation: 8 },
    reasons: [
      {
        code: 'review-fix-required',
        prerequisite: 'review',
        message: 'Review found 4 issues. Fix and pass review before publishing.',
        actionId: 'continue-review-fix',
      },
      {
        code: 'review-result-required',
        prerequisite: 'review',
        message: 'Required current-head reviews need valid structured result artifacts.',
        actionId: 'hold',
      },
    ],
  };
  const gate: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'TAT-4006 — human gate',
    description: '',
    createdAt: '2026-10-19T17:30:13.466Z',
    actions: [
      { id: 'hold', label: 'Hold', style: 'secondary' },
      { id: 'request-review', label: 'Request Review', style: 'secondary' },
    ],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: 'MetaMask/core',
      diffStat: { files: 7, additions: 507, deletions: 3 },
      workerReport: '',
      branch: 'TAT-4006',
      gateReadiness: readiness,
      reviewRoundBudget: {
        used: 7,
        limit: 7,
        remaining: 0,
        label: 'Review rounds 7/7',
        noVerdict: 0,
        noVerdictLimit: 3,
      },
    },
  };
  const run = {
    status: 'blocked' as const,
    engineState: { publishGate: { reviews: [findings] } },
    decisions: [gate],
  };
  const spent = 'Review rounds spent: 4 issues open';
  assert.equal(humanGateBlockingReason(run), spent);
  // Without an open gate the review findings still speak.
  assert.match(humanGateBlockingReason({ ...run, decisions: [] }) ?? '', /Review found 4 issues/);
  // The gate view shows the same line; the publish guard still withholds approval.
  const view = publicationGateView({
    run,
    gate,
    readiness,
    actions: [
      ...gate.actions,
      { id: 'approve-publish', label: 'Approve publish', style: 'primary' },
    ],
  });
  assert.equal(view.status, spent);
  assert.equal(view.approval, null);
  assert.match(
    publicationGateView({ run, readiness, actions: gate.actions }).status,
    /Fix and pass/,
  );
});

test('skipping a criterion is one action and needs a written reason', () => {
  const empty = untestableOverrideView('AC-3', '  ');
  assert.equal(empty.action, 'Skip this criterion…');
  assert.equal(empty.confirm, 'Skip AC-3');
  assert.equal(empty.canConfirm, false);
  assert.equal(untestableOverrideView('AC-3', 'No testnet market shows it').canConfirm, true);
});

test('what blocks publish: one plain action per criterion, findings and spent rounds', () => {
  const claim = (id: string, state: string, verdict: AcceptanceVerdict): AcceptanceClaimRow => ({
    id,
    text: `${id} text`,
    state,
    tone: 'issue',
    detail: '',
    pending: false,
    source: {
      id,
      text: `${id} text`,
      status: { id, text: `${id} text`, verdict, evidence: [], recipeNodes: [] },
    },
  });
  const readiness: RunGateReadiness = {
    state: 'not-ready',
    identity: { runId: 'r1', generation: 1 },
    reasons: [
      {
        code: 'acceptance-incomplete',
        prerequisite: 'acceptance',
        message: 'The registered acceptance criteria have missing or disallowed verdicts.',
      },
      { code: 'review-fix-required', prerequisite: 'review', message: 'Review found 3 issues.' },
      {
        code: 'deterministic-not-passed',
        prerequisite: 'deterministic',
        message: 'CI parity failed.',
      },
    ],
  };
  const blockers = publicationGateBlockers({
    view: {
      reviewIssues: [],
      primaryActions: [],
      claims: [
        claim('AC-1', 'Proven', 'proven'),
        claim('AC-2', 'Untestable', 'untestable'),
        claim('AC-3', 'Missing', 'missing'),
      ],
      acceptFindings: {
        id: APPROVE_PUBLISH_UNRESOLVED_ACTION,
        label: 'Accept findings',
        style: 'secondary',
      },
    },
    readiness,
    // The gate lets a person skip any registered criterion; only blocking ones are listed.
    canSkip: () => true,
    budget: { remaining: 0, used: 3, limit: 3 },
  });
  assert.deepEqual(
    blockers.map((blocker) => [blocker.message, blocker.actions[0]?.label ?? null]),
    [
      ['AC-3 · Missing: AC-3 text', 'Skip this criterion…'],
      ['Review found 3 issues.', 'Accept findings…'],
      ['CI parity failed.', null],
      ['No review rounds left (3 of 3 used).', 'Give it another round'],
    ],
  );
  assert.equal(anotherReviewRoundView({ used: 3, limit: 3 }, '').canConfirm, false);
  // A ready or resolved gate lists nothing.
  assert.deepEqual(
    publicationGateBlockers({
      view: { claims: [], acceptFindings: null, reviewIssues: [], primaryActions: [] },
      readiness: { ...readiness, state: 'ready' },
      canSkip: () => true,
    }),
    [],
  );
});

test('another review round raises the limit by one, idempotent per gate and limit', () => {
  assert.deepEqual(
    anotherReviewRoundParams({
      runId: 'r1',
      decisionId: 'd1',
      budget: { limit: 3 },
      headSha: 'abc',
      brief: '  the open findings ',
    }),
    {
      runId: 'r1',
      requestId: 'extend-review-budget:d1:3',
      expectedLimit: 3,
      limit: 4,
      headSha: 'abc',
      scopeBrief: 'the open findings',
    },
  );
});

test('the gate shows why a review ran a delta-scoped COLD and what it compared', async () => {
  const { reviewFallbackLine } = await import('../src/publication-gate.js');
  const last = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const fallback = {
    reason: 'reviewed-head-not-ancestor' as const,
    detail: 'the current head no longer descends from the last reviewed head',
    comparedRanges: [`${'c'.repeat(40)}..${last}`, `${'d'.repeat(40)}..${head}`],
  };
  const review: Pick<ReviewStatus, 'session' | 'attempts'> = {
    session: { mode: 'cold', continuity: 'fresh', reviewId: 'lineage', fallback },
  };
  assert.equal(
    reviewFallbackLine(review),
    `Ran COLD in a fresh session: ${fallback.detail}. Compared cccccccccccc..aaaaaaaaaaaa with dddddddddddd..bbbbbbbbbbbb.`,
  );
  // A later WARM round continued the fresh session; the round that fell back still shows.
  assert.match(
    reviewFallbackLine({
      session: { mode: 'warm', continuity: 'resumed' },
      attempts: [
        {
          mode: 'cold',
          loopNumber: 2,
          verdict: 'issues',
          unresolvedCount: 1,
          session: review.session,
        },
        { mode: 'warm', loopNumber: 3, verdict: 'pass', unresolvedCount: 0 },
      ],
    }) ?? '',
    /^Round 2 Ran COLD in a fresh session/,
  );
  assert.equal(reviewFallbackLine({ session: { mode: 'warm', continuity: 'resumed' } }), null);
});

test('a Request Review reads the lineages its ready gate listed', async () => {
  const { gateReviewLineageOptions } = await import('../src/publication-gate.js');
  const option = {
    context: { reviewId: 'lineage', familyId: 'family' },
    runner: 'codex',
    model: null,
    effort: null,
    reviewedAt: '2026-10-20T00:00:00Z',
  };
  const ready: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Ready',
    description: '',
    createdAt: '2026-10-20T00:00:00Z',
    actions: [],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: { files: 1, additions: 1, deletions: 0 },
      workerReport: '',
      branch: 'feature',
      reviewLineageOptions: [option],
    },
  };
  assert.deepEqual(gateReviewLineageOptions({ decisions: [ready] }), [option]);
  assert.deepEqual(gateReviewLineageOptions({ decisions: [ready] }, 'gate'), [option]);
  assert.equal(gateReviewLineageOptions({ decisions: [ready] }, 'other'), undefined);
  assert.equal(gateReviewLineageOptions(null), undefined);
});

test('each review blocker carries plain copy and its offered action', () => {
  const readiness: RunGateReadiness = {
    state: 'not-ready',
    identity: { runId: 'run-4190', generation: 3 },
    reasons: [
      { code: 'review-fix-required', prerequisite: 'review', message: 'Review found 1 issue.' },
      {
        code: 'review-result-required',
        prerequisite: 'review',
        message:
          'Required current-head reviews need valid structured result artifacts for this package.',
      },
    ],
    findings: [
      {
        reviewId: 'pipeline-review',
        file: 'evidence-manifest.json',
        line: 33,
        description: 'AC-1 needs a resulting position. The submitted order rests.',
      },
    ],
  };
  const view = publicationGateView({
    readiness,
    actions: [{ id: 'request-review', label: 'Request Review', style: 'primary' }],
  });
  const blockers = publicationGateBlockers({
    view,
    readiness,
    canSkip: () => false,
    budget: { used: 2, limit: 5, remaining: 3 },
  });
  assert.equal(blockers[0].message, 'Review found 1 issue');
  assert.match(blockers[0].findings[0].summary, /AC-1 needs a resulting position/);
  assert.deepEqual(
    blockers[0].actions.map((action) => action.kind),
    ['see-findings'],
  );
  assert.equal(blockers[1].message, 'The current version needs a review');
  assert.deepEqual(blockers[1].actions, [
    { kind: 'request-review', label: 'Request review (round 3 of 5)' },
  ]);
  assert.equal(view.primaryActions[0].id, 'request-review');
  assert.deepEqual(view.secondaryActions, []);
});
