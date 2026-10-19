import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

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
mock.module('./native-review-agent.js', {
  namedExports: {
    runNativeReviewAgent: async () => {
      reviewerLaunches++;
      return { verdict: 'pass', issues: [] };
    },
  },
});

const { executeReview } = await import('./orchestrator.js');
const { admitReviewRound, settleReviewRoundNoVerdict } = await import('./review-round-budget.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { REVIEW_FIX_CHECKLIST_TARGET, taskDirRelPath } =
  await import('../tasks/checklist-target.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');

test('a fix recovered after a restart at the no-verdict cap is not re-reviewed automatically', async (t) => {
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: 'CAP-RECOVERED-FIX',
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
  // The worker finished the delivered fix while the gateway was down.
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

  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    validationDepth: 'static-code',
  });

  assert.equal(reviewerLaunches, 0, 'the recovered fix is not re-reviewed at the cap');
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
