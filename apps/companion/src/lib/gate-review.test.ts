import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVE_PUBLISH_ACTION,
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  type DecisionAction,
  type IndependentReviewStatus,
  type ReadyGatePayload,
  type RunDecision,
} from '@farmslot/protocol';
import { colors } from '@farmslot/theme';

import {
  approvePublishGuard,
  gateIndependentReviews,
  gateRequiredReviewCount,
  gateReviewActions,
  gateReviewHref,
  gateReviewSummary,
  humanGateGuard,
  latestReviewVerdicts,
  openHumanGateDecision,
} from './gate-review';
import { acceptanceLedgerView } from './task-progress-view';

const GATE_ACTIONS: DecisionAction[] = [
  { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
  { id: 'hold', label: 'Hold', style: 'secondary' },
  { id: 'request-extra-review', label: 'Request Independent Review', style: 'secondary' },
  {
    id: 'request-cross-runner-review',
    label: 'Request Independent Review (runner diversity)',
    style: 'secondary',
  },
];

function review(overrides: Partial<IndependentReviewStatus>): IndependentReviewStatus {
  return {
    id: 'review',
    source: 'dispatch',
    runner: 'codex',
    crossRunner: false,
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
    independentReviews: [review({ id: 'snapshot', runner: 'claude' })],
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
    gateIndependentReviews(
      { engineState: { publishGate: { independentReviews: live } } } as never,
      gateDecision(),
    ).map((entry) => entry.id),
    ['live'],
  );
  assert.deepEqual(
    gateIndependentReviews({ engineState: undefined } as never, gateDecision()).map(
      (entry) => entry.id,
    ),
    ['snapshot'],
  );
});

test('each reviewer runner contributes only its latest verdict; self-review never does', () => {
  const verdicts = latestReviewVerdicts([
    review({ id: 'codex-1', runner: 'codex', verdict: 'issues', unresolvedCount: 2 }),
    review({
      id: 'codex-2',
      runner: 'codex',
      verdict: 'pass',
      completedAt: '2026-10-11T10:30:00.000Z',
    }),
    review({ id: 'claude-1', runner: 'claude', verdict: 'pass' }),
    review({ id: 'self', source: 'self-review', runner: 'cursor', verdict: 'issues' }),
    // The gateway also recognises a self-review by its id, whatever the source says.
    review({ id: 'self-review-2', runner: 'cursor', verdict: 'issues' }),
  ]);
  assert.deepEqual(
    verdicts.map((verdict) => [verdict.runner, verdict.label, verdict.approved]),
    [
      ['claude', 'pass', true],
      ['codex', 'pass', true],
    ],
  );
  assert.equal(verdicts[0].color, colors.statusOk);
});

test('a stale pass or open findings are not an approval', () => {
  const [stale, findings] = latestReviewVerdicts([
    review({ runner: 'a', stale: true }),
    review({ runner: 'b', verdict: 'issues', unresolvedCount: 3 }),
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

const approvals = latestReviewVerdicts([review({ runner: 'codex' }), review({ runner: 'claude' })]);

test('a later loop is the latest review even when an earlier loop finished afterwards', () => {
  const [codex] = latestReviewVerdicts([
    review({ id: 'r1', loopNumber: 1, startedAt: '2026-10-11T09:00:00.000Z' }),
    review({
      id: 'r2',
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
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: true,
          extraLoopsRequested: 1,
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

const withheld = (actions: DecisionAction[], guard: ReturnType<typeof approvePublishGuard>) =>
  gateReviewActions(actions, guard).map((action) => [action.id, action.disabledReason]);

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
    ['request-extra-review', null],
    ['request-cross-runner-review', null],
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
    ['No independent review verdict yet'],
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
  const run = { engineState: { publishGate: { independentReviews: [] } } } as never;
  // A publication gate needs a review; with none live or in its snapshot, approve is withheld.
  const payload = gateDecision().payload as ReadyGatePayload;
  const unreviewed = gateDecision({ payload: { ...payload, independentReviews: [] } });
  assert.equal(
    humanGateGuard(run, unreviewed, judged).actions[0].disabledReason,
    'No independent review verdict yet',
  );
  // Without its run the gate cannot show its criteria, so approval is withheld.
  assert.deepEqual(humanGateGuard(null, gateDecision(), judged).guard.acceptanceReasons, [
    "Acceptance criteria unavailable: the gate's run is not loaded",
  ]);
});
