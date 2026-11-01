import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type CompleteStepOutput,
  type PublicationReviewLaunchRejection,
  type RecipeRepairScope,
  type ReviewRequestContext,
  type ReviewSelection,
  type ReviewStatus,
  type Run,
  type RunDecision,
  type RunGatePrerequisiteReason,
  SEND_BACK_TO_AGENT_ACTION,
} from '@farmslot/protocol';
import { reviewRequestFromSequence } from '@farmslot/review-dispatch';

import { firstOutputFixture } from '../evals/first-output.test-support.js';
import {
  finalizeEvalResultPackageForRun,
  readFrozenEvalFirstOutputPackage,
} from '../evals/package-store.js';
import type { ReviewOptions } from '../review/orchestrator.js';
import {
  admitReviewRound,
  runReviewRoundBudget,
  settleReviewRoundNoVerdict,
} from '../review/review-round-budget.js';
import type { PrepareCompletionPackageResult } from '../run-completion/orchestrator.js';
import { captureRunOutput } from '../run-completion/output.js';
import {
  computeReadyGatePackageHash,
  computeReadyGateReviewSubjectHash,
} from '../run-completion/ready-gate-package.js';
import { buildResultDecision, ResultDecisionHoldError } from '../run-completion/result-decision.js';
import { retainedRunArtifactManifest } from '../run-completion/retained-artifacts.js';
import { createRun, getRun, updateRun, updateRunStep } from '../runs/store.js';

import { RunGateNotReadyError } from './gate-prerequisites.js';
import {
  baseReviewPolicy,
  executeCompleteStep,
  executeHumanGateStep,
  executeReviewStep,
  holdInteractiveCompletionForOperator,
  isFlowTerminalStep,
  persistedUpdateBranchNeedsReview,
  type PostDispatchStepContext,
  readyGateReviewSubjectMatches,
  reconcilePublishGateReviewPlanResult,
  shouldSkipRetrospectiveAtComplete,
} from './post-dispatch-steps.js';
import { shouldPrepareLocalFirstPackage } from './publication-policy.js';
import { executePublishGateReviewPlan as executeGateReviewPlan } from './ready-gate.js';
import { deleteTestRunIfPresent, makeReadyGatePackage, makeRun } from './test-fixtures.js';

for (const verdict of ['pass', 'issues', 'failed'] as const) {
  test(`review reconciliation retains unfinished rows and lineage after ${verdict}`, async (t) => {
    const run = createRun({
      project: 'review-recovery',
      flowType: 'dev',
      ticketOrPr: `LINEAGE-${verdict}`,
    });
    t.after(() => deleteTestRunIfPresent(run.id));
    const head = 'a'.repeat(40);
    const plan: ReviewSelection[] = [
      { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
      { runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'warm' },
    ];
    const context = {
      reviewLineages: [
        null,
        { repository: 'example/recovery', prNumber: 42, reviewId: 'codex-lineage' },
      ],
    };
    const review: ReviewStatus = {
      id: 'attempted',
      source: 'human-gate',
      loopNumber: 1,
      ...plan[0],
      verdict,
      unresolvedCount: verdict === 'issues' ? 1 : 0,
      reviewerSessionId: 'native-session',
      reviewedHeadSha: head,
    };
    updateRun(run.id, {
      reviewRoundAdmissions: Array.from({ length: 7 }, (_, index) => `spent-${index}`),
      reviewBudgetExtensions: [
        {
          requestId: 'scoped-extension',
          runId: run.id,
          project: run.project,
          branch: 'owned',
          headSha: head,
          previousLimit: 5,
          limit: 8,
          scopeBrief: 'Finish the approved native pair.',
          principalId: 'fixture-lead-service',
          principalSubject: { type: 'service', displayName: 'Fixture lead' },
          approvedAt: '2026-10-15T00:00:00Z',
        },
      ],
      engineState: {
        publishGate: { reviews: [review], reviewSequence: plan, reviewSequenceContext: context },
      },
    });
    await reconcilePublishGateReviewPlanResult(
      run.id,
      plan,
      { reviewIds: ['attempted'] },
      {
        getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
        prepareCompletionPackageForRun: async () => ({
          completion: {
            prNumber: null,
            ciRepo: null,
            artifactsCopied: true,
            prCommentPosted: false,
            prTitleUpdated: false,
            prMarkedReady: false,
            retrospectiveCreated: false,
            artifacts: [],
          },
          prPackage: makeReadyGatePackage(),
          reviews: [review],
          reviewPolicy: { minimumReviews: 2, requestedBy: 'human-gate' },
        }),
      },
    );
    const latest = getRun(run.id)!;
    const passed = verdict === 'pass' ? 1 : 0;
    assert.deepEqual(latest.engineState?.publishGate?.reviewSequence, plan.slice(passed));
    assert.deepEqual(
      latest.engineState?.publishGate?.reviewSequenceContext?.reviewLineages,
      context.reviewLineages.slice(passed),
    );
    const budget = await runReviewRoundBudget(latest);
    assert.equal(budget.used, 7);
    assert.equal(budget.limit, 8);
    assert.equal(budget.remaining, 1);
    assert.deepEqual(latest.engineState?.publishGate?.reviews, [review]);
  });
}

function restartReplayContext(): PostDispatchStepContext {
  return {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-unused',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => true,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  };
}

test('gate entry replaces a stale operator-wait label before configuration awaits', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'GATE-PREPARATION' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { status: 'human-gating' });
  updateRunStep(run.id, 'human-gate', {
    status: 'running',
    detail: 'Waiting for operator decision',
  });
  const stop = new Error('Observed gate preparation before configuration');
  await assert.rejects(
    executeHumanGateStep(run.id, {
      ...restartReplayContext(),
      isHumanGateEnabled: async () => {
        assert.deepEqual(getRun(run.id)!.decisions, []);
        assert.equal(
          getRun(run.id)!.steps.find((step) => step.name === 'human-gate')!.detail,
          'Preparing operator decision',
        );
        throw stop;
      },
    }),
    (error) => error === stop,
  );
});

test('complete re-entry with zero pending decisions restores Codex after a current-head native PASS', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'review-replay-'));
  const run = createRun({
    project: 'review-replay',
    flowType: 'fix-bug',
    mode: 'autonomous',
    ticketOrPr: 'REPLAY-1',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
  });
  const head = 'a'.repeat(40);
  const plan: ReviewSelection[] = [
    { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
    { runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'cold' },
  ];
  await mkdir(path.join(taskDir, 'artifacts'));
  await writeFile(
    path.join(taskDir, 'artifacts/pr-package.json'),
    JSON.stringify(makeReadyGatePackage({ headSha: head })),
  );
  updateRun(run.id, {
    status: 'human-gating',
    slotId: 'isolated-review-slot',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [{ name: 'human-gate', status: 'running' }],
    reviewRoundAdmissions: Array.from({ length: 7 }, (_, index) => `spent-${index}`),
    decisions: [],
    reviewBudgetExtensions: [
      {
        requestId: 'remaining-pair',
        runId: run.id,
        project: run.project,
        branch: 'owned',
        headSha: head,
        previousLimit: 7,
        limit: 8,
        scopeBrief: 'Complete the scoped native pair.',
        principalId: 'fixture-lead-service',
        principalSubject: { type: 'service', displayName: 'Fixture lead' },
        approvedAt: '2026-10-15T00:00:00Z',
      },
    ],
    agentContexts: [
      {
        id: 'rev-second',
        role: 'review',
        label: 'Second reviewer',
        status: 'complete',
        runId: run.id,
        slotId: 'isolated-review-slot',
        runner: plan[1].runner,
        model: plan[1].model,
        effort: plan[1].effort,
        runnerSessionId: 'old-session',
      },
      {
        id: 'rev-first',
        role: 'review',
        label: 'First reviewer',
        status: 'complete',
        runId: run.id,
        slotId: 'isolated-review-slot',
        runner: plan[0].runner,
        model: plan[0].model,
        effort: plan[0].effort,
        runnerSessionId: 'native-session',
      },
    ],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviewPolicy: { minimumReviews: 2, requestedBy: 'human-gate' },
        reviewSequence: [{ ...plan[0], mode: 'warm' }],
        reviewSequenceRequestedAt: '2026-10-15T00:02:00Z',
        reviews: [
          {
            id: 'native-pass',
            source: 'dispatch',
            loopNumber: 7,
            ...plan[0],
            verdict: 'pass',
            unresolvedCount: 0,
            reviewerSessionId: 'native-session',
            reviewedHeadSha: head,
            completedAt: '2026-10-15T00:01:00Z',
          },
        ],
      },
    },
  });
  const retained = structuredClone(getRun(run.id)!);
  const [secondReviewer, passingReviewer] = retained.agentContexts!;
  const olderReviewer = {
    ...passingReviewer,
    id: 'old-first',
    runnerSessionId: 'old-first-session',
  };
  for (const contexts of [
    [olderReviewer, secondReviewer, passingReviewer],
    [passingReviewer, olderReviewer, secondReviewer],
  ]) {
    updateRun(run.id, {
      agentContexts: contexts,
      engineState: structuredClone(retained.engineState),
      steps: structuredClone(retained.steps),
    });
    assert.equal(getRun(run.id)!.decisions.filter((decision) => !decision.resolvedAt).length, 0);
    await assert.rejects(
      executeHumanGateStep(run.id, {
        ...restartReplayContext(),
        executePublishGateReviewPlan: async (_id, _slot, actualPlan) => {
          assert.deepEqual(actualPlan, [plan[1]]);
          throw new Error('Remaining Codex reviewer reached');
        },
      }),
      /Remaining Codex reviewer reached/,
    );
    assert.deepEqual(getRun(run.id)!.engineState?.publishGate?.reviewSequence, [plan[1]]);
    assert.match(String(getRun(run.id)!.steps[0].outputs?.reviewRecoveryNote), /Using COLD/);
    assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length, 7);
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.equal(budget.used, 7);
    assert.equal(budget.limit, 8);
    assert.equal(budget.remaining, 1);
  }
});

const rowOneHead = 'b'.repeat(40);
const codexRow: ReviewSelection = {
  runner: 'codex',
  model: 'gpt-6.1-sol',
  effort: null,
  mode: 'cold',
};
const claudeRow: ReviewSelection = { runner: 'claude', model: 'opus', effort: null, mode: 'cold' };

