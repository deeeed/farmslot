import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVE_PUBLISH_ACTION,
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  type DecisionAction,
  type ReadyGatePayload,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunGateReadiness,
} from '@farmslot/protocol';
import { colors } from '@farmslot/theme';

import {
  approvePublishGuard,
  gateRequiredReviewCount,
  gateReviewActions,
  gateReviewHref,
  gateReviews,
  gateReviewSummary,
  humanGateGuard,
  latestReviewVerdicts,
  openHumanGateDecision,
} from './gate-review';

test('native gate permits attestation only for checked policy failures with all other guards passed', () => {
  const action: DecisionAction = {
    id: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
    label: 'Attest',
    style: 'danger',
  };
  const guard = approvePublishGuard({
    acceptance: { rows: [] } as never,
    reviews: [],
    requiredReviews: 0,
  });
  const readiness = {
    state: 'not-ready' as const,
    identity: { runId: 'run', generation: 0, packageHash: 'hash' },
    reasons: [
      {
        code: 'evidence-policy-unsatisfied',
        prerequisite: 'evidence' as const,
        evidencePolicy: 'criterion-binding' as const,
        message: 'Claim text differs.',
      },
    ],
  };
  assert.equal(gateReviewActions([action], guard, readiness)[0].disabledReason, null);
  assert.equal(
    gateReviewActions(
      [action],
      { ...guard, acceptanceReasons: ['AC-2 requires confirmation'] },
      readiness,
    )[0].disabledReason,
    null,
  );
  assert.equal(
    gateReviewActions(
      [action],
      { ...guard, reviewReasons: ['Optional prior review is stale'] },
      readiness,
    )[0].disabledReason,
    null,
  );
  assert.match(gateReviewActions([action], guard)[0].disabledReason!, /unavailable/);
  assert.match(
    gateReviewActions([action], guard, {
      ...readiness,
      reasons: [{ ...readiness.reasons[0], code: 'evidence-invalid' }],
    })[0].disabledReason!,
    /unavailable/,
  );
  assert.match(
    gateReviewActions(
      [action],
      { ...guard, reviewReasons: ['Review required'] },
      readiness,
      'Review required',
    )[0].disabledReason!,
    /Review required/,
  );
});
import { acceptanceLedgerView } from './task-progress-view';

const GATE_ACTIONS: DecisionAction[] = [
  { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
  { id: 'hold', label: 'Hold', style: 'secondary' },
  { id: 'request-review', label: 'Request review', style: 'secondary' },
];

function review(overrides: Partial<ReviewStatus>): ReviewStatus {
  return {
    id: 'review',
    source: 'dispatch',
    mode: 'cold',
    runner: 'codex',
    reviewerSessionId: 'session-' + (overrides.id ?? 'review'),
    reviewedHeadSha: 'reviewed-head',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    completedAt: '2026-10-11T10:00:00.000Z',
    ...overrides,
  };
}

function gateDecision(overrides: Partial<RunDecision> = {}): RunDecision {
  const payload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    branch: 'feat/payload-branch',
    diffStat: { files: 1, additions: 1, deletions: 1 },
    workerReport: '',
    publicationTarget: 'draft',
    prPackage: {
      id: 'pkg-1',
      packageHash: 'hash',
      artifactPath: 'artifacts/package.json',
      branch: 'feat/gate-review',
      diffStat: { files: 7, additions: 312, deletions: 41 },
      draftTitle: 'feat(companion): review publish gates',
      draftBody: '',
      reviewArtifactIds: [],
      gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'fixture' },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: '2026-10-11T09:00:00.000Z',
    },
    reviews: [review({ id: 'snapshot', runner: 'claude' })],
  } as ReadyGatePayload;
  return {
    id: 'gate-1',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: '',
    actions: GATE_ACTIONS,
    createdAt: '2026-10-11T11:00:00.000Z',
    payload,
    ...overrides,
  };
}

test('the open gate is the latest unresolved human gate', () => {
  const resolved = gateDecision({ id: 'old', resolvedAt: '2026-10-11T11:30:00.000Z' });
  const open = gateDecision({ id: 'open' });
  const other = { ...gateDecision({ id: 'retro' }), type: 'engine_retrospective' } as RunDecision;
  assert.equal(openHumanGateDecision({ decisions: [resolved, open, other] })?.id, 'open');
  assert.equal(openHumanGateDecision({ decisions: [resolved, other] }), null);
  assert.equal(openHumanGateDecision(null), null);
});

test('the gate review route carries the run so the screen can read it in full', () => {
  assert.deepEqual(gateReviewHref('run-1', 'gate-1'), {
    pathname: '/gate-review/[decisionId]',
    params: { decisionId: 'gate-1', runId: 'run-1' },
  });
});

