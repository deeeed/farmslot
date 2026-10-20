import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import type { runNativeReviewAgent } from './native-review-agent.js';
import type { ReviewAgentResult } from './review-agent.js';

await import('../runtime/mock-pty.test-support.js');
const repo = await mkdtemp(path.join(os.tmpdir(), 'fix-recovery-cap-'));
after(() => rm(repo, { recursive: true, force: true }));
const project = 'fix-recovery-cap';
const projectJson = { task_dir: 'tasks', review: { enabled: true, max_retries: 2 } };
const taskDir = 'tasks/review';

// The slot is a local temp checkout and the project config is scripted. These
// mocks register before anything loads the review orchestrator.
const config = await import('../core/config.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const vars = makeVars({ remoteRepo: repo, repo });
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({ projectJson }),
    loadSlotVars: async () => vars,
  },
});
// Every reviewer launch reaches the native reviewer; none may happen at the cap.
let reviewerLaunches = 0;
type NativeReviewInput = Parameters<typeof runNativeReviewAgent>[0];
let nativeReviewer = async (_input: NativeReviewInput): Promise<ReviewAgentResult> => ({
  verdict: 'pass',
  issues: [],
});
mock.module('./native-review-agent.js', {
  namedExports: {
    runNativeReviewAgent: async (input: NativeReviewInput) => {
      reviewerLaunches++;
      return nativeReviewer(input);
    },
  },
});

const { executeReview } = await import('./orchestrator.js');
const {
  admitReviewRound,
  reviewLaunchStartedAt,
  reviewRoundAdmissionId,
  settleReviewRoundNoVerdict,
} = await import('./review-round-budget.js');
const { isLiveNativeReviewer, nativeReviewerContextPrefix } = await import('./review-agent.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { REVIEW_FIX_CHECKLIST_TARGET, taskDirRelPath } =
  await import('../tasks/checklist-target.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');

async function recoveredFixAtCap(t: TestContext, fixSignal: Record<string, string>) {
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: `CAP-RECOVERED-FIX-${fixSignal.status}`,
    runner: 'claude',
    slotId: vars.slotId,
  });
  const slotRow = (rows: Record<string, unknown>[]) =>
    rewriteStatusFile((current) => ({
      ...current,
      slots: [...(current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId), ...rows],
    }));
  t.after(async () => {
    await slotRow([]);
    await deleteTestRunIfPresent(run.id);
  });
  await slotRow([{ slot: vars.slotId, current_run_id: run.id }]);
  for (const reason of ['timeout', 'invalid JSON', 'lost on restart']) {
    await admitReviewRound(run.id, reason);
    await settleReviewRoundNoVerdict(run.id, reason, reason);
  }
  // The worker ended the delivered fix while the gateway was down.
  const checklist = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
  const signal = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal);
  await mkdir(path.join(repo, taskDir), { recursive: true });
  await writeFile(path.join(repo, checklist), '## Issues\n\n- **a.ts:1** — fix the finding\n');
  await writeFile(
    path.join(repo, signal),
    JSON.stringify({ ...fixSignal, timestamp: new Date().toISOString(), attemptId: 'fix-attempt' }),
  );
  updateRun(run.id, {
    status: 'reviewing',
    taskFile: path.join(config.getOrchestratorTaskRoot(project, projectJson), 'review', 'TASK.md'),
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Fix',
        status: 'working',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        taskFile: checklist,
        signalFile: signal,
        artifactScope: null,
        signalAttemptId: 'fix-attempt',
        attemptStartedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
  const launchesBefore = reviewerLaunches;
  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    validationDepth: 'static-code',
  });
  return { run, result, launches: reviewerLaunches - launchesBefore };
}