/** What the REVIEW step recorded after running a row (codex's default effort). */
function pipelineReview(
  reviewedHeadSha = rowOneHead,
  ran: Pick<ReviewStatus, 'runner' | 'model' | 'effort'> = {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
  },
  completedAt = '2026-10-19T00:01:00Z',
): ReviewStatus {
  return {
    id: 'pipeline-review-1',
    source: 'pipeline',
    mode: 'cold',
    ...ran,
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewerSessionId: `pipeline-session-${completedAt}`,
    reviewedHeadSha,
    completedAt,
  };
}

/** A fix-bug run at its publication gate, with its package prepared at `rowOneHead`. */
async function publicationGateRun(
  t: import('node:test').TestContext,
  publishGate: NonNullable<Run['engineState']>['publishGate'],
): Promise<string> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-row-one-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'artifacts'));
  await writeFile(
    path.join(taskDir, 'artifacts/pr-package.json'),
    JSON.stringify(makeReadyGatePackage({ headSha: rowOneHead })),
  );
  const run = createRun({
    project: 'pipeline-row-one',
    flowType: 'fix-bug',
    mode: 'autonomous',
    ticketOrPr: 'ROW-ONE',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    slotId: 'isolated-review-slot',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [
      { name: 'review', status: 'done' },
      { name: 'human-gate', status: 'running' },
    ],
    decisions: [],
    engineState: { publishGate: { publicationStatus: 'not_published', ...publishGate } },
  });
  return run.id;
}

interface GateReviewRequest {
  plan: ReviewSelection[];
  trigger: string;
  lineages?: ReviewRequestContext['reviewLineages'];
}

/** Enters the gate and returns the review plans it requested; `interrupt` fails the first one. */
async function enterPublicationGate(
  runId: string,
  interrupt = false,
): Promise<GateReviewRequest[]> {
  const requested: GateReviewRequest[] = [];
  const entry = executeHumanGateStep(runId, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async (_runId, _slotId, plan, trigger) => {
      requested.push({
        plan,
        trigger,
        lineages: getRun(runId)!.engineState?.publishGate?.reviewSequenceContext?.reviewLineages,
      });
      if (interrupt) throw new Error('gateway restarted mid-review');
      return { reviewIds: [] };
    },
    prepareCompletionPackageForRun: async () => ({
      completion: {
        prNumber: null,
        ciRepo: null,
        artifactsCopied: true,
        prCommentPosted: false,
        prTitleUpdated: false,
        prMarkedReady: false,
        retrospectiveCreated: false,
        artifacts: [],
      },
      prPackage: makeReadyGatePackage({ headSha: rowOneHead }),
      reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
      reviews: [],
    }),
  });
  if (interrupt) await assert.rejects(entry, /gateway restarted mid-review/);
  else await entry;
  return requested;
}

test('the gate counts a passing pipeline review of its head as the dispatch row 1', async (t) => {
  const plan = [codexRow, claudeRow];
  const dispatched = (reviewedHeadSha: string): NonNullable<Run['engineState']>['publishGate'] => ({
    reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
    reviewSequence: plan,
    reviewSequenceContext: { reviewLineages: [null, null] },
    reviews: [pipelineReview(reviewedHeadSha)],
  });

  assert.deepEqual(
    await enterPublicationGate(await publicationGateRun(t, dispatched(rowOneHead))),
    [{ plan: [claudeRow], trigger: 'dispatch', lineages: [null] }],
    'only rows 2..n run, with their own lineages',
  );
  assert.deepEqual(
    await enterPublicationGate(await publicationGateRun(t, dispatched('c'.repeat(40)))),
    [{ plan, trigger: 'dispatch', lineages: [null, null] }],
    'a pipeline review of an older head leaves row 1 to run again',
  );
  assert.deepEqual(
    await enterPublicationGate(
      await publicationGateRun(t, {
        reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
        reviews: [pipelineReview()],
      }),
    ),
    [],
    'a run without a sequence is unchanged',
  );
});

test('a WARM row 1 runs at the gate with its lineage despite a passing COLD pipeline review', async (t) => {
  const lineage = { repository: 'example/app', prNumber: 7, reviewId: 'review-lineage-1' };
  const warmRow: ReviewSelection = { ...codexRow, mode: 'warm' };
  const runId = await publicationGateRun(t, {
    reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
    reviewSequence: [warmRow, claudeRow],
    reviewSequenceContext: { reviewLineages: [lineage, null] },
    reviews: [pipelineReview()],
  });

  assert.deepEqual(await enterPublicationGate(runId), [
    { plan: [warmRow, claudeRow], trigger: 'dispatch', lineages: [lineage, null] },
  ]);
});

test('a gate restart after counting the pipeline review keeps the remaining row', async (t) => {
  const runId = await publicationGateRun(t, {
    reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
    reviewSequence: [codexRow, codexRow],
    reviews: [pipelineReview()],
  });
  const remaining = [{ plan: [codexRow], trigger: 'dispatch', lineages: undefined }];

  assert.deepEqual(await enterPublicationGate(runId, true), remaining, 'row 2 starts');
  assert.deepEqual(
    await enterPublicationGate(runId, true),
    remaining,
    'the same-runner pipeline review is not counted again for row 2',
  );
  const latest = getRun(runId)!;
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviews: [
          ...(latest.engineState?.publishGate?.reviews ?? []),
          {
            ...pipelineReview(),
            id: 'gate-row-2',
            source: 'dispatch',
            reviewerSessionId: 'gate-row-2-session',
            completedAt: new Date().toISOString(),
          },
        ],
      },
    },
  });
  assert.deepEqual(await enterPublicationGate(runId), [], 'row 2 passed');
});

test('a plan requested at the human gate neither selects nor is satisfied by the pipeline review', async (t) => {
  const runId = await publicationGateRun(t, {
    reviewPolicy: { minimumReviews: 1, requestedBy: 'human-gate' },
    reviewSequence: [codexRow],
    reviews: [pipelineReview()],
  });
  const calls: Array<ReviewOptions | undefined> = [];
  await executeReviewStep(runId, {
    ...restartReplayContext(),
    executeReviewForRun: async (_runId, _slotId, options) => {
      calls.push(options);
      return { verdict: 'pass', retryCount: 0 };
    },
  });
  assert.equal(calls[0]?.reviewRunner, undefined, 'the project config selects the reviewer');

  assert.deepEqual(await enterPublicationGate(runId), [
    { plan: [codexRow], trigger: 'human-gate', lineages: undefined },
  ]);
});

test('a review replay after the gate trimmed the sequence runs the project config, not row 2', async (t) => {
  const runId = await publicationGateRun(t, {
    reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
    reviewSequence: [codexRow, claudeRow],
    reviews: [pipelineReview()],
  });
  await enterPublicationGate(runId, true);
  assert.deepEqual(getRun(runId)!.engineState?.publishGate?.reviewSequence, [claudeRow]);

  const calls: Array<ReviewOptions | undefined> = [];
  const io = await executeReviewStep(runId, {
    ...restartReplayContext(),
    executeReviewForRun: async (_runId, _slotId, options) => {
      calls.push(options);
      return { verdict: 'pass', retryCount: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    ['reviewRunner', 'model', 'effort'].filter((key) => key in (calls[0] ?? {})),
    [],
  );
  assert.equal(io.inputs?.reviewSelection, undefined);

  // The replayed review ran the project's claude/opus. It is not row 2's result.
  const latest = getRun(runId)!;
  updateRun(runId, {
    engineState: {
      ...latest.engineState,
      publishGate: {
        ...latest.engineState?.publishGate,
        reviews: [
          pipelineReview(
            rowOneHead,
            { runner: 'claude', model: 'opus', effort: null },
            new Date().toISOString(),
          ),
        ],
      },
    },
  });
  assert.deepEqual(await enterPublicationGate(runId), [
    { plan: [claudeRow], trigger: 'dispatch', lineages: undefined },
  ]);
});

test('artifact-only QA complete identifies execution completion to the canonical gate guard', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'QA-GAPS' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    flowType: 'qa',
    status: 'completing',
    completionPolicy: 'artifact-only',
    slotId: 'qa-guard-test-slot',
  });
  await assert.rejects(
    executeCompleteStep(run.id, {
      ...restartReplayContext(),
      assertGatePrerequisites: async (checked, prepared, action) => {
        assert.equal(checked.id, run.id);
        assert.equal(prepared, null);
        assert.equal(action, 'complete');
        throw new Error('Stop before resource or completion side effects');
      },
    }),
    /Stop before resource or completion side effects/,
  );
});

// 05b37f1c: a gateway restart stopped COMPLETE's media transfer after its report committed.
// The restarted COMPLETE refused that capture while its source still held the media.
test('complete resumes an interrupted retained media transfer before validating evidence', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'MEDIA-1' });
  t.after(() => deleteTestRunIfPresent(run.id));
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'complete-retained-media-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const media = 'artifacts/screenshots/after.png';
  await mkdir(path.join(taskDir, 'artifacts/screenshots'), { recursive: true });
  await writeFile(path.join(taskDir, 'artifacts/report.md'), '# Report\n');
  await writeFile(path.join(taskDir, media), 'after image');
  updateRun(run.id, {
    status: 'completing',
    completionPolicy: 'artifact-only',
    slotId: 'retained-media-slot',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  await assert.rejects(
    captureRunOutput(run.id, false, true, {
      acquisition: {
        media: [],
        beforeCopy: () => async () => true,
        acquireMedia: async () => {
          throw new Error('gateway stopped during media transfer');
        },
      },
    }),
    /gateway stopped/,
  );
  const availability = async (current: Run) =>
    (await retainedRunArtifactManifest(current)).find(({ path: file }) => file === media)
      ?.availability;
  assert.equal(await availability(getRun(run.id)!), 'missing');

  const validated = new Error('evidence validation reached');
  await assert.rejects(
    executeCompleteStep(run.id, {
      ...restartReplayContext(),
      assertGatePrerequisites: async (current) => {
        assert.equal(await availability(current), 'available');
        throw validated;
      },
    }),
    (error) => error === validated,
  );
});