test('the package summary prefers the prepared package over the worker payload', () => {
  assert.deepEqual(gateReviewSummary(gateDecision()), {
    title: 'feat(companion): review publish gates',
    target: 'ready',
    branch: 'feat/gate-review',
    files: 7,
    additions: 312,
    deletions: 41,
  });
  const bare = gateDecision({ payload: undefined });
  assert.deepEqual(gateReviewSummary(bare), {
    title: 'Publication gate',
    target: null,
    branch: null,
    files: null,
    additions: null,
    deletions: null,
  });
});

test('gate summary preserves the shared command receipt and its log for rendering', () => {
  const decision = gateDecision();
  const payload = decision.payload as ReadyGatePayload;
  const checks = [
    {
      checklist: 'CHECKLIST.md',
      stepNumber: 2,
      reference: 'ci.local_check',
      command: 'yarn ci:local',
      status: 'passed' as const,
      exitCode: 0,
      logPath: 'artifacts/deterministic-checks/CHECKLIST.md/check.log',
      inputHash: 'hash',
      message: '',
    },
  ];
  payload.prPackage!.deterministicChecks = checks;
  assert.deepEqual(gateReviewSummary(decision).deterministicChecks, checks);
});

test('live publish-gate reviews win over the snapshot the gate opened with', () => {
  const live = [review({ id: 'live' })];
  assert.deepEqual(
    gateReviews({ engineState: { publishGate: { reviews: live } } } as never, gateDecision()).map(
      (entry) => entry.id,
    ),
    ['live'],
  );
  assert.deepEqual(
    gateReviews({ engineState: undefined } as never, gateDecision()).map((entry) => entry.id),
    ['snapshot'],
  );
});

test('separate sessions using one runner count and a recheck replaces only its lineage', () => {
  const verdicts = latestReviewVerdicts([
    review({ id: 'r1', runner: 'codex', verdict: 'issues', unresolvedCount: 2 }),
    review({ id: 'r2', runner: 'codex', verdict: 'pass' }),
    review({ id: 'r1', runner: 'codex', verdict: 'pass', loopNumber: 2, mode: 'warm' }),
    review({ id: 'pipeline', source: 'pipeline', runner: 'codex', verdict: 'pass' }),
  ]);
  assert.equal(verdicts.length, 3);
  assert(verdicts.every((verdict) => verdict.approved));
  assert.equal(verdicts[0].color, colors.statusOk);
});

test('a stale pass or open findings are not an approval', () => {
  const [stale, findings] = latestReviewVerdicts([
    review({ id: 'a', runner: 'a', stale: true }),
    review({ id: 'b', runner: 'b', verdict: 'issues', unresolvedCount: 3 }),
  ]);
  assert.equal(stale.approved, false);
  assert.equal(stale.label, 'pass (stale)');
  assert.equal(stale.color, colors.statusWarn);
  assert.equal(findings.approved, false);
  assert.equal(findings.label, 'issues · 3 unresolved');
  assert.equal(findings.color, colors.statusFail);
});

function acceptance(withVerdictFor: string[]) {
  return acceptanceLedgerView(
    {
      schemaVersion: 1,
      criteria: withVerdictFor.map((id) => ({
        id,
        text: id,
        verdict: 'proven' as const,
        evidence: [],
        recipeNodes: [],
        updatedAt: '2026-10-11T12:00:00.000Z',
      })),
    },
    [
      { id: 'AC-1', text: 'AC-1' },
      { id: 'AC-2', text: 'AC-2' },
    ],
  );
}

const approvals = latestReviewVerdicts([
  review({ id: 'a', runner: 'codex' }),
  review({ id: 'b', runner: 'claude' }),
]);

test('a later loop is the latest review even when an earlier loop finished afterwards', () => {
  const [codex] = latestReviewVerdicts([
    review({ id: 'r1', loopNumber: 1, startedAt: '2026-10-11T09:00:00.000Z' }),
    review({
      id: 'r1',
      loopNumber: 2,
      verdict: 'pending',
      startedAt: '2026-10-11T09:30:00.000Z',
      completedAt: undefined,
    }),
  ]);
  assert.equal(codex.verdict, 'pending');
  assert.equal(codex.approved, false);
});

test('a publication gate requires the reviews its frozen policy counts', () => {
  assert.equal(gateRequiredReviewCount(gateDecision()), 1);
  const payload = gateDecision().payload as ReadyGatePayload;
  const withPolicy = gateDecision({
    payload: {
      ...payload,
      prPackage: {
        ...payload.prPackage!,
        reviewPolicy: {
          minimumReviews: 2,
          requestedBy: 'dispatch',
        },
      },
    },
  });
  assert.equal(gateRequiredReviewCount(withPolicy), 2);
  // No prepared package: nothing is published, and the gateway requires no review.
  assert.equal(gateRequiredReviewCount(gateDecision({ payload: undefined })), 0);
});