test('a fix recovered after a restart at the no-verdict cap is not re-reviewed automatically', async (t) => {
  const { run, result, launches } = await recoveredFixAtCap(t, { status: 'complete' });

  assert.equal(launches, 0, 'the recovered fix is not re-reviewed at the cap');
  assert.equal(result.verdict, 'issues');
  assert.match(result.reason ?? '', /^3\/3 reviewer attempts ended without a verdict/);
  assert.equal(result.feedbackSent, true);
  assert.equal(result.recoveryContinuationPending, false);
  assert.equal('maxRetriesExhausted' in result, false);
  assert.equal(
    getRun(run.id)!.agentContexts!.find((context) => context.id === 'review-fix')?.status,
    'complete',
  );
});

test('a recovered fix the worker blocked keeps its block at the no-verdict cap', async (t) => {
  const { result, launches } = await recoveredFixAtCap(t, {
    status: 'blocked',
    reason: 'needs the staging credentials',
  });

  assert.equal(launches, 0);
  assert.equal(result.verdict, 'blocked');
  assert.match(
    result.reason ?? '',
    /^needs the staging credentials; 3\/3 reviewer attempts ended without a verdict/,
  );
  assert.equal(result.attempts?.at(-1)?.verdict, 'failed', 'the block stays authoritative');
  assert.equal(result.feedbackSent, true);
  assert.equal(result.recoveryContinuationPending, false);
});

test('a REVIEW re-entry with all rounds admitted reattaches to the running re-review', async (t) => {
  // TAT-4158 run 4237202e at 20:36Z: a restart re-entered REVIEW while the loop-2 re-review of
  // a recovered fix ran, with all five rounds admitted. A fresh first pass needed a sixth.
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'CAP-REENTRY-SPENT',
    runner: 'claude',
    slotId: vars.slotId,
  });
  const slotRow = (rows: Record<string, unknown>[]) =>
    rewriteStatusFile((current) => ({
      ...current,
      slots: [...(current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId), ...rows],
    }));
  t.after(async () => {
    nativeReviewer = async () => ({ verdict: 'pass', issues: [] });
    await slotRow([]);
    await deleteTestRunIfPresent(run.id);
  });
  await slotRow([{ slot: vars.slotId, current_run_id: run.id }]);
  const generation = getRun(run.id)!.engineState?.generation ?? 0;
  const prefix = (loopNumber: number) =>
    nativeReviewerContextPrefix({
      runId: run.id,
      runner: 'claude',
      model: 'opus',
      generation,
      taskDir,
      artifactScope: null,
      loopNumber,
    });
  const pipeline = `pipeline-review-${run.id}`;
  const lineage2 = `${prefix(2)}-d0e601c0`;
  const running = `${prefix(2)}-85add757`;
  const runningSince = '2026-10-19T20:33:40.655Z';
  // The run's five receipts, as recorded: two first passes and three re-reviews.
  for (const [lineage, loop, at] of [
    [pipeline, 1, '2026-10-19T19:05:23.119Z'],
    [lineage2, 2, '2026-10-19T19:40:59.214Z'],
    [lineage2, 3, '2026-10-19T20:03:36.075Z'],
    [pipeline, 1, '2026-10-19T20:12:03.627Z'],
    [running, 2, runningSince],
  ] as const)
    await admitReviewRound(run.id, reviewRoundAdmissionId(lineage, loop, at));
  const checklist = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
  updateRun(run.id, {
    status: 'reviewing',
    taskFile: path.join(config.getOrchestratorTaskRoot(project, projectJson), 'review', 'TASK.md'),
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Fix',
        status: 'complete',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        taskFile: checklist,
        artifactScope: null,
      },
      {
        id: running,
        role: 'review',
        label: 'Claude reviewer',
        status: 'working',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        taskFile: `${taskDir}/REVIEW.${running}.md`,
        artifactScope: null,
        reviewLoopNumber: 2,
        reviewId: running,
        startedAt: runningSince,
      },
    ],
  });
  // The native agent's admission: a launch matching a running reviewer reuses its receipt.
  const launches: [number, string | null | undefined][] = [];
  nativeReviewer = async (input) => {
    launches.push([input.loopNumber, input.reviewId]);
    const live = getRun(run.id)!.agentContexts!.find((context) =>
      isLiveNativeReviewer(context, prefix(input.loopNumber)),
    );
    const lineage = input.reviewId?.trim() || live?.id || 'fresh-reviewer';
    await admitReviewRound(
      run.id,
      reviewRoundAdmissionId(lineage, input.loopNumber, reviewLaunchStartedAt(live)),
    );
    return {
      verdict: 'issues',
      issues: [
        { file: 'src/order-book.tsx', line: 1, description: 'first finding' },
        { file: 'src/order-book.tsx', line: 2, description: 'second finding' },
      ],
    };
  };

  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    validationDepth: 'static-code',
  });

  assert.deepEqual(launches, [[2, running]], 'reattached at the running reviewer');
  assert.equal(result.verdict, 'issues');
  assert.equal(result.issues?.length, 2);
  assert.equal(result.retryCount, 1);
  assert.equal('maxRetriesExhausted' in result && result.maxRetriesExhausted, true);
  assert.match(result.reason ?? '', /The five review rounds are spent/);
});