function completionRefusal(
  run: Run,
  codes: RunGatePrerequisiteReason['code'][] = ['run-work-progressing'],
) {
  const reasons: RunGatePrerequisiteReason[] = codes.map((code) => ({
    code,
    prerequisite: 'lifecycle',
    message: code,
    actionId: 'hold',
  }));
  return new RunGateNotReadyError(
    { state: 'collecting', identity: { runId: run.id, generation: 0 }, reasons },
    reasons,
  );
}

test('PR completion with linked visual criteria reaches completion without a captured review hold', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'generic-project',
    ticketOrPr: 'example/repo#1',
    mode: 'autonomous',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'completing',
    slotId: 'pr-complete-visual-slot',
    acceptanceContractVersion: 1,
    acceptanceExecutionContract: Object.assign(
      {
        schemaVersion: 1 as const,
        runId: run.id,
        revision: 1,
        registrationRevision: 0,
        baseContractHash: 'b'.repeat(64),
        inheritedCriterionIds: [],
        proofModes: [
          { id: 'AC-1', text: 'Linked ticket visual criterion', proofMode: 'visual' as const },
        ],
      },
      { claimReviewGate: true, publicationReview: false },
    ),
  });
  const completionReached = new Error('completion prerequisite reached');
  await assert.rejects(
    executeCompleteStep(run.id, {
      ...restartReplayContext(),
      assertGatePrerequisites: async () => {
        throw completionReached;
      },
    }),
    (error) => error === completionReached,
  );
  const current = getRun(run.id)!;
  assert.equal(current.status, 'completing');
  assert.equal(
    current.decisions.some(({ payload }) => payload?.kind === 'output-review'),
    false,
  );
  assert.deepEqual(current.acceptanceExecutionContract?.proofModes, [
    { id: 'AC-1', text: 'Linked ticket visual criterion', proofMode: 'visual' },
  ]);
});

test('completion waits through the final native turn and then revalidates QA', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'QA-IDLE' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { flowType: 'qa', status: 'completing', slotId: 'qa-idle-test-slot' });
  let checked = 0;
  let waits = 0;
  await assert.rejects(
    executeCompleteStep(run.id, {
      ...restartReplayContext(),
      assertGatePrerequisites: async (current, prepared, action) => {
        assert.equal(prepared, null);
        assert.equal(action, 'complete');
        if (++checked < 3) throw completionRefusal(current);
        return { state: 'ready', identity: { runId: current.id, generation: 0 }, reasons: [] };
      },
      waitForCompletionProgress: async () => {
        waits++;
        assert.equal(getRun(run.id)?.status, 'completing');
        assert.match(
          getRun(run.id)?.steps.find(({ name }) => name === 'complete')?.detail ?? '',
          /native turn/,
        );
      },
    }),
    /QA evidence incomplete/,
  );
  assert.equal(checked, 3, 'the canonical guard is rerun after native progress');
  assert.equal(waits, 2);
  assert.equal(getRun(run.id)?.slotId, 'qa-idle-test-slot');
});

for (const interruption of ['paused', 'cancelled', 'replayed'] as const) {
  test(`completion wait preserves operator ${interruption} ownership`, async (t) => {
    const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'QA-IDLE' });
    t.after(() => deleteTestRunIfPresent(run.id));
    updateRun(run.id, { status: 'completing', slotId: 'qa-idle-test-slot' });
    let checked = 0;
    await assert.rejects(
      executeCompleteStep(run.id, {
        ...restartReplayContext(),
        assertGatePrerequisites: async (current) => {
          checked++;
          throw completionRefusal(current);
        },
        waitForCompletionProgress: async () => {
          updateRun(
            run.id,
            interruption === 'replayed'
              ? { engineState: { ...getRun(run.id)?.engineState, generation: 1 } }
              : { status: interruption },
          );
        },
      }),
      /Completion was superseded/,
    );
    assert.equal(checked, 1);
    assert.equal(getRun(run.id)?.status, interruption === 'replayed' ? 'completing' : interruption);
    assert.equal(getRun(run.id)?.slotId, 'qa-idle-test-slot');
  });
}

for (const codes of [
  ['run-progress-unconfirmed'],
  ['run-work-progressing', 'evidence-selection-invalid'],
] satisfies RunGatePrerequisiteReason['code'][][]) {
  test(`completion does not retry prerequisite refusal ${codes.join(', ')}`, async (t) => {
    const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'QA-IDLE' });
    t.after(() => deleteTestRunIfPresent(run.id));
    updateRun(run.id, { status: 'completing', slotId: 'qa-idle-test-slot' });
    const refusal = completionRefusal(run, codes);
    await assert.rejects(
      executeCompleteStep(run.id, {
        ...restartReplayContext(),
        assertGatePrerequisites: async () => {
          throw refusal;
        },
        waitForCompletionProgress: async () => {
          assert.fail('non-progress prerequisites must not wait');
        },
      }),
      (error) => error === refusal,
    );
  });
}

test('interactive completion hold persists operator state without completing monitor', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    project: 'example-mobile-farm',
    ticketOrPr: 'DEV-1',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  updateRun(run.id, {
    status: 'monitoring',
    steps: run.steps.map((step) =>
      step.name === 'monitor'
        ? { ...step, status: 'running', startedAt: new Date(Date.now() - 1_000).toISOString() }
        : step,
    ),
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  holdInteractiveCompletionForOperator(run, { pollCount: 4 }, 'complete');

  const held = getRun(run.id)!;
  const monitor = held.steps.find((step) => step.name === 'monitor')!;
  assert.equal(held.status, 'paused');
  assert.equal(monitor.status, 'running');
  assert.equal(monitor.detail, 'Worker finished; waiting for operator action');
  assert.equal(monitor.outputs?.awaitingOperator, true);
  assert.equal(monitor.outputs?.workerTerminalSignalHeld, 'complete');
  assert.equal(monitor.outputs?.reason, 'interactive-completion-operator-owned');
  assert.ok((monitor.durationMs ?? 0) >= 1_000);
});

test('complete-step retrospective gating defers only CI-watch flows', () => {
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'fix-bug' })),
    true,
    'fix-bug retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'dev' })),
    true,
    'dev retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'update-branch' })),
    true,
    'update-branch retro belongs after terminal CI-watch, not complete',
  );
  assert.equal(
    shouldSkipRetrospectiveAtComplete(makeRun({ flowType: 'review-pr' })),
    false,
    'review-pr has human-gate but no CI-watch, so complete is terminal',
  );
});

test('executeReviewStep honors a persisted update-branch skip signal', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#42',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  updateRun(run.id, {
    steps: run.steps.map((step) =>
      step.name === 'monitor'
        ? {
            ...step,
            status: 'done',
            outputs: {
              workerSignal: { status: 'complete', needsReview: false },
            },
          }
        : step,
    ),
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let probeCalls = 0;
  const io = await executeReviewStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    monitorTerminalError: ({ reason }) => new Error(reason),
    probeWorkerSignalForRun: async () => {
      probeCalls += 1;
      throw new Error('persisted decision must avoid a redundant slot probe');
    },
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  assert.deepEqual(io, {
    inputs: { slotId: 'remote-mobile-1', enabled: false },
    outputs: {
      skipped: true,
      reason: 'worker-signal-trivial',
      workerSignalSource: 'persisted-monitor',
    },
  });
  assert.equal(probeCalls, 0);
});

test('persistedUpdateBranchNeedsReview requires a terminal update-branch signal', () => {
  const run = makeRun({ flowType: 'update-branch' });
  const withMonitor = (
    status: 'running' | 'done',
    workerSignal?: Record<string, unknown> | null,
  ) => ({
    ...run,
    steps: [{ name: 'monitor', status, outputs: { workerSignal } }],
  });

  assert.equal(
    persistedUpdateBranchNeedsReview(
      withMonitor('done', { status: 'complete', needsReview: false }),
    ),
    false,
  );
  assert.equal(
    persistedUpdateBranchNeedsReview(
      withMonitor('running', { status: 'complete', needsReview: false }),
    ),
    undefined,
  );
  assert.equal(
    persistedUpdateBranchNeedsReview(
      withMonitor('done', { status: 'complete', needsReview: true }),
    ),
    true,
  );
  assert.equal(
    persistedUpdateBranchNeedsReview(withMonitor('done', { status: 'complete' })),
    undefined,
  );
  assert.equal(persistedUpdateBranchNeedsReview(withMonitor('done', null)), undefined);
  assert.equal(
    persistedUpdateBranchNeedsReview(
      withMonitor('done', { status: 'running', needsReview: false }),
    ),
    undefined,
  );
  assert.equal(
    persistedUpdateBranchNeedsReview({
      ...withMonitor('done', { status: 'complete', needsReview: false }),
      flowType: 'dev',
    }),
    undefined,
  );
});

test('executeReviewStep honors the slot signal probe fallback', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#43',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let probeCalls = 0;
  const io = await executeReviewStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    monitorTerminalError: ({ reason }) => new Error(reason),
    probeWorkerSignalForRun: async () => {
      probeCalls += 1;
      return {
        ok: true,
        code: 'ready',
        message: 'ready',
        status: 'complete',
        signal: {
          status: 'complete',
          needsReview: false,
          timestamp: new Date().toISOString(),
        },
      };
    },
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  assert.deepEqual(io, {
    inputs: { slotId: 'remote-mobile-1', enabled: false },
    outputs: {
      skipped: true,
      reason: 'worker-signal-trivial',
      workerSignalSource: 'slot-probe',
    },
  });
  assert.equal(probeCalls, 1);
});

test('executeReviewStep proceeds when the slot signal probe cannot approve a skip', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'owner/repo#44',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let reviewCalls = 0;
  const io = await executeReviewStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    executeReviewForRun: async () => {
      reviewCalls += 1;
      return { verdict: 'pass', retryCount: 0 };
    },
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    monitorTerminalError: ({ reason }) => new Error(reason),
    probeWorkerSignalForRun: async () => ({
      ok: false,
      code: 'missing',
      message: 'signal missing',
    }),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  assert.equal(reviewCalls, 1);
  assert.equal(io.inputs?.enabled, true);
  assert.equal(io.outputs?.verdict, 'pass');
});