const OVERRIDES: DecisionAction[] = [
  { id: APPROVE_PUBLISH_UNRESOLVED_ACTION, label: 'Bypass Review (dangerous)', style: 'danger' },
  { id: APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION, label: 'Approve (refresh)', style: 'primary' },
  { id: 'ready', label: 'Mark Ready', style: 'primary' },
  { id: 'hold', label: 'Hold', style: 'secondary' },
];

/** A gate whose head findings can be accepted (ADR-065 Amendment 8). */
const ACCEPTABLE: RunGateReadiness = {
  state: 'not-ready',
  identity: { runId: 'run', generation: 1 },
  reasons: [
    {
      code: 'review-fix-required',
      prerequisite: 'review',
      message: 'Review rounds spent: 1 issue open',
      allowedReviewOverrides: [APPROVE_PUBLISH_UNRESOLVED_ACTION],
    },
  ],
  findings: [{ reviewId: 'review', file: 'src/a.ts', description: 'Open finding' }],
  findingsDigest: 'sha256:findings',
};

const withheld = (
  actions: DecisionAction[],
  guard: ReturnType<typeof approvePublishGuard>,
  readiness: RunGateReadiness | undefined = ACCEPTABLE,
) =>
  gateReviewActions(actions, guard, readiness).map((action) => [action.id, action.disabledReason]);

test('approve-publish is withheld while a criterion has no verdict; hold and review requests stay', () => {
  const guard = approvePublishGuard({
    acceptance: acceptance(['AC-1']),
    reviews: approvals,
    requiredReviews: 1,
  });
  assert.deepEqual(guard, { acceptanceReasons: ['AC-2 has no verdict'], reviewReasons: [] });
  assert.equal(GATE_ACTIONS[0].id, APPROVE_PUBLISH_ACTION);
  assert.deepEqual(withheld(GATE_ACTIONS, guard), [
    ['approve-publish', 'AC-2 has no verdict'],
    ['hold', null],
    ['request-review', null],
  ]);
});

test('an unjudged criterion withholds every publish approval, overrides included', () => {
  const guard = approvePublishGuard({
    acceptance: acceptance(['AC-1']),
    reviews: approvals,
    requiredReviews: 1,
  });
  assert.deepEqual(withheld(OVERRIDES, guard), [
    [APPROVE_PUBLISH_UNRESOLVED_ACTION, 'AC-2 has no verdict'],
    [APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION, 'AC-2 has no verdict'],
    ['ready', 'AC-2 has no verdict'],
    ['hold', null],
  ]);
});

test('a latest verdict that is not an approval withholds plain approvals, not the review overrides', () => {
  const reviews = latestReviewVerdicts([
    review({ runner: 'codex' }),
    review({ runner: 'claude', verdict: 'issues', unresolvedCount: 1 }),
  ]);
  const guard = approvePublishGuard({
    acceptance: acceptance(['AC-1', 'AC-2']),
    reviews,
    requiredReviews: 1,
  });
  assert.deepEqual(guard, {
    acceptanceReasons: [],
    reviewReasons: ['Latest claude review is issues · 1 unresolved'],
  });
  assert.deepEqual(withheld(GATE_ACTIONS, guard)[0], [
    'approve-publish',
    'Latest claude review is issues · 1 unresolved',
  ]);
  // The overrides exist for exactly this state; withholding them would remove them.
  assert.deepEqual(withheld(OVERRIDES, guard), [
    [APPROVE_PUBLISH_UNRESOLVED_ACTION, null],
    [APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION, null],
    ['ready', 'Latest claude review is issues · 1 unresolved'],
    ['hold', null],
  ]);
  assert.deepEqual(
    approvePublishGuard({
      acceptance: acceptance(['AC-1', 'AC-2']),
      reviews: [],
      requiredReviews: 1,
    }).reviewReasons,
    ['No review verdict yet'],
  );
});

test('a gate whose policy requires no review is not blocked for having none', () => {
  assert.deepEqual(
    approvePublishGuard({
      acceptance: acceptance(['AC-1', 'AC-2']),
      reviews: [],
      requiredReviews: 0,
    }),
    { acceptanceReasons: [], reviewReasons: [] },
  );
});

test('approve-publish is sendable once every criterion is judged and every reviewer approves', () => {
  const guard = approvePublishGuard({
    acceptance: acceptance(['AC-1', 'AC-2']),
    reviews: approvals,
    requiredReviews: 1,
  });
  assert.ok(gateReviewActions(GATE_ACTIONS, guard).every((action) => !action.disabledReason));
});