test('a fix recovered after a restart is re-reviewed WARM in the pipeline lineage at its next loop', async (t) => {
  // TAT-4145 bda11b1a: the recovered re-review ran loop 2 in a new lineage, so it reviewed
  // the whole diff COLD. It continues the pipeline review that raised the findings instead.
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'RECOVERED-FIX-LINEAGE',
    runner: 'claude',
    slotId: vars.slotId,
  });
  const slotRow = (rows: Record<string, unknown>[]) =>
    rewriteStatusFile((current) => ({
      ...current,
      slots: [...(current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId), ...rows],
    }));
  const inputs: NativeReviewInput[] = [];
  t.after(async () => {
    nativeReviewer = async () => ({ verdict: 'pass', issues: [] });
    await slotRow([]);
    await deleteTestRunIfPresent(run.id);
  });
  nativeReviewer = async (input) => {
    inputs.push(input);
    return { verdict: 'pass', issues: [] };
  };
  await slotRow([{ slot: vars.slotId, current_run_id: run.id }]);
  const checklist = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.checklist);
  const signal = taskDirRelPath(taskDir, REVIEW_FIX_CHECKLIST_TARGET.signal);
  await mkdir(path.join(repo, taskDir), { recursive: true });
  await writeFile(path.join(repo, checklist), '## Issues\n\n- **a.ts:1** — fix the finding\n');
  await writeFile(
    path.join(repo, signal),
    JSON.stringify({
      status: 'complete',
      timestamp: new Date().toISOString(),
      attemptId: 'fix-attempt',
    }),
  );
  const pipeline = `pipeline-review-${run.id}`;
  updateRun(run.id, {
    status: 'reviewing',
    taskFile: path.join(config.getOrchestratorTaskRoot(project, projectJson), 'review', 'TASK.md'),
    agentContexts: [
      {
        id: 'pipeline-reviewer',
        role: 'review',
        label: 'Claude reviewer',
        status: 'complete',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        artifactScope: null,
        reviewLoopNumber: 3,
        reviewId: pipeline,
      },
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Fix',
        status: 'working',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        taskFile: checklist,
        signalFile: signal,
        artifactScope: null,
        deliveryBaselineRef: 'reviewed-head',
        signalAttemptId: 'fix-attempt',
        attemptStartedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });

  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    validationDepth: 'static-code',
  });

  assert.equal(result.verdict, 'pass');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.loopNumber, 4);
  assert.equal(inputs[0]!.mode, 'warm');
  assert.equal(inputs[0]!.reviewId, pipeline);
  assert.deepEqual(inputs[0]!.rereview, {
    lastReviewedHeadSha: 'reviewed-head',
    priorIssues: [{ file: 'a.ts', line: 1, description: 'fix the finding' }],
  });
});