test('baseReviewPolicy is static for new runs and keeps a recorded or pre-migration live review', () => {
  assert.equal(baseReviewPolicy(makeRun({ steps: [] })), 'static-code');
  const recorded = makeRun({
    steps: [
      { name: 'review', status: 'running', inputs: { validationDepth: 'full-live' } },
    ] as Run['steps'],
  });
  assert.equal(baseReviewPolicy(recorded), 'full-live', 'recorded depth survives a restart');
  const preMigration: Run = {
    ...makeRun({ steps: [] }),
    agentContexts: [{ id: 'reviewer-1', role: 'review' }] as Run['agentContexts'],
  };
  assert.equal(
    baseReviewPolicy(preMigration),
    'full-live',
    'a base review launched before depth was recorded ran the live contract',
  );
  const publicationOnly: Run = {
    ...makeRun({ steps: [] }),
    agentContexts: [
      { id: 'reviewer-2', role: 'review', artifactScope: 'review-1' },
    ] as Run['agentContexts'],
  };
  assert.equal(
    baseReviewPolicy(publicationOnly),
    'static-code',
    'a publication reviewer is not a started base review',
  );
});

test('executeReviewStep records a static base review and replays the recorded depth', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-BASE-DEPTH',
    runner: 'claude',
    slotId: 'base-depth-slot',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });
  const depths: Array<string | undefined> = [];
  const context = {
    activeMonitors: new Map(),
    blockedRunError: (message: string, reason: string) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready' as const,
    executeReviewGate: async () => {},
    executeReviewForRun: async (
      _runId: string,
      _slotId: string | null | undefined,
      options?: { validationDepth?: string },
    ) => {
      depths.push(options?.validationDepth);
      return { verdict: 'pass' as const, retryCount: 0 };
    },
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    monitorTerminalError: ({ reason }: { reason: string }) => new Error(reason),
    probeWorkerSignalForRun: async () => ({
      ok: false as const,
      code: 'missing' as const,
      message: 'signal missing',
    }),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  } as unknown as Parameters<typeof executeReviewStep>[1];

  const io = await executeReviewStep(run.id, context);
  assert.equal(io.inputs?.validationDepth, 'static-code');
  assert.equal(
    getRun(run.id)?.steps.find((step) => step.name === 'review')?.inputs?.validationDepth,
    'static-code',
  );
  // A restarted engine re-enters the step: the recorded depth wins over the new default.
  const step = getRun(run.id)!.steps.find((candidate) => candidate.name === 'review')!;
  updateRun(run.id, {
    steps: getRun(run.id)!.steps.map((candidate) =>
      candidate === step
        ? { ...candidate, inputs: { ...candidate.inputs, validationDepth: 'full-live' } }
        : candidate,
    ),
  });
  await executeReviewStep(run.id, context);
  assert.deepEqual(depths, ['static-code', 'full-live']);
});

test('interactive send-feedback continues from existing findings without another initial review', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'interactive',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-45',
    runner: 'claude',
    slotId: 'remote-mobile-1',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  const issue = { file: 'src/example.ts', line: 12, description: 'Fix the stale state' };
  const calls: unknown[][] = [];
  const io = await executeReviewStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'send_feedback',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    executeReviewForRun: async (...args) => {
      calls.push([...args]);
      return calls.length === 1
        ? { verdict: 'issues', issues: [issue], retryCount: 0 }
        : { verdict: 'pass', issues: [], retryCount: 1 };
    },
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  assert.equal(calls.length, 2);
  assert.equal((calls[1]?.[2] as { mode?: string })?.mode, 'cold');
  assert.deepEqual((calls[1]?.[2] as { resumeFromResult?: unknown })?.resumeFromResult, {
    verdict: 'issues',
    issues: [issue],
    retryCount: 0,
  });
  assert.equal(io.outputs?.verdict, 'pass');
  assert.equal(io.outputs?.interactiveRetry, true);
});

test('the pipeline review runs the dispatch sequence row 1, else the project review config', async (t) => {
  const row: ReviewSelection = {
    runner: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    mode: 'cold',
  };
  const sequenced = createRun({
    flowType: 'fix-bug',
    mode: 'interactive',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-ROW-ONE',
    runner: 'claude',
    model: 'opus',
    slotId: 'remote-mobile-1',
    reviewSequence: [row, { runner: 'claude', model: 'opus', effort: null, mode: 'cold' }],
  });
  const unsequenced = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-NO-SEQUENCE',
    runner: 'claude',
    model: 'opus',
    slotId: 'remote-mobile-2',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(sequenced.id);
    await deleteTestRunIfPresent(unsequenced.id);
  });
  const calls: Array<ReviewOptions | undefined> = [];
  const context: PostDispatchStepContext = {
    ...restartReplayContext(),
    createEngineDecision: async () => 'send_feedback',
    executeReviewForRun: async (_runId, _slotId, options) => {
      calls.push(options);
      return calls.length === 1
        ? {
            verdict: 'issues',
            issues: [{ file: 'src/example.ts', description: 'Fix it' }],
            retryCount: 0,
          }
        : { verdict: 'pass', issues: [], retryCount: 1 };
    },
  };

  const io = await executeReviewStep(sequenced.id, context);
  assert.deepEqual(
    calls.map((options) => [options?.reviewRunner, options?.model, options?.effort]),
    [
      ['codex', 'gpt-6.1-sol', 'xhigh'],
      ['codex', 'gpt-6.1-sol', 'xhigh'],
    ],
    'the first review and its interactive retry',
  );
  assert.deepEqual(io.inputs?.reviewSelection, row, 'recorded for its rechecks');

  calls.length = 0;
  await executeReviewStep(unsequenced.id, {
    ...context,
    executeReviewForRun: async (_runId, _slotId, options) => {
      calls.push(options);
      return { verdict: 'pass', retryCount: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    ['reviewRunner', 'model', 'effort'].filter((key) => key in (calls[0] ?? {})),
    [],
  );
});

test('local-first complete contract uses gate-held disposition for dev and fix-bug', () => {
  assert.equal(shouldPrepareLocalFirstPackage(makeRun({ flowType: 'fix-bug' })), true);
  assert.equal(
    shouldPrepareLocalFirstPackage(makeRun({ flowType: 'dev', mode: 'autonomous' })),
    true,
  );
  const disposition: CompleteStepOutput['slotDisposition'] = 'gate-held';
  assert.equal(disposition, 'gate-held');
});

test('human-gate can approve a prepared local-first package when slot was detached (replay)', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-READY',
    runner: 'grok',
    engineState: {
      publishGate: {
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
      },
    },
  });
  updateRun(run.id, { slotId: null });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let markedSlot = false;
  const io = await executeHumanGateStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {
      markedSlot = true;
    },
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => {
      throw new Error('static ready gate should not request a live review slot');
    },
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 1, additions: 2, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => true,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  assert.equal(markedSlot, false, 'released-slot human gate must not mutate fleet state');
  assert.deepEqual(io.inputs, { gateType: 'ready', gateEnabled: true, forced: false });
  assert.equal(io.outputs?.resolvedAction, null);
  assert.equal(typeof io.outputs?.waitDurationMs, 'number');
});

test('human-gate restart repairs legacy review counts before deriving an automatic plan', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-LEGACY-REVIEW-COUNT',
    runner: 'claude',
    engineState: {
      publishGate: {
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'legacy-dispatch-review',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'legacy-dispatch-review',
            source: 'dispatch',
            runner: 'codex',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let reviewPlanCalls = 0;
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async () => {
      reviewPlanCalls += 1;
      return { reviewIds: [] };
    },
    executeReadyGate: async () => 'ready',
  });

  assert.equal(reviewPlanCalls, 0);
  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.reviewPolicy, {
    minimumReviews: 1,
    requestedBy: 'dispatch',
  });
});

test('human-gate restart replay restores the operator-requested review policy', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-REPLAY',
    runner: 'claude',
  });
  updateRun(run.id, {
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 2,
          requestedBy: 'dispatch',
        },
      },
    },
    decisions: [
      {
        id: 'decision-review-replay',
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: 'Request a cross-runner review',
        actions: [],
        createdAt: '2026-08-02T00:00:00.000Z',
        resolvedAt: '2026-08-02T00:01:00.000Z',
        resolvedAction: 'request-review',
        selectionData: {
          reviewRequest: reviewRequestFromSequence([
            { runner: 'codex', model: null, effort: null, mode: 'cold' },
          ]),
        },
      },
    ],
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  await assert.rejects(executeHumanGateStep(run.id, restartReplayContext()), /No slot assigned/);

  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.reviewPolicy, {
    minimumReviews: 2,
    requestedBy: 'human-gate',
  });
});

test('human-gate restart replay does not inherit a prior temporary review request', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-REPLAY-NEW',
    runner: 'claude',
  });
  updateRun(run.id, {
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 2,
          requestedBy: 'human-gate',
        },
      },
    },
    decisions: [
      {
        id: 'decision-review-replay-new',
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: 'Request one new review',
        actions: [],
        createdAt: '2026-08-02T00:00:00.000Z',
        resolvedAt: '2026-08-02T00:01:00.000Z',
        resolvedAction: 'request-review',
        selectionData: {
          reviewRequest: reviewRequestFromSequence([
            { runner: 'codex', model: null, effort: null, mode: 'cold' },
          ]),
        },
      },
    ],
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  await assert.rejects(executeHumanGateStep(run.id, restartReplayContext()), /No slot assigned/);

  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.reviewPolicy, {
    minimumReviews: 1,
    requestedBy: 'human-gate',
  });
});