test('criteria that are loading or unavailable cannot clear the guard', () => {
  assert.deepEqual(
    approvePublishGuard({ acceptance: null, reviews: approvals, requiredReviews: 1 })
      .acceptanceReasons,
    ['Acceptance criteria are still loading'],
  );
  assert.deepEqual(
    approvePublishGuard({
      acceptance: null,
      acceptanceError: 'bad json',
      reviews: approvals,
      requiredReviews: 1,
    }).acceptanceReasons,
    ['Acceptance criteria unavailable: bad json'],
  );
});

test('a gate is guarded with its own review requirement and the run it belongs to', () => {
  const judged = { view: acceptance(['AC-1', 'AC-2']), error: null };
  const run = { engineState: { publishGate: { reviews: [] } } } as never;
  // A publication gate needs a review; with none live or in its snapshot, approve is withheld.
  const payload = gateDecision().payload as ReadyGatePayload;
  const unreviewed = gateDecision({ payload: { ...payload, reviews: [] } });
  assert.equal(
    humanGateGuard(run, unreviewed, judged).actions[0].disabledReason,
    'No review verdict yet',
  );
  // Without its run the gate cannot show its criteria, so approval is withheld.
  assert.deepEqual(humanGateGuard(null, gateDecision(), judged).guard.acceptanceReasons, [
    "Acceptance criteria unavailable: the gate's run is not loaded",
  ]);
});

test('open findings or a running fix withhold every publish approval, overrides included', () => {
  const judged = { view: acceptance(['AC-1', 'AC-2']), error: null };
  const gate = gateDecision({ actions: [...OVERRIDES, GATE_ACTIONS[0]] });
  const findings: Pick<Run, 'status' | 'agentContexts' | 'engineState'> = {
    status: 'human-gating',
    agentContexts: [],
    engineState: {
      publishGate: { reviews: [review({ verdict: 'issues', unresolvedCount: 2 })] },
    },
  };
  assert.deepEqual(
    humanGateGuard(findings, gate, judged).actions.map((action) => [
      action.id,
      action.disabledReason,
    ]),
    [
      [
        APPROVE_PUBLISH_UNRESOLVED_ACTION,
        'Review found 2 issues. Fix and pass review before publishing.',
      ],
      [
        APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
        'Review found 2 issues. Fix and pass review before publishing.',
      ],
      ['ready', 'Review found 2 issues. Fix and pass review before publishing.'],
      ['hold', null],
      ['approve-publish', 'Review found 2 issues. Fix and pass review before publishing.'],
    ],
  );
  // The gate's checked findings offer accepting them, and only that (ADR-065 Amendment 8).
  assert.deepEqual(
    gateReviewActions(
      gate.actions,
      humanGateGuard(findings, gate, judged).guard,
      ACCEPTABLE,
      'Review found 2 issues. Fix and pass review before publishing.',
    ).map((action) => [action.id, action.disabledReason]),
    [
      [APPROVE_PUBLISH_UNRESOLVED_ACTION, null],
      [
        APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
        'Review found 2 issues. Fix and pass review before publishing.',
      ],
      ['ready', 'Review found 2 issues. Fix and pass review before publishing.'],
      ['hold', null],
      ['approve-publish', 'Review found 2 issues. Fix and pass review before publishing.'],
    ],
  );
  const fixing: Pick<Run, 'status' | 'agentContexts' | 'engineState'> = {
    status: 'fixing',
    agentContexts: [],
    engineState: { publishGate: { reviews: [review({})] } },
  };
  assert.equal(
    humanGateGuard(fixing, gate, judged).actions.at(-1)?.disabledReason,
    'Review fix in progress.',
  );
});

test('combined approval uses the checked mixed reasons without a second acceptance-only block', () => {
  const readiness: RunGateReadiness = {
    ...ACCEPTABLE,
    reasons: [
      ...ACCEPTABLE.reasons,
      {
        code: 'evidence-policy-unsatisfied',
        prerequisite: 'evidence',
        evidencePolicy: 'claim-verdict',
        message: 'AC-4 production-state proof is missing.',
      },
    ],
  };
  const actions: DecisionAction[] = [
    {
      id: APPROVE_PUBLISH_UNRESOLVED_ACTION,
      label: 'Accept findings, attest evidence and publish',
      style: 'danger',
    },
  ];
  const guard = {
    acceptanceReasons: ['AC-4 requires production-state proof'],
    reviewReasons: ['Open findings'],
  };
  assert.deepEqual(withheld(actions, guard, readiness), [
    [APPROVE_PUBLISH_UNRESOLVED_ACTION, null],
  ]);
  assert.notEqual(
    withheld(actions, guard, {
      ...readiness,
      reasons: [
        ...readiness.reasons,
        {
          code: 'acceptance-incomplete',
          prerequisite: 'acceptance',
          message: 'An AC has no registered verdict.',
        },
      ],
    })[0]![1],
    null,
  );
});