test('human-gate partial review refusal retains only unconsumed work and rebuilds the package', async (t) => {
  const requestedAt = '2026-08-03T00:00:00.000Z';
  const plan: ReviewSelection[] = [
    { runner: 'codex', model: null, effort: null, mode: 'cold' as const },
    { runner: 'claude', model: null, effort: null, mode: 'cold' as const },
  ];
  const rejection: PublicationReviewLaunchRejection = {
    code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
    message: 'The slot worktree became dirty after the first review.',
    userAction: 'Commit or discard the changes before requesting another review.',
    rejectedAt: '2026-08-03T00:02:00.000Z',
  };
  const reviewPolicy = {
    minimumReviews: 1,
    requestedBy: 'dispatch' as const,
  };
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-PARTIAL-REVIEW',
    runner: 'claude',
    slotId: 'remote-mobile-1',
    engineState: {
      publishGate: {
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        reviewPolicy,
        reviewSequenceRequestedAt: requestedAt,
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'baseline-review',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'baseline-review',
            source: 'dispatch',
            runner: 'codex',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let readyGateCalls = 0;
  let packageRebuilds = 0;
  const preparedResult: PrepareCompletionPackageResult = {
    completion: {
      prNumber: null,
      ciRepo: null,
      artifactsCopied: true,
      prCommentPosted: false,
      prTitleUpdated: false,
      prMarkedReady: false,
      retrospectiveCreated: false,
      artifacts: [],
    },
    prPackage: makeReadyGatePackage(),
    reviewPolicy,
    reviews: [],
  };
  await executeHumanGateStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-unused',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async (_runId, _slotId, actualPlan, trigger) => {
      assert.deepEqual(actualPlan, plan);
      assert.equal(trigger, 'human-gate');
      const latest = getRun(run.id)!;
      updateRun(run.id, {
        engineState: {
          ...latest.engineState,
          publishGate: {
            ...latest.engineState?.publishGate,
            reviews: [
              ...(latest.engineState?.publishGate?.reviews ?? []),
              {
                id: 'r1',
                source: 'human-gate',
                loopNumber: 2,
                ...plan[0],
                verdict: 'pass',
                unresolvedCount: 0,
                reviewerSessionId: 'native-r1',
                reviewedHeadSha: 'fixture-head',
              },
            ],
          },
        },
      });
      return { reviewIds: ['r1'], rejection };
    },
    executeReadyGate: async () => {
      readyGateCalls += 1;
      if (readyGateCalls > 1) return 'ready';
      const latest = getRun(run.id)!;
      updateRun(run.id, {
        decisions: [
          {
            id: 'decision-partial-review',
            type: 'engine_human_gate',
            title: 'Publication gate',
            description: 'Request two reviews',
            actions: [],
            createdAt: requestedAt,
            resolvedAt: '2026-08-03T00:00:01.000Z',
            resolvedAction: 'request-review',
            selectionData: { reviewRequest: reviewRequestFromSequence(plan) },
          },
        ],
        engineState: {
          ...latest.engineState,
          publishGate: {
            ...latest.engineState?.publishGate,
            reviewSequence: plan,
            reviewSequenceRequestedAt: requestedAt,
          },
        },
      });
      return 'request-review';
    },
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 1, additions: 2, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => true,
    monitorTerminalError: ({ reason }) => new Error(reason),
    prepareCompletionPackageForRun: async (_runId, options) => {
      packageRebuilds += 1;
      assert.equal(options?.stampReviews, false);
      assert.equal(options?.requireArtifactMirror, true);
      return preparedResult;
    },
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  const persistedGate = getRun(run.id)?.engineState?.publishGate;
  assert.deepEqual(persistedGate?.reviewSequence, [plan[1]]);
  assert.notEqual(persistedGate?.reviewSequenceRequestedAt, requestedAt);
  assert.equal(packageRebuilds, 1);

  const afterFirstPass = getRun(run.id)!;
  updateRun(run.id, {
    engineState: {
      ...afterFirstPass.engineState,
      publishGate: {
        ...afterFirstPass.engineState?.publishGate,
        reviews: [
          ...(afterFirstPass.engineState?.publishGate?.reviews ?? []),
          {
            reviewerSessionId: 'fixture-session-' + 'r1',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'r1',
            source: 'human-gate',
            runner: 'codex',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            completedAt: '2026-08-03T00:02:00.000Z',
          },
        ],
      },
    },
  });
  let replayedPlan: ReviewSelection[] = [];
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async (_runId, _slotId, actualPlan) => {
      replayedPlan = actualPlan;
      return { reviewIds: [] };
    },
    prepareCompletionPackageForRun: async () => preparedResult,
  });
  assert.deepEqual(replayedPlan, [plan[1]], 'restart must retain the net remaining reviewer');
});

for (const operatorRequest of [false, true]) {
  test(`at the no-verdict cap, restart re-entry ${operatorRequest ? 'still launches an unconsumed operator request' : 'presents the gate without relaunching a reviewer'}`, async (t) => {
    const plan: ReviewSelection[] = [{ runner: 'codex', model: null, effort: null, mode: 'cold' }];
    const requestedAt = '2026-10-19T09:00:00.000Z';
    const reviewPolicy = { minimumReviews: 1, requestedBy: 'human-gate' as const };
    const run = createRun({
      flowType: 'fix-bug',
      mode: 'autonomous',
      project: 'example-mobile-farm',
      ticketOrPr: `PROJ-CAP-REPLAY-${operatorRequest}`,
      runner: 'claude',
      slotId: 'remote-mobile-1',
      engineState: {
        publishGate: {
          publicationTarget: 'ready',
          publicationStatus: 'not_published',
          reviewPolicy,
          // A replayed operator request persisted its plan before the restart.
          ...(operatorRequest
            ? {}
            : { reviewSequence: plan, reviewSequenceRequestedAt: requestedAt }),
        },
      },
    });
    t.after(async () => {
      await deleteTestRunIfPresent(run.id);
    });
    for (const reason of ['timeout', 'invalid JSON', 'lost on restart']) {
      await admitReviewRound(run.id, reason);
      await settleReviewRoundNoVerdict(run.id, reason, reason);
    }
    updateRun(run.id, {
      recoveryAttempts: [
        {
          id: 'gate-replay',
          attempt: 1,
          stepName: 'human-gate',
          startedAt: requestedAt,
          status: 'started',
          triggeredBy: 'auto-recovery',
        },
      ],
      ...(operatorRequest
        ? {
            decisions: [
              {
                id: 'operator-review-request',
                type: 'engine_human_gate',
                title: 'Publication gate',
                description: 'Request a review',
                actions: [],
                createdAt: requestedAt,
                resolvedAt: requestedAt,
                resolvedAction: 'request-review',
                selectionData: { reviewRequest: reviewRequestFromSequence(plan) },
              },
            ],
          }
        : {}),
    });
    const preparedResult: PrepareCompletionPackageResult = {
      completion: {
        prNumber: null,
        ciRepo: null,
        artifactsCopied: true,
        prCommentPosted: false,
        prTitleUpdated: false,
        prMarkedReady: false,
        retrospectiveCreated: false,
        artifacts: [],
      },
      prPackage: makeReadyGatePackage(),
      reviewPolicy,
      reviews: [],
    };
    let reviewerLaunches = 0;
    let gatePresentations = 0;
    await executeHumanGateStep(run.id, {
      ...restartReplayContext(),
      executePublishGateReviewPlan: (runId, slotId, actualPlan, trigger, options) =>
        executeGateReviewPlan(runId, slotId, actualPlan, trigger, {
          ...options,
          assertLaunchAllowed: async () => {},
          executeReview: async () => {
            reviewerLaunches += 1;
            return { verdict: 'pass', issues: [], retryCount: 0 };
          },
        }),
      executeReadyGate: async () => {
        gatePresentations += 1;
        return 'ready';
      },
      prepareCompletionPackageForRun: async () => preparedResult,
    });

    assert.equal(gatePresentations, 1, 'the gate is presented either way');
    const rejection = getRun(run.id)!.engineState?.publishGate?.reviewLaunchRejection;
    if (operatorRequest) {
      assert.equal(reviewerLaunches, 1);
      assert.equal(rejection, undefined);
    } else {
      assert.equal(reviewerLaunches, 0);
      assert.equal(rejection?.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(rejection?.message ?? '', /^3\/3 reviewer attempts ended without a verdict/);
    }
  });
}

for (const entry of ['request', 'restart replay'] as const)
  test(`a requested review that never launched restores the gate policy it was requested on (${entry})`, async (t) => {
    // F250: approve-publish was offered, a review was requested, and the review could not start.
    const requestedAt = '2026-10-30T18:07:43.000Z';
    const plan: ReviewSelection[] = [
      { runner: 'claude', model: 'opus', effort: null, mode: 'cold' },
    ];
    const rejection: PublicationReviewLaunchRejection = {
      code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
      message: 'Review template not found for project fixture-farm (static-code): ENOENT',
      userAction:
        'Add templates/worker/review.md to project fixture-farm, then request the review again.',
      rejectedAt: '2026-10-30T18:09:28.562Z',
    };
    // An earlier request set this policy; the refused one must not change it.
    const priorPolicy = { minimumReviews: 1, requestedBy: 'human-gate' as const };
    const raisedPolicy = { minimumReviews: 2, requestedBy: 'human-gate' as const };
    const requestDecision: RunDecision = {
      id: `decision-unlaunched-${entry}`,
      type: 'engine_human_gate',
      title: 'Publication gate',
      description: 'Request a review',
      actions: [],
      createdAt: requestedAt,
      resolvedAt: requestedAt,
      resolvedAction: 'request-review',
      payload: {
        kind: 'ready',
        branch: 'feat/unlaunched-review',
        prNumber: null,
        repo: null,
        workerReport: 'done',
        diffStat: { files: 3, additions: 222, deletions: 3 },
        prPackage: {
          ...makeReadyGatePackage(),
          id: 'pkg-requested',
          packageHash: 'hash-requested',
          reviewPolicy: priorPolicy,
        },
      },
      selectionData: { reviewRequest: reviewRequestFromSequence(plan) },
    };
    const run = createRun({
      flowType: 'dev',
      mode: 'autonomous',
      project: 'example-mobile-farm',
      ticketOrPr: `PROJ-UNLAUNCHED-${entry}`,
      runner: 'claude',
      slotId: 'remote-mobile-1',
      engineState: {
        publishGate: {
          publicationTarget: 'ready',
          publicationStatus: 'not_published',
          packageId: 'pkg-requested',
          packageHash: 'hash-requested',
          reviewPolicy: entry === 'request' ? priorPolicy : raisedPolicy,
          reviews: [],
        },
      },
    });
    if (entry === 'restart replay') updateRun(run.id, { decisions: [requestDecision] });
    t.after(async () => {
      await deleteTestRunIfPresent(run.id);
    });
    const rebuiltPolicies: unknown[] = [];
    let readyGateCalls = 0;
    await executeHumanGateStep(run.id, {
      ...restartReplayContext(),
      executePublishGateReviewPlan: async () => ({ reviewIds: [], rejection }),
      executeReadyGate: async () => {
        readyGateCalls += 1;
        if (entry === 'restart replay' || readyGateCalls > 1) return 'ready';
        // Resolving request-review raises the gate policy and stores the plan.
        const latest = getRun(run.id)!;
        updateRun(run.id, {
          decisions: [requestDecision],
          engineState: {
            ...latest.engineState,
            publishGate: {
              ...latest.engineState?.publishGate,
              reviewPolicy: raisedPolicy,
              reviewSequence: plan,
              reviewSequenceRequestedAt: requestedAt,
            },
          },
        });
        return 'request-review';
      },
      prepareCompletionPackageForRun: async (_runId, options) => {
        rebuiltPolicies.push(options?.reviewPolicy);
        return {
          completion: {
            prNumber: null,
            ciRepo: null,
            artifactsCopied: true,
            prCommentPosted: false,
            prTitleUpdated: false,
            prMarkedReady: false,
            retrospectiveCreated: false,
            artifacts: [],
          },
          prPackage: makeReadyGatePackage(),
          reviewPolicy: priorPolicy,
          reviews: [],
        };
      },
    });

    const gate = getRun(run.id)?.engineState?.publishGate;
    assert.deepEqual(gate?.reviewPolicy, priorPolicy);
    assert.deepEqual(gate?.reviewSequence ?? [], []);
    assert.deepEqual(gate?.reviews, []);
    // The package rebuilt after the refused request carries the restored policy.
    assert.deepEqual(rebuiltPolicies.at(-1), priorPolicy);
  });

test('review-pr always presents its publication gate in autonomous mode', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'example/mobile#123',
    runner: 'grok',
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
  });

  let reviewGateCalls = 0;
  const io = await executeHumanGateStep(run.id, {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-1',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {
      reviewGateCalls++;
    },
    getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => false,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
  });

  assert.equal(reviewGateCalls, 1);
  assert.deepEqual(io.inputs, { gateType: 'review', gateEnabled: true, forced: false });
  assert.equal(io.outputs?.resolvedAction, null);
});

test('a description-only edit keeps the review subject; the package hash still covers it', () => {
  const reviewed = makeReadyGatePackage({ headSha: 'head-1', draftBody: 'Reviewed body.' });
  const edited = {
    ...reviewed,
    draftTitle: 'fix(command-center): harden the gate',
    draftBody: 'Reviewed body.\n\nReviewer clarification: validation uses the saved recipe.\n',
  };
  assert.equal(
    computeReadyGateReviewSubjectHash(edited),
    computeReadyGateReviewSubjectHash(reviewed),
  );
  assert.notEqual(computeReadyGatePackageHash(edited), computeReadyGatePackageHash(reviewed));
  assert.equal(readyGateReviewSubjectMatches(reviewed, edited), true);
  assert.equal(
    readyGateReviewSubjectMatches(reviewed, {
      ...edited,
      diffStat: { files: 2, additions: 3, deletions: 0 },
    }),
    true,
  );
  const snapshot = edited.reviewSnapshot;
  assert.ok(snapshot);
  // A changed captured patch remains code drift even when its line counts match.
  assert.equal(
    readyGateReviewSubjectMatches(reviewed, {
      ...edited,
      reviewSnapshot: { ...snapshot, diffHash: 'changed-code-diff' },
    }),
    false,
  );
});

test('readyGateReviewSubjectMatches ignores review-loop metadata but rejects subject drift', () => {
  const reviewed = makeReadyGatePackage({
    headSha: 'head-1',
    packageInputHash: 'input-1',
    reviewSubjectHash: 'subject-1',
    reviewArtifactIds: ['review-before'],
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'dispatch',
    },
  });
  assert.equal(
    readyGateReviewSubjectMatches(
      reviewed,
      makeReadyGatePackage({
        headSha: 'head-1',
        packageInputHash: 'input-2',
        reviewSubjectHash: 'subject-2',
        reviewArtifactIds: ['review-after'],
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'human-gate',
        },
      }),
    ),
    true,
  );
  assert.equal(
    readyGateReviewSubjectMatches(reviewed, {
      ...reviewed,
      selectedEvidenceKeys: ['artifacts/new-after.png'],
    }),
    false,
  );
  assert.equal(readyGateReviewSubjectMatches(reviewed, { ...reviewed, headSha: 'head-2' }), false);
  assert.equal(readyGateReviewSubjectMatches(undefined, reviewed), false);
  assert.equal(readyGateReviewSubjectMatches({ ...reviewed, headSha: undefined }, reviewed), false);
  assert.equal(
    readyGateReviewSubjectMatches(
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          { path: 'artifacts/after.png', purpose: 'screenshot', sizeBytes: 123 },
          { path: 'artifacts/log.json', purpose: 'other', sizeBytes: 456 },
        ],
      }),
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-added-after-review',
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    readyGateReviewSubjectMatches(
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
          },
        ],
      }),
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-added-after-review',
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    readyGateReviewSubjectMatches(
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-a',
          },
        ],
      }),
      makeReadyGatePackage({
        headSha: 'head-1',
        selectedEvidenceKeys: ['artifacts/after.png'],
        evidenceManifest: [
          {
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            sizeBytes: 123,
            sha256: 'digest-b',
          },
        ],
      }),
    ),
    false,
  );
});
for (const mode of ['autonomous', 'interactive'] as const) {
  for (const verdict of ['pass', 'issues'] as const) {
    test(`eval ${mode} ${verdict} is judged once even with review axis none`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'eval-first-review-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const run = createRun({
        flowType: 'fix-bug',
        mode,
        project: 'generic-project',
        ticketOrPr: 'EVAL-FIRST',
        slotId: 'eval-slot',
        completionPolicy: 'artifact-only',
      });
      t.after(() => deleteTestRunIfPresent(run.id));
      const fixture = await firstOutputFixture(root, getRun(run.id)!);
      updateRun(run.id, { taskFile: fixture.taskFile, engineState: fixture.engineState });
      updateRunStep(run.id, 'dispatch', { startedAt: '2026-10-30T00:00:00Z' });
      const events: string[] = [];
      let idle = false;
      const issues =
        verdict === 'issues'
          ? [{ file: 'value.ts', description: 'Wrong result', severity: 'major' as const }]
          : [];
      const context: PostDispatchStepContext = {
        ...restartReplayContext(),
        readEvalWorkerProgress: async () => ({ kind: idle ? 'idle' : 'making-progress' }),
        waitForEvalWorkerProgress: async () => {
          events.push('wait');
          idle = true;
        },
        captureEvalWorkerOutput: async () => {
          events.push('capture');
          return 1;
        },
        extractEvalWorkerCost: async () => {
          events.push('worker-usage');
          return {
            costUsd: 0.25,
            turns: 2,
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheCreation: null,
            cacheRead: null,
            actualModel: 'worker',
          };
        },
        executeReviewForRun: async (_id, _slot, options) => {
          events.push('judge');
          assert.equal(options?.maxRetries, 0);
          assert.equal(options?.resumeFromResult, undefined);
          const frozen = await readFrozenEvalFirstOutputPackage(getRun(run.id)!);
          assert.deepEqual(frozen?.metrics, {
            durationMs: 60_000,
            costEstimate: 0.25,
            sessionTurns: 2,
            sessionInputTokens: 100,
            sessionOutputTokens: 20,
            sessionTotalTokens: 120,
          });
          return { verdict, issues, retryCount: 0, maxRetries: 0 };
        },
        createEngineDecision: async () =>
          assert.fail('An eval never sends findings back to the worker'),
        executeReadyGate: async () => assert.fail('An eval has no publication gate'),
      };
      const io = await executeReviewStep(run.id, context);
      assert.deepEqual(events, ['wait', 'capture', 'worker-usage', 'judge']);
      assert.equal(io.outputs?.verdict, verdict);
      assert.deepEqual(io.outputs?.issues, issues);
      assert.equal(getRun(run.id)?.status, run.status);
      assert.deepEqual(getRun(run.id)?.decisions, []);
      assert.deepEqual(context.stepPartialIO.size, 0);
      assert.equal(
        (await executeHumanGateStep(run.id, context)).outputs?.reason,
        'artifact-only-policy',
      );
    });
  }
}

for (const mode of ['autonomous', 'interactive'] as const) {
  test(`an invalid ${mode} eval retains facts without launching a judge or decision`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-invalid-review-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = createRun({
      flowType: 'fix-bug',
      mode,
      project: 'generic-project',
      ticketOrPr: 'EVAL-INVALID',
      slotId: 'eval-slot',
      completionPolicy: 'artifact-only',
    });
    t.after(() => deleteTestRunIfPresent(run.id));
    const fixture = await firstOutputFixture(root, getRun(run.id)!);
    fixture.engineState!.evalExperiment!.blind!.invalidReason = 'Isolation failed before judging';
    updateRun(run.id, { taskFile: fixture.taskFile, engineState: fixture.engineState });
    const io = await executeReviewStep(run.id, {
      ...restartReplayContext(),
      readEvalWorkerProgress: async () => ({ kind: 'idle' }),
      captureEvalWorkerOutput: async () => 1,
      extractEvalWorkerCost: async () => ({
        costUsd: null,
        turns: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cacheCreation: null,
        cacheRead: null,
        actualModel: null,
      }),
      executeReviewForRun: async () => assert.fail('Invalid samples must not launch a judge'),
      createEngineDecision: async () => assert.fail('Invalid samples must not wait for a person'),
    });
    assert.equal(io.outputs?.reason, 'eval-first-output-invalid');
    assert.equal(io.outputs?.invalidReason, 'Isolation failed before judging');
    assert.equal(
      (await readFrozenEvalFirstOutputPackage(getRun(run.id)!))?.comparisonEligibility?.status,
      'invalid',
    );
    assert.deepEqual(getRun(run.id)?.decisions, []);
  });
}

test('a self-blocked eval first output is frozen with its reason and finalized without a judge', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-blocked-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = createRun({
    flowType: 'fix-bug',
    project: 'generic-project',
    ticketOrPr: 'EVAL-BLOCKED',
    slotId: 'eval-slot',
    completionPolicy: 'artifact-only',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const fixture = await firstOutputFixture(root, getRun(run.id)!);
  const reason = 'Recipe proof could not be completed in this environment';
  updateRun(run.id, {
    taskFile: fixture.taskFile,
    engineState: fixture.engineState,
    steps: getRun(run.id)!.steps.map((step) =>
      step.name === 'monitor'
        ? { ...step, status: 'done', outputs: { evalWorkerBlocked: reason } }
        : step,
    ),
  });
  const io = await executeReviewStep(run.id, {
    ...restartReplayContext(),
    readEvalWorkerProgress: async () => ({ kind: 'idle' }),
    captureEvalWorkerOutput: async () => 1,
    extractEvalWorkerCost: async () => ({
      costUsd: 0.4,
      turns: 12,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheCreation: null,
      cacheRead: null,
      actualModel: null,
    }),
    executeReviewForRun: async () => assert.fail('A blocked first output has nothing to judge'),
    createEngineDecision: async () => assert.fail('A blocked first output waits for nobody'),
  });
  assert.equal(io.outputs?.reason, 'eval-first-output-blocked');
  assert.equal(io.outputs?.blockedReason, reason);
  const frozen = await readFrozenEvalFirstOutputPackage(getRun(run.id)!);
  assert.deepEqual(frozen?.outcomeClaims, [`Worker blocked: ${reason}`]);
  assert.equal(frozen?.metrics?.sessionTurns, 12);
  updateRunStep(run.id, 'review', { status: 'done', outputs: io.outputs });
  const finalized = await finalizeEvalResultPackageForRun(getRun(run.id)!);
  assert.equal(finalized?.status, 'final');
  assert.deepEqual(finalized?.outcomeClaims, [`Worker blocked: ${reason}`]);
  assert.deepEqual(finalized?.reviewEvidence, []);
  assert.deepEqual(getRun(run.id)?.decisions, []);
});

test('only a flow whose COMPLETE ends the run defers its slot release to the engine', () => {
  // The branch that decides whether COMPLETE performs its own release or hands
  // it to the terminal transition. review-pr ends at COMPLETE, so releasing
  // there gated the run's own `done` status on tmux teardown (ADR-053). Every
  // other flow continues through human-gate/finalize/ci-watch, and those later
  // steps read slot state, so the release still has to happen in the step.
  assert.equal(isFlowTerminalStep('review-pr', 'complete'), true);
  for (const flowType of ['fix-bug', 'dev', 'pr-complete', 'update-branch'] as const) {
    assert.equal(
      isFlowTerminalStep(flowType, 'complete'),
      false,
      `${flowType} continues past COMPLETE`,
    );
    assert.equal(isFlowTerminalStep(flowType, 'ci-watch'), true, `${flowType} ends at CI_WATCH`);
  }
});

test('held publication approval reopens only its wait despite persisted review plans', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'HELD-PUBLISH-WAIT',
    runner: 'grok',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    slotId: null,
    engineState: {
      publishGate: {
        reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
        reviewSequence: [{ runner: 'grok', model: null, effort: null, mode: 'cold' }],
      },
    },
    decisions: [
      {
        id: 'held',
        type: 'engine_human_gate',
        title: 'Gate',
        description: '',
        actions: [],
        createdAt: '2026-10-15T00:00:00Z',
        resolvedAt: '2026-10-15T00:01:00Z',
        resolvedAction: 'approve-publish-unresolved',
        context: { approvalHeldAt: '2026-10-15T00:01:01Z' },
      },
    ],
  });
  const before = structuredClone(getRun(run.id)!.engineState);
  let gates = 0;
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async () => assert.fail('a held approval cannot start reviewers'),
    resumeInterruptedPublicationReviewForRun: async () =>
      assert.fail('a held approval cannot resume fixes'),
    executeReadyGate: async () => {
      gates++;
      return 'approve-publish';
    },
  });
  assert.equal(gates, 1);
  assert.deepEqual(getRun(run.id)!.engineState, before);
});

test('a failed publication continuation re-presents its gate with prior findings intact', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'CONTINUE-INFRA-FAILURE',
    runner: 'grok',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    slotId: 'continue-slot',
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review-1',
            source: 'human-gate',
            mode: 'warm',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 3,
            issues: [1, 2, 3].map((n) => ({ file: 'a.ts', description: `finding ${n}` })),
            recoveryContinuationPending: true,
          },
        ],
      },
    },
    decisions: [
      {
        id: 'held',
        type: 'engine_human_gate',
        title: 'Gate',
        description: '',
        actions: [],
        createdAt: '2026-10-21T00:00:00Z',
        resolvedAt: '2026-10-21T00:01:00Z',
        resolvedAction: 'approve-publish-unresolved',
        context: { approvalHeldAt: '2026-10-21T00:01:01Z' },
      },
    ],
  });
  const gateActions = ['continue-review-fix', 'approve-publish'];
  let continuations = 0;
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async () => assert.fail('no replacement review plan'),
    resumeInterruptedPublicationReviewForRun: async () => {
      continuations++;
      return null;
    },
    executeReadyGate: async () => gateActions.shift()!,
  });
  assert.equal(continuations, 1, 'no automatic infra retry');
  assert.equal(gateActions.length, 0, 'the recoverable failure re-presents the gate');
  assert.equal(getRun(run.id)!.engineState!.publishGate!.reviews![0]!.unresolvedCount, 3);
});

test('Send back delivers through the retained repair step and re-presents the same gate', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'SEND-BACK-LOOP',
    runner: 'grok',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    slotId: 'send-back-slot',
    engineState: {
      publishGate: {
        reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
        reviewSequence: [{ runner: 'grok', model: null, effort: null, mode: 'cold' }],
      },
    },
    decisions: [
      {
        id: 'held',
        type: 'engine_human_gate',
        title: 'Gate',
        description: '',
        actions: [],
        createdAt: '2026-10-16T00:00:00Z',
        resolvedAt: '2026-10-16T00:01:00Z',
        resolvedAction: 'approve-publish-unresolved',
        context: { approvalHeldAt: '2026-10-16T00:01:01Z' },
      },
    ],
  });
  const gateActions = [SEND_BACK_TO_AGENT_ACTION, 'approve-publish'];
  const repairs: string[] = [];
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async () => assert.fail('Send back starts no review plan'),
    resumeInterruptedPublicationReviewForRun: async () =>
      assert.fail('Send back is not a Continue Fixing continuation'),
    resumeVisualRepairForRun: async (runId, slotId) => {
      repairs.push(`${runId}:${slotId}`);
      return null;
    },
    executeReadyGate: async () => gateActions.shift()!,
  });
  assert.deepEqual(repairs, [`${run.id}:send-back-slot`]);
  assert.equal(gateActions.length, 0, 'the gate is re-presented after the repair step');
});

for (const status of ['reserved', 'delivered'] as const)
  test(`a ${status} Send back interrupted by a restart resumes at gate entry`, async (t) => {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'example-mobile-farm',
      ticketOrPr: `SEND-BACK-RESTART-${status}`,
      runner: 'grok',
    });
    t.after(() => deleteTestRunIfPresent(run.id));
    const digest = `sha256:${'a'.repeat(64)}`;
    const scope: RecipeRepairScope = {
      schemaVersion: 1,
      repairId: 'repair-restart',
      runId: run.id,
      generation: 0,
      decisionId: 'gate-1',
      packageHash: 'b'.repeat(64),
      packageHeadSha: 'c'.repeat(40),
      reviewBaseSha: 'd'.repeat(40),
      reviewId: 'review-1',
      workerContextId: 'dev',
      repairRecipe: 'recipes/repair-restart.json',
      claims: [{ id: 'AC-1', claim: 'The square is green.' }],
      sources: [
        {
          recipeRunId: 'original',
          closureIdentity: digest,
          artifactRoot: 'artifacts/r',
          headSha: 'c'.repeat(40),
        },
      ],
      retained: [],
      rejected: [
        {
          claimId: 'AC-1',
          proofMode: 'visual',
          receiptId: 'receipt-1',
          reason: 'Use the brand green.',
          recipeRunId: 'original',
          closureIdentity: digest,
          reviewedFiles: [],
          moments: [],
        },
      ],
    };
    updateRun(run.id, {
      status: 'human-gating',
      slotId: 'send-back-slot',
      engineState: {
        publishGate: {
          reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
          reviewSequence: [{ runner: 'grok', model: null, effort: null, mode: 'cold' }],
          visualRepairs: [
            {
              repairId: scope.repairId,
              scope,
              scopeDigest: digest,
              decisionId: 'gate-1',
              packageHash: scope.packageHash,
              reviewId: 'review-1',
              status,
              reservedRetryCount: 1,
              reservedAt: '2026-10-16T00:00:00Z',
              ...(status === 'delivered' ? { deliveredAt: '2026-10-16T00:00:05Z' } : {}),
              rejected: [
                { claimId: 'AC-1', receiptId: 'receipt-1', reason: 'Use the brand green.' },
              ],
            },
          ],
        },
      },
      decisions: [
        {
          id: 'held',
          type: 'engine_human_gate',
          title: 'Gate',
          description: '',
          actions: [],
          createdAt: '2026-10-16T00:00:00Z',
          resolvedAt: '2026-10-16T00:01:00Z',
          resolvedAction: 'approve-publish-unresolved',
          context: { approvalHeldAt: '2026-10-16T00:01:01Z' },
        },
      ],
    });
    const order: string[] = [];
    await executeHumanGateStep(run.id, {
      ...restartReplayContext(),
      resumeInterruptedPublicationReviewForRun: async () =>
        assert.fail('an accepted repair is not a Continue Fixing continuation'),
      resumeVisualRepairForRun: async (runId, slotId) => {
        order.push(`repair:${runId}:${slotId}`);
        return null;
      },
      executeReadyGate: async () => {
        order.push('gate');
        return 'approve-publish';
      },
    });
    assert.deepEqual(order, [`repair:${run.id}:send-back-slot`, 'gate']);
  });

test('accepted publication resumes its gate without collecting reviews or replacing its package', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'APPROVED-PUBLISH',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    slotId: null,
    engineState: {
      publishGate: {
        publicationStatus: 'pending_publish',
        approvedPackageHash: 'approved-package',
        reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' },
        reviewSequence: [{ runner: 'grok', model: null, effort: null, mode: 'cold' }],
      },
    },
    decisions: [
      {
        id: 'approved',
        type: 'engine_human_gate',
        title: 'Gate',
        description: '',
        actions: [],
        createdAt: '2026-10-15T00:00:00Z',
        resolvedAt: '2026-10-15T00:01:00Z',
        resolvedAction: 'approve-publish-unresolved',
      },
    ],
  });
  let gates = 0;
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async () => assert.fail('approval cannot launch another review'),
    prepareCompletionPackageForRun: async () => assert.fail('approval cannot replace its package'),
    executeReadyGate: async () => {
      gates++;
      return 'approve-publish-unresolved';
    },
  });
  assert.equal(gates, 1);
  assert.equal(getRun(run.id)!.decisions.length, 1);
  assert.equal(getRun(run.id)!.engineState?.publishGate?.approvedPackageHash, 'approved-package');
});

// TAT-4145 bda11b1a (00:18Z): a stale CI receipt failed the gate's package refresh after a
// review plan; the error failed HUMAN_GATE, and the failure released the slot.
const STALE_CI_RECEIPT =
  'Deterministic CI gate blocked: [{"checks":[{"checklist":"CHECKLIST.md","stepNumber":17,"reference":"ci.local_check","status":"stale"}]}]';
const claudeColdRow: ReviewSelection = {
  runner: 'claude',
  model: null,
  effort: null,
  mode: 'cold',
};

async function staleReceiptGateRun(
  t: test.TestContext,
  ticketOrPr: string,
  reviewSequence: ReviewSelection[],
  reviews: ReviewStatus[],
) {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'gate-stale-receipt-'));
  const run = createRun({
    project: 'review-replay',
    flowType: 'fix-bug',
    mode: 'autonomous',
    ticketOrPr,
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
  });
  await mkdir(path.join(taskDir, 'artifacts'));
  await writeFile(
    path.join(taskDir, 'artifacts/pr-package.json'),
    JSON.stringify(makeReadyGatePackage({ headSha: 'c'.repeat(40) })),
  );
  updateRun(run.id, {
    status: 'human-gating',
    slotId: 'stale-receipt-slot',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
        reviewSequence,
        reviewSequenceRequestedAt: reviewSequence.length ? '2026-10-20T00:18:39.114Z' : undefined,
        reviews,
      },
    },
  });
  return run;
}

function preparedGatePackage(): PrepareCompletionPackageResult {
  return {
    completion: {
      prNumber: null,
      ciRepo: null,
      artifactsCopied: true,
      prCommentPosted: false,
      prTitleUpdated: false,
      prMarkedReady: false,
      retrospectiveCreated: false,
      artifacts: [],
    },
    prPackage: makeReadyGatePackage(),
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
    reviews: [],
  };
}

for (const interrupted of [false, true])
  test(`retained same-head findings reach the gate without ${interrupted ? 'retrying an interrupted' : 'starting an automatic'} review`, async (t) => {
    const issues = [
      { file: 'evidence-manifest.json', description: 'AC-1 needs person acceptance' },
    ];
    const reviews: ReviewStatus[] = [
      {
        id: 'pipeline-review-retained',
        source: 'pipeline',
        mode: 'warm',
        loopNumber: 1,
        verdict: 'failed',
        unresolvedCount: 1,
        issues,
        attempts: [
          {
            mode: 'warm',
            loopNumber: 2,
            verdict: 'issues',
            unresolvedCount: 1,
            issues,
            reviewSnapshot: {
              source: 'local-git',
              headSha: 'c'.repeat(40),
              capturedAt: '2026-10-21T02:39:11Z',
            },
          },
        ],
      },
    ];
    if (interrupted)
      reviews.push({
        id: 'review-interrupted',
        source: 'dispatch',
        mode: 'cold',
        loopNumber: 2,
        verdict: 'failed',
        unresolvedCount: 0,
      });
    const run = await staleReceiptGateRun(t, 'RETAINED-FINDING', [claudeColdRow], reviews);
    let gates = 0;
    await executeHumanGateStep(run.id, {
      ...restartReplayContext(),
      executePublishGateReviewPlan: async () =>
        assert.fail('retained findings require a person decision, not another review'),
      executeReadyGate: async () => {
        gates++;
        return 'approve-publish';
      },
    });
    assert.equal(gates, 1);
    assert.deepEqual(getRun(run.id)!.engineState?.publishGate?.reviews, reviews);
  });

test('gate re-entry with a refused re-run row and a stale CI receipt reaches the gate wait', async (t) => {
  // The refused re-run left its row persisted; a restart and Retry Gate re-enter with it.
  const run = await staleReceiptGateRun(
    t,
    'STALE-RECEIPT-REENTRY',
    [claudeColdRow],
    [
      {
        id: 'pipeline-pass',
        source: 'pipeline',
        loopNumber: 1,
        ...claudeColdRow,
        verdict: 'pass',
        unresolvedCount: 0,
        reviewedHeadSha: 'a'.repeat(40),
        completedAt: '2026-10-19T15:50:37Z',
      },
    ],
  );
  const plans: ReviewSelection[][] = [];
  let gates = 0;
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async (_runId, _slotId, plan) => {
      plans.push(plan);
      return {
        reviewIds: [],
        rejection: {
          code: 'REVIEW_ROUND_LIMIT_REACHED',
          message: 'All 7 authorized review rounds are spent',
          userAction: 'Stop review work.',
          rejectedAt: '2026-10-20T00:18:39.113Z',
        },
      };
    },
    prepareCompletionPackageForRun: async () => {
      throw new Error(STALE_CI_RECEIPT);
    },
    executeReadyGate: async () => {
      gates += 1;
      return 'approve-publish';
    },
  });
  assert.deepEqual(plans, [[claudeColdRow]]);
  assert.equal(gates, 1, 'the gate owns the package it cannot prepare yet');
});

test('a requested gate review whose package meets a stale CI receipt returns to the gate', async (t) => {
  const run = await staleReceiptGateRun(
    t,
    'STALE-RECEIPT-REQUEST',
    [],
    [
      {
        id: 'dispatch-pass',
        source: 'dispatch',
        loopNumber: 1,
        ...claudeColdRow,
        verdict: 'pass',
        unresolvedCount: 0,
        reviewedHeadSha: 'c'.repeat(40),
        completedAt: '2026-10-19T16:00:00Z',
      },
    ],
  );
  let prepares = 0;
  let gates = 0;
  await executeHumanGateStep(run.id, {
    ...restartReplayContext(),
    executePublishGateReviewPlan: async () => ({ reviewIds: ['review-requested'] }),
    // The requested review's fix loop commits, so its package refresh meets a stale receipt.
    prepareCompletionPackageForRun: async () => {
      prepares += 1;
      if (prepares === 1) return preparedGatePackage();
      throw new Error(STALE_CI_RECEIPT);
    },
    executeReadyGate: async () => {
      gates += 1;
      if (gates > 1) return 'approve-publish';
      const latest = getRun(run.id)!;
      updateRun(run.id, {
        engineState: {
          ...latest.engineState,
          publishGate: { ...latest.engineState?.publishGate, reviewSequence: [claudeColdRow] },
        },
      });
      return 'request-review';
    },
  });
  assert.equal(gates, 2, 'the requested review returns to the gate');
});

test('an artifact-only run with its pipeline review off records the skip and launches no reviewer', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'VALIDATION-1',
    mode: 'autonomous',
    slotId: 'validation-slot',
    completionPolicy: 'artifact-only',
    pipelineReview: 'none',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  assert.equal(run.pipelineReview, 'none', 'the stored run keeps the policy');
  const result = await executeReviewStep(run.id, {
    ...restartReplayContext(),
    executeReviewForRun: async () => assert.fail('an artifact-only run with no pipeline review'),
    createEngineDecision: async () => assert.fail('no review decision'),
  });
  assert.deepEqual(result.outputs, {
    skipped: true,
    reason: 'pipeline-review-off',
    source: 'run-policy',
    detail: 'Pipeline review is off for this artifact-only run (pipelineReview none).',
  });
  assert.equal(result.inputs?.enabled, false);
});

for (const mode of ['autonomous', 'interactive'] as const) {
  test(`PR completion in ${mode} mode never launches a reviewer or review decision`, async (t) => {
    const run = createRun({
      flowType: 'pr-complete',
      project: 'generic-project',
      ticketOrPr: 'example/repo#1',
      mode,
      slotId: 'pr-complete-slot',
    });
    t.after(() => deleteTestRunIfPresent(run.id));
    const result = await executeReviewStep(run.id, {
      ...restartReplayContext(),
      executeReviewForRun: async () => assert.fail('PR completion has no reviewer'),
      createEngineDecision: async () => assert.fail('PR completion has no review decision'),
    });
    assert.equal(result.outputs?.reason, 'pr-complete-has-no-reviewer');
  });
}

test('an undelivered fix becomes a visible result decision with its findings preserved', async (t) => {
  const runId = await publicationGateRun(t, {});
  const issues = [{ file: 'a.ts', line: 1, description: 'Retained finding' }];
  let held: ResultDecisionHoldError | undefined;
  try {
    await executeReviewStep(runId, {
      ...restartReplayContext(),
      executeReviewForRun: async () => ({
        verdict: 'issues',
        reviewSnapshot: {
          source: 'local-git',
          headSha: rowOneHead,
          capturedAt: '2026-10-29T19:01:00Z',
        },
        issues,
        retryCount: 1,
        maxRetries: 3,
        feedbackSent: false,
        recoveryContinuationPending: true,
        fixDeliveryFailure: 'Fix prompt delivery remained unconfirmed',
      }),
    });
    assert.fail('delivery failure must enter the operator decision boundary');
  } catch (error) {
    assert.ok(error instanceof ResultDecisionHoldError);
    held = error;
  }
  assert.deepEqual(held.stepOutputs.issues, issues);
  assert.equal(held.stepOutputs.feedbackSent, false);
  assert.equal(held.stepOutputs.recoveryContinuationPending, true);
  const run = getRun(runId)!;
  const decision = await buildResultDecision(
    {
      ...run,
      steps: run.steps.map((step) =>
        step.name === 'review' ? { ...step, status: 'failed', outputs: held.stepOutputs } : step,
      ),
    },
    'review',
  );
  assert.equal(decision.type, 'engine_result_decision');
  assert.match(decision.description ?? '', /fix was not delivered.*unconfirmed/);
  assert.ok(decision.payload?.kind === 'result-decision');
  assert.deepEqual(decision.payload.findings, issues);
});
