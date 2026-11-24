import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import {
  type AgentContext,
  isReviewRoundNoVerdictSettlement,
  type Principal,
  type ReviewDiffSnapshot,
  type ReviewInterdiffReceipt,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const exec = await import('../core/exec.js');
const slotIo = await import('../core/slot-io.js');
const checklist = await import('../tasks/checklist-target.js');
const snapshots = await import('./snapshots.js');
const reviewAgent = await import('./review-agent.js');
const progress = await import('./progress.js');
const workerLifecycle = await import('./worker-lifecycle.js');
const pipelineVisual = await import('./pipeline-visual-review.js');
const { upsertAgentContext } = await import('../agents/contexts.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { NativeReviewerEmptyThreadError, NativeWorkerOperationUncertainError } =
  await import('../runners/native/worker-error.js');

const vars = makeVars();
const owner: Principal = {
  id: 'native-review-warm-owner',
  subject: { type: 'person', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const head = 'a'.repeat(40);
let currentHead = head;
let worktreeStatus = '';
const noop = async () => {};
// Scripted host behaviour; the run store, the session registry and the round budget are real.
let feedbackPass = false;
let rebaseQualification: 'reliable' | 'unreliable' | undefined;
let ancestorExitCode = 0;
/** How a retained reviewer's resume fails before it accepts the prompt. */
let resumeFailure: 'handoff' | 'handoff-once' | 'delivery' | 'superseded' | null = null;
let freshSessions = 0;
let commandFailed = false;
let nativeSessionHasInput: boolean | undefined;
let stoppedEmptyReviewer = false;
let refuseRecovery = false;
const resumed: string[] = [];
let expectedFixCheck: Error | undefined;
const dispatches: Array<{ contextId: string; retainedFrom?: { contextId: string } }> = [];
const deltaCaptures: string[] = [];
const publicationComparisons: Array<ReviewDiffSnapshot | undefined> = [];

mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({ projectJson: {} }),
    loadSlotVars: async () => vars,
  },
});
// Warm-lineage scenarios start with their prepared task already staged.
mock.module('../core/slot-io.js', {
  namedExports: { ...slotIo, slotFileExists: async () => true },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (_vars: unknown, command: string) => ({
      exitCode: command.startsWith('git merge-base --is-ancestor') ? ancestorExitCode : 0,
      stdout: command.startsWith('git rev-parse HEAD && git status')
        ? `${currentHead}\n${worktreeStatus}`
        : command.startsWith('git merge-base ') && !command.includes('--is-ancestor')
          ? command.includes("'origin/main'")
            ? 'b'.repeat(40)
            : head
          : '',
      stderr: '',
    }),
  },
});
const slotFiles = new Map<string, string>();
mock.module('../methods/dispatch/slot-file-write.js', {
  namedExports: {
    writeTextFileOnSlot: async (_vars: unknown, file: string, content: string) => {
      slotFiles.set(file, content);
    },
  },
});
mock.module('../run-engine/run-monitor.js', {
  namedExports: {
    probeWorkerSignalForRun: async (_runId: string, _slotId: string, context: AgentContext) =>
      commandFailed || (context.status === 'failed' && !resumed.includes(context.id))
        ? { ok: false, code: 'missing', message: 'review never started' }
        : { ok: true },
  },
});
mock.module('../run-engine/stack-base.js', { namedExports: { stackPrBase: async () => null } });
mock.module('../runners/native/manager.js', { namedExports: { validateNativeRunner: () => {} } });
mock.module('../runners/native/review-owner.js', {
  namedExports: {
    nativeReviewerOwner: () => owner.id,
    nativeReviewerResultSchema: () => undefined,
  },
});
mock.module('../runners/native/worker.js', {
  namedExports: {
    cancelNativeWorkerContext: async (runId: string, context: AgentContext) => {
      await upsertAgentContext(runId, 'review', {
        id: context.id,
        nativeSession: { ...context.nativeSession!, closedAt: new Date().toISOString() },
      });
    },
    dispatchNativeWorker: async (input: {
      runId: string;
      contextId: string;
      retainedFrom?: { runId: string; contextId: string };
    }) => {
      const existing = getRun(input.runId)!.agentContexts!.find(
        (context) => context.id === input.contextId,
      );
      if (existing?.nativeSession?.acceptedAt && !existing.nativeSession.closedAt) return;
      dispatches.push({ contextId: input.contextId, retainedFrom: input.retainedFrom });
      const source = input.retainedFrom
        ? getRun(input.retainedFrom.runId)!.agentContexts!.find(
            (context) => context.id === input.retainedFrom!.contextId,
          )!
        : undefined;
      const binding = {
        sessionId: source?.nativeSession?.sessionId ?? `native-${++freshSessions}`,
        executionNodeId: 'local',
        ownerPrincipalId: owner.id,
        leaseId: `lease-${input.contextId}`,
        generation: 'generation',
        commandId: 'review-command',
        ...(source
          ? {
              handoffFrom: {
                runId: input.retainedFrom!.runId,
                contextId: source.id,
                leaseId: source.nativeSession!.leaseId,
              },
            }
          : {}),
      };
      if (source && resumeFailure) {
        // The handoff reservation exists, but the reviewer never accepted the prompt.
        await upsertAgentContext(input.runId, 'review', {
          id: input.contextId,
          nativeSession: binding,
        });
        if (resumeFailure === 'superseded') {
          const run = getRun(input.runId)!;
          updateRun(input.runId, {
            engineState: { ...run.engineState, generation: (run.engineState?.generation ?? 0) + 1 },
          });
          throw new Error('Native review was superseded by another run action');
        }
        const operation = resumeFailure === 'delivery' ? 'delivery' : 'handoff';
        if (resumeFailure === 'handoff-once') resumeFailure = null;
        throw new NativeWorkerOperationUncertainError(
          operation,
          resumeFailure === 'delivery' ? 'prompt acceptance timed out' : 'transfer refused',
          new Error('no live session'),
        );
      }
      await upsertAgentContext(input.runId, 'review', {
        id: input.contextId,
        status: 'working',
        runnerSessionId: source?.runnerSessionId ?? `runner-${freshSessions}`,
        nativeSession: { ...binding, acceptedAt: new Date().toISOString() },
      });
    },
  },
});
mock.module('../runners/native/worker-control.js', {
  namedExports: {
    readNativeWorkerCommandError: async () => undefined,
    readNativeWorkerSnapshot: async () => ({
      session: {
        state: stoppedEmptyReviewer ? 'closed' : commandFailed ? 'idle' : 'running',
        processStopped: !commandFailed,
        nativeSessionHasInput,
        nativeSessionId: 'empty-thread',
      },
      pendingRequests: [],
      commands: [
        {
          commandId: 'review-command',
          state: commandFailed ? 'failed' : 'completed',
          outcome: commandFailed ? 'failed' : 'completed',
        },
      ],
      events: [],
      cursor: 0,
      hasMore: false,
    }),
  },
});
mock.module('../runners/native/worker-recovery.js', {
  namedExports: {
    resumeNativeWorker: async (runId: string, options: { contextId: string }) => {
      if (stoppedEmptyReviewer && nativeSessionHasInput === false)
        throw new NativeReviewerEmptyThreadError();
      if (refuseRecovery)
        throw new NativeWorkerOperationUncertainError(
          'launch',
          'handoff recovery unconfirmed',
          new Error('no rollout found'),
        );
      resumed.push(options.contextId);
      const context = getRun(runId)!.agentContexts!.find(
        (entry) => entry.id === options.contextId,
      )!;
      await upsertAgentContext(runId, 'review', {
        id: context.id,
        status: 'working',
        nativeSession: { ...context.nativeSession!, closedAt: undefined },
      });
    },
  },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: { assertNativeRunOwner: () => {} },
});
mock.module('../tasks/checklist-target.js', {
  namedExports: {
    ...checklist,
    restoreWorkerChecklistTargetFromSlot: noop,
    syncChecklistTargetForRole: noop,
  },
});
mock.module('../tasks/watcher.js', {
  namedExports: { unwatchContext: noop, watchContext: noop, onWorkerSignal: () => () => {} },
});
mock.module('./feedback.js', {
  namedExports: {
    logRecommendationCorrection: () => {},
    readReviewFeedback: async () =>
      feedbackPass
        ? { verdict: 'pass', issues: [] }
        : {
            verdict: 'issues',
            issues: [{ file: 'a.ts', line: 3, description: 'finding' }],
          },
  },
});
mock.module('./native-reviewer-approvals.js', {
  namedExports: { refuseReviewerApprovals: async () => 0 },
});
// This fixture tests retry ownership, not the separately tested visual-result validator.
mock.module('./pipeline-visual-review.js', {
  namedExports: { ...pipelineVisual, collectPipelineVisualResult: () => undefined },
});
mock.module('./worker-lifecycle.js', {
  namedExports: {
    ...workerLifecycle,
    isWorkerAlive: async () => {
      if (expectedFixCheck) throw expectedFixCheck;
      return true;
    },
  },
});
mock.module('./progress.js', {
  namedExports: { ...progress, startProgressWatcher: () => ({ stop() {} }) },
});
mock.module('./review-agent.js', {
  namedExports: {
    ...reviewAgent,
    persistReviewOutputArtifacts: async () => ({ artifactPaths: [] }),
    readTerminalReviewSignal: async () => null,
  },
});
mock.module('./reviewed-inputs.js', {
  namedExports: {
    noteReviewFixInputsAtLaunch: noop,
    noteReviewInputsAtLaunch: noop,
    recordReviewedInputs: noop,
    readReviewedInputs: async () => null,
  },
});
mock.module('./snapshots.js', {
  namedExports: {
    ...snapshots,
    captureReviewSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        baseSha: 'b'.repeat(40),
        headSha: currentHead,
        diffPath: 'artifacts/review.diff',
        capturedAt: new Date().toISOString(),
      },
      artifactPaths: [],
    }),
    // A reattach reads the range its launch persisted.
    readPersistedReviewSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        baseSha: head,
        headSha: currentHead,
        diffPath: 'artifacts/review.diff',
        capturedAt: new Date().toISOString(),
      },
      artifactPaths: [],
    }),
    captureReviewDeltaSnapshot: async (
      _vars: unknown,
      _taskDir: string,
      _loopNumber: number,
      _scope: unknown,
      range: { lastReviewedHeadSha: string; baseRef?: string },
    ) => {
      deltaCaptures.push(range.lastReviewedHeadSha);
      const interdiff: ReviewInterdiffReceipt | undefined = rebaseQualification
        ? {
            version: 1,
            oldBaseSha: 'a'.repeat(40),
            oldHeadSha: range.lastReviewedHeadSha,
            newBaseSha: 'b'.repeat(40),
            newHeadSha: currentHead,
            rangeDiffHash: 'f'.repeat(64),
            qualification: rebaseQualification,
            priorCommitCount: 4,
            unmatchedOverlappingPairs: rebaseQualification === 'reliable' ? 0 : 2,
            upstreamOverlapFiles: ['src/a.ts'],
            deltaPaths: ['src/a.ts'],
            ...(rebaseQualification === 'unreliable'
              ? { reason: '2 overlapping unmatched pairs exceed 25% of 4 commits' }
              : {}),
          }
        : undefined;
      return {
        snapshot: {
          source: 'local-git',
          baseRef: range.baseRef ?? 'main',
          baseSha: interdiff?.newBaseSha ?? range.lastReviewedHeadSha,
          headSha: currentHead,
          ...(interdiff ? { interdiff, diffHash: 'f'.repeat(64) } : {}),
          diffPath: 'artifacts/review.diff',
          capturedAt: new Date().toISOString(),
        },
        artifactPaths: [],
        comparedRanges: interdiff
          ? [
              `${interdiff.oldBaseSha}..${interdiff.oldHeadSha}`,
              `${interdiff.newBaseSha}..${interdiff.newHeadSha}`,
            ]
          : [`${range.lastReviewedHeadSha}..${currentHead}`],
        ...(interdiff ? { rangeDiffPath: 'artifacts/review-range-diff.txt' } : {}),
      };
    },
    removeSlotFiles: noop,
  },
});
mock.module('./templates.js', {
  namedExports: {
    expandReviewTemplate: async (
      _vars: unknown,
      _task: string,
      _run: string,
      _depth: unknown,
      _paths: unknown,
      comparison?: ReviewDiffSnapshot,
    ) => {
      publicationComparisons.push(comparison);
      return '# Review\n';
    },
    expandReviewFixTemplate: async () =>
      assert.fail('the completed worker fix must not be repeated'),
    getReviewConfig: async () => ({
      enabled: true,
      runner: 'claude',
      model: 'opus',
      max_retries: 0,
    }),
    resolveWorkerTaskDir: async () => 'tasks/review',
  },
});

const { runNativeReviewAgent } = await import('./native-review-agent.js');
const { executeReview }: typeof import('./orchestrator.js') = await import(
  new URL('./orchestrator.js?refunded-native-review', import.meta.url).href
);
const { resetWarmReviewerSessionsForTest } = await import('./session-mode.js');
const { reviewLaunchStartedAt, reviewRoundAdmissionId, runReviewRoundBudget } =
  await import('./review-round-budget.js');

/** A run before publication by default; a ticket naming a PR makes it a published run. */
async function prePublishRun(t: TestContext, ticketOrPr = 'WARM-PREPUBLISH') {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  resetWarmReviewerSessionsForTest();
  ancestorExitCode = 0;
  rebaseQualification = undefined;
  feedbackPass = false;
  currentHead = head;
  worktreeStatus = '';
  commandFailed = false;
  nativeSessionHasInput = undefined;
  stoppedEmptyReviewer = false;
  refuseRecovery = false;
  expectedFixCheck = undefined;
  resumed.length = 0;
  resumeFailure = null;
  dispatches.length = 0;
  deltaCaptures.length = 0;
  publicationComparisons.length = 0;
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'dev',
      project: 'native-review-warm',
      ticketOrPr,
      slotId: vars.slotId,
      transport: 'native',
    }),
  );
  updateRun(run.id, { status: 'reviewing', taskFile: 'tasks/review/TASK.md' });
  const slotRow = (row: Record<string, unknown>[]) =>
    rewriteStatusFile((current) => ({
      ...current,
      slots: [...(current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId), ...row],
    }));
  t.after(async () => {
    resetWarmReviewerSessionsForTest();
    await slotRow([]);
    const closedAt = new Date().toISOString();
    updateRun(run.id, {
      status: 'done',
      completedAt: closedAt,
      agentContexts: getRun(run.id)!.agentContexts?.map((context) =>
        context.nativeSession
          ? { ...context, nativeSession: { ...context.nativeSession, closedAt } }
          : context,
      ),
    });
    await deleteRun(run.id);
    if (previous === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previous;
  });
  await slotRow([{ slot: vars.slotId, current_run_id: run.id }]);
  return run;
}

const priorIssues = [{ file: 'a.ts', line: 3, description: 'finding' }];
const review = (runId: string, options: Partial<Parameters<typeof runNativeReviewAgent>[0]> = {}) =>
  runNativeReviewAgent({
    vars,
    runner: 'claude',
    model: 'opus',
    taskDir: 'tasks/review',
    runId,
    reviewTimeoutMs: 60_000,
    loopNumber: 1,
    validationDepth: 'static-code',
    mode: 'cold',
    reviewId: 'lineage-a',
    // The review catalog fills this when the orchestrator launches. Direct launches must match.
    effort: 'medium',
    ...options,
  });
const reReview = (runId: string, options: Partial<Parameters<typeof review>[1]> = {}) =>
  review(runId, {
    loopNumber: 2,
    mode: 'warm',
    rereview: { lastReviewedHeadSha: head, priorIssues },
    ...options,
  });
const reviewerTask = (runId: string, contextId: string) => {
  const context = getRun(runId)!.agentContexts!.find((entry) => entry.id === contextId)!;
  return slotFiles.get(context.taskFile!) ?? '';
};
const reviewers = (runId: string): AgentContext[] =>
  getRun(runId)!.agentContexts!.filter((context) => context.role === 'review');

for (const status of [' M a.ts\0', 'M  a.ts\0', '?? new.ts\0']) {
  test(`an unchanged-head re-review refuses uncommitted work (${status.replaceAll('\0', '').trim()}) without spending a round`, async (t) => {
    const run = await prePublishRun(t);
    await review(run.id);
    const admissions = [...(getRun(run.id)!.reviewRoundAdmissions ?? [])];
    const contexts = reviewers(run.id).map((context) => context.id);
    worktreeStatus = status;
    await assert.rejects(reReview(run.id), /fix not committed/i);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, admissions);
    assert.deepEqual(
      reviewers(run.id).map((context) => context.id),
      contexts,
    );

    worktreeStatus = '';
    await reReview(run.id);
    assert.equal(dispatches[1]?.retainedFrom?.contextId, dispatches[0]!.contextId);
  });
}

test('a comparison replay re-reviews its uncommitted fix at an unchanged head, reading the working tree', async (t) => {
  const run = await prePublishRun(t);
  updateRun(run.id, { completionPolicy: 'artifact-only', lane: 'comparison' });
  await review(run.id);
  // The comparison task leaves the fix in the working tree; HEAD is the reviewed commit.
  worktreeStatus = ' M a.ts\0';
  await reReview(run.id);
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]?.retainedFrom?.contextId, dispatches[0]!.contextId);
  const task = reviewerTask(run.id, dispatches[1]!.contextId);
  assert.match(task, /## The work is uncommitted/);
  assert.ok(task.includes(`--stat ${head}`), 'the scope names the working-tree diff against HEAD');
  // The delta is pinned at the unchanged head, so review.diff is empty: only the scope shows the fix.
  assert.deepEqual(deltaCaptures, [head]);
});

test('a comparison replay re-reviewed over a rebase gets the working-tree scope with its interdiff', async (t) => {
  const run = await prePublishRun(t, published);
  updateRun(run.id, { completionPolicy: 'artifact-only', lane: 'comparison' });
  await review(run.id);
  worktreeStatus = ' M a.ts\0';
  rebaseQualification = 'reliable';
  const result = await reReview(run.id);
  assert.equal(result.mode, 'warm');
  assert.ok(result.reviewSnapshot?.interdiff);
  assert.match(reviewerTask(run.id, dispatches.at(-1)!.contextId), /## The work is uncommitted/);
});

test('a comparison replay whose reviewer cannot resume gets the working-tree scope in the fresh session', async (t) => {
  const run = await prePublishRun(t, published);
  updateRun(run.id, { completionPolicy: 'artifact-only', lane: 'comparison' });
  await review(run.id);
  worktreeStatus = ' M a.ts\0';
  resumeFailure = 'handoff';
  const result = await reReview(run.id);
  assert.equal(result.mode, 'cold');
  assert.match(reviewerTask(run.id, dispatches.at(-1)!.contextId), /## The work is uncommitted/);
});

test('an artifact-only run outside the comparison lane still commits its fix before a re-review', async (t) => {
  const run = await prePublishRun(t);
  updateRun(run.id, { completionPolicy: 'artifact-only' });
  await review(run.id);
  worktreeStatus = ' M a.ts\0';
  await assert.rejects(reReview(run.id), /fix not committed/i);
});

test('generated untracked slot support does not block an evidence re-review', async (t) => {
  const run = await prePublishRun(t);
  await review(run.id);
  worktreeStatus = '?? .agent/generated.json\0?? .claude/CLAUDE.local.md\0';
  await reReview(run.id);
  assert.equal(dispatches.length, 2);
});

test('a changed committed head can be re-reviewed while other work remains dirty', async (t) => {
  const run = await prePublishRun(t);
  await review(run.id);
  currentHead = 'c'.repeat(40);
  worktreeStatus = ' M a.ts\n';
  await reReview(run.id);
  assert.equal(dispatches.length, 2);
});

test('a pre-publish reviewer registers its session and the WARM re-review continues it', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  assert.equal(first.session?.repository, undefined);
  const second = await reReview(run.id);
  assert.equal(dispatches[1]?.retainedFrom?.contextId, dispatches[0]!.contextId);
  assert.equal(second.mode, 'warm');
  assert.equal(second.session?.continuity, 'resumed');
  assert.equal(second.session?.priorSessionId, first.reviewerSessionId);
  assert.equal(second.reviewerSessionId, first.reviewerSessionId);
  assert.equal(second.session?.fallback, undefined);
  assert.deepEqual(deltaCaptures, [head]);
});

test('a validated pipeline reviewer survives a registry reset before its final review row exists', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  const context = reviewers(run.id)[0]!;
  assert.ok(context.reviewResultValidatedAt);
  assert.ok(context.nativeSession?.closedAt);
  assert.equal(getRun(run.id)!.engineState?.publishGate?.reviews?.length ?? 0, 0);
  resetWarmReviewerSessionsForTest();

  const second = await reReview(run.id);
  assert.equal(second.mode, 'warm');
  assert.equal(second.reviewerSessionId, first.reviewerSessionId);
  assert.equal(dispatches[1]?.retainedFrom?.contextId, context.id);
  assert.equal(second.session?.fallback, undefined);
  assert.deepEqual(deltaCaptures, [head]);
});

test('restart continues the latest validated pipeline session after a fresh delta fallback', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  rebaseQualification = 'unreliable';
  currentHead = 'c'.repeat(40);
  const second = await reReview(run.id);
  const latest = reviewers(run.id).at(-1)!;
  assert.notEqual(second.reviewerSessionId, first.reviewerSessionId);
  ancestorExitCode = 0;
  rebaseQualification = undefined;
  resetWarmReviewerSessionsForTest();

  const third = await reReview(run.id, { loopNumber: 3 });
  assert.equal(third.mode, 'warm');
  assert.equal(third.reviewerSessionId, second.reviewerSessionId);
  assert.equal(dispatches[2]?.retainedFrom?.contextId, latest.id);
  assert.equal(third.session?.fallback, undefined);
});

for (const [label, patch] of [
  ['validation', { reviewResultValidatedAt: undefined }],
  ['immutable reviewed head', { deliveryBaselineRef: 'main' }],
  ['slot binding', { slotId: 'another-slot' }],
] satisfies Array<[string, Partial<AgentContext>]>) {
  test(`pipeline restart requires ${label} before reusing a reviewer`, async (t) => {
    const run = await prePublishRun(t);
    await review(run.id);
    const context = reviewers(run.id)[0]!;
    updateRun(run.id, {
      agentContexts: reviewers(run.id).map((candidate) =>
        candidate.id === context.id ? { ...candidate, ...patch } : candidate,
      ),
    });
    resetWarmReviewerSessionsForTest();

    const next = await reReview(run.id);
    assert.equal(next.mode, 'cold');
    assert.equal(next.session?.fallback?.reason, 'missing-session');
    assert.equal(dispatches[1]?.retainedFrom, undefined);
  });
}

const published = 'owner/repo#42';

test('an automatic re-review with no retained session runs a delta-scoped COLD and records why', async (t) => {
  const run = await prePublishRun(t, published);
  const result = await reReview(run.id);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.continuity, 'fresh');
  assert.equal(result.reviewId, 'lineage-a');
  assert.deepEqual(result.session?.fallback, {
    reason: 'missing-session',
    detail: 'no verified previous reviewer of this lineage is retained',
    comparedRanges: [`${head}..${head}`],
  });
  assert.deepEqual(deltaCaptures, [head]);
  assert.equal(publicationComparisons[0]?.baseRef, 'origin/main');
  assert.equal(publicationComparisons[0]?.baseSha, 'b'.repeat(40));
  assert.equal(result.reviewSnapshot?.baseSha, head, 'the correctness review stays on its delta');
  assert.equal(dispatches[0]?.retainedFrom, undefined);
  const task = reviewerTask(run.id, dispatches[0]!.contextId);
  assert.match(task, /## Delta-scoped review in a fresh session/);
  assert.match(task, /a\.ts:3: finding/);
  // Its fresh session became the lineage's retained session.
  const next = await reReview(run.id, { loopNumber: 3 });
  assert.equal(next.session?.continuity, 'resumed');
  assert.equal(next.reviewerSessionId, result.reviewerSessionId);
});

test('a person asking for WARM without a retained session still sees the refusal', async (t) => {
  const run = await prePublishRun(t, published);
  await assert.rejects(
    review(run.id, { loopNumber: 2, mode: 'warm' }),
    /WARM review refused \(missing-session\)/,
  );
  assert.deepEqual(dispatches, []);
});

test('a reliable rebase resumes the same reviewer with its pinned author interdiff', async (t) => {
  const run = await prePublishRun(t, published);
  const first = await review(run.id);
  rebaseQualification = 'reliable';
  feedbackPass = true;
  const result = await reReview(run.id);
  assert.equal(result.mode, 'warm');
  assert.equal(result.session?.continuity, 'resumed');
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
  assert.ok(dispatches[1]?.retainedFrom);
  assert.ok(first.reviewSnapshot?.headSha);
  assert.ok(result.reviewSnapshot?.headSha);
  assert.equal(result.session?.lastReviewedHeadSha, first.reviewSnapshot.headSha);
  const { buildPublishGateReviewStatus, reviewFinalSnapshotMatchesPreparedPackage } =
    await import('../run-engine/gate-policy.js');
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 0,
    reviewResult: { ...result, runner: 'claude', retryCount: 0 },
    requestedRunner: 'claude',
    reviewId: result.reviewId,
  });
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(status, {
      headSha: result.reviewSnapshot.headSha,
      reviewSnapshot: result.reviewSnapshot,
    }),
    true,
  );
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(status, {
      headSha: result.reviewSnapshot.headSha,
      reviewSnapshot: { ...result.reviewSnapshot, diffHash: 'dirty-source' },
    }),
    false,
  );
  assert.match(
    reviewerTask(run.id, dispatches[1]!.contextId),
    /Author interdiff after the base moved/,
  );
});

test('an unreliable rebase records its bounded cold fallback and keeps the review lineage', async (t) => {
  const run = await prePublishRun(t, published);
  const first = await review(run.id);
  rebaseQualification = 'unreliable';
  const result = await reReview(run.id);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.fallback?.reason, 'interdiff-unreliable');
  assert.equal(result.session?.reviewId, first.session?.reviewId);
  assert.equal(dispatches[1]?.retainedFrom, undefined);
  assert.notEqual(result.reviewerSessionId, first.reviewerSessionId);
});

test('an uncertain handoff is reconciled under its same context before a cold fallback', async (t) => {
  const run = await prePublishRun(t, published);
  const first = await review(run.id);
  const sessionsBefore = freshSessions;
  resumeFailure = 'handoff-once';
  const result = await reReview(run.id);
  assert.equal(result.mode, 'warm');
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
  assert.equal(result.session?.fallback, undefined);
  assert.equal(dispatches.length, 3);
  assert.equal(dispatches[1]!.contextId, dispatches[2]!.contextId);
  assert.deepEqual(dispatches[1]!.retainedFrom, dispatches[2]!.retainedFrom);
  assert.equal(freshSessions, sessionsBefore);
  assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length, 2);
});

test('a legacy retained reviewer keeps its original launch environment policy', async (t) => {
  const run = await prePublishRun(t, published);
  const first = await review(run.id);
  updateRun(run.id, {
    agentContexts: getRun(run.id)!.agentContexts!.map((context) => ({
      ...context,
      reviewValidationDepth: undefined,
    })),
  });
  const result = await reReview(run.id);
  assert.equal(result.mode, 'warm');
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
  assert.equal(reviewers(run.id).at(-1)!.reviewValidationDepth, undefined);
});

test('an explicit validation-depth change uses a paid fresh delta review', async (t) => {
  const run = await prePublishRun(t, published);
  await review(run.id);
  const result = await reReview(run.id, { validationDepth: 'full-live' });
  assert.equal(result.mode, 'cold');
  assert.match(result.session?.fallback?.detail ?? '', /validation depth differs/);
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1]!.retainedFrom, undefined);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 2);
});

test('a resume that remains unavailable after reconciliation falls back under the same receipt', async (t) => {
  const run = await prePublishRun(t, published);
  await review(run.id);
  const admittedBefore = getRun(run.id)!.reviewRoundAdmissions?.length ?? 0;
  resumeFailure = 'handoff';
  const result = await reReview(run.id);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.fallback?.reason, 'session-unavailable');
  assert.match(
    result.session?.fallback?.detail ?? '',
    /could not resume: transfer refused \(no live session\)$/,
  );
  assert.equal(dispatches.length, 4);
  assert.ok(dispatches[1]!.retainedFrom);
  assert.equal(dispatches[1]!.contextId, dispatches[2]!.contextId);
  assert.equal(dispatches[3]!.retainedFrom, undefined);
  assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length, admittedBefore + 1);
  assert.deepEqual(
    Object.values(getRun(run.id)!.reviewRoundSettlements ?? {})
      .filter(isReviewRoundNoVerdictSettlement)
      .map((entry) => entry.kind),
    ['infrastructure-fallback'],
  );
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, admittedBefore);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).noVerdict, 1);
  assert.deepEqual(
    reviewers(run.id).map((context) => context.status),
    ['complete', 'failed', 'complete'],
  );
  // The fallback keeps the admitted attempt's launch time: its receipt is the admitted one.
  const fallback = reviewers(run.id).at(-1)!;
  const admitted = getRun(run.id)!.reviewRoundAdmissions ?? [];
  assert.ok(
    admitted.includes(
      reviewRoundAdmissionId(
        fallback.reviewId!,
        fallback.reviewLoopNumber!,
        reviewLaunchStartedAt(fallback),
      ),
    ),
  );
  // A restart reattaches to the running fallback: same receipt, same fallback record.
  updateRun(run.id, {
    agentContexts: getRun(run.id)!.agentContexts!.map((context) =>
      context.id === fallback.id ? { ...context, status: 'working' as const } : context,
    ),
  });
  const reattached = await reReview(run.id);
  assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length, admitted.length);
  assert.equal(reattached.mode, 'cold');
  assert.deepEqual(reattached.session?.fallback, result.session?.fallback);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, admittedBefore);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).noVerdict, 1);
});

test('a delivery that may have reached the retained reviewer never starts a second reviewer', async (t) => {
  const run = await prePublishRun(t, published);
  await review(run.id);
  resumeFailure = 'delivery';
  await assert.rejects(reReview(run.id), NativeWorkerOperationUncertainError);
  assert.equal(dispatches.length, 2);
  assert.deepEqual(deltaCaptures, [head]);
});

test('a superseded resume settles its round no-verdict instead of falling back', async (t) => {
  const run = await prePublishRun(t, published);
  await review(run.id);
  resumeFailure = 'superseded';
  await assert.rejects(reReview(run.id), /superseded/);
  assert.equal(dispatches.length, 2);
  assert.equal(
    Object.values(getRun(run.id)!.reviewRoundSettlements ?? {}).filter(
      isReviewRoundNoVerdictSettlement,
    ).length,
    1,
  );
});

test('a failed review retires only its own lineage', async (t) => {
  const run = await prePublishRun(t, published);
  await review(run.id);
  await review(run.id, { reviewId: 'lineage-b' });
  resumeFailure = 'delivery';
  await assert.rejects(reReview(run.id), NativeWorkerOperationUncertainError);
  resumeFailure = null;
  const other = await reReview(run.id, { reviewId: 'lineage-b' });
  assert.equal(other.session?.continuity, 'resumed');
});

/** Another turn of the same lineage runs on the retained session until `release`. */
function holdSession(runId: string) {
  const retained = reviewers(runId)[0]!;
  updateRun(runId, {
    agentContexts: [
      ...getRun(runId)!.agentContexts!,
      {
        id: 'holder',
        role: 'review',
        label: 'Review',
        status: 'working',
        runId,
        slotId: vars.slotId,
        reviewId: retained.reviewId,
        runnerSessionId: retained.runnerSessionId,
      },
    ],
  });
  return () =>
    updateRun(runId, {
      agentContexts: getRun(runId)!.agentContexts!.map((context) =>
        context.id === 'holder' ? { ...context, status: 'complete' as const } : context,
      ),
    });
}

test('a busy retained reviewer is waited for, then continued', async (t) => {
  const run = await prePublishRun(t, published);
  const first = await review(run.id);
  const release = holdSession(run.id);
  const timer = setTimeout(release, 300);
  t.after(() => clearTimeout(timer));
  const result = await reReview(run.id);
  assert.equal(result.session?.continuity, 'resumed');
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
});

test('a reviewer still busy at the deadline falls back to the delta', async (t) => {
  const run = await prePublishRun(t, published);
  await review(run.id);
  holdSession(run.id);
  const result = await reReview(run.id, { reviewTimeoutMs: 300 });
  assert.equal(result.session?.fallback?.reason, 'session-busy');
  assert.equal(result.mode, 'cold');
});

// A structured failed command is infrastructure failure, not another code verdict.
test('a failed warm command retries its same session and refunded attempt after recovery', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  commandFailed = true;
  await assert.rejects(reReview(run.id));
  const failed = reviewers(run.id).at(-1)!;
  const admissions = [...getRun(run.id)!.reviewRoundAdmissions!];
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
  assert.equal(failed.reviewResultValidatedAt, undefined);
  assert.equal(failed.runnerSessionId, first.reviewerSessionId);
  // Simulate the runner's auth having recovered and a gateway restart losing its in-memory registry.
  commandFailed = false;
  resetWarmReviewerSessionsForTest();
  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    mode: 'warm',
    reviewId: 'lineage-a',
    publicationReview: true,
    validationDepth: 'static-code',
    resumeFromResult: { ...first, retryCount: 0 },
  });
  assert.deepEqual(resumed, [failed.id]);
  assert.equal(result.mode, 'warm');
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
  assert.equal(result.session?.fallback, undefined);
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, admissions);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 2);
  assert.equal(reviewers(run.id).length, 2, 'no replacement reviewer context');
});

test('an operator delta request retries the refunded WARM attempt without a restart or fresh review', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  currentHead = 'c'.repeat(40);
  commandFailed = true;
  await assert.rejects(reReview(run.id));
  const failed = reviewers(run.id).at(-1)!;
  const admissions = [...getRun(run.id)!.reviewRoundAdmissions!];
  const dispatchCount = dispatches.length;
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
  // Auth is repaired externally. The gate supplies rereview, not resumeFromResult,
  // and this process still has the failed attempt's invalidated session cache.
  commandFailed = false;
  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    mode: 'warm',
    reviewId: 'lineage-a',
    publicationReview: true,
    validationDepth: 'static-code',
    rereview: { lastReviewedHeadSha: head, priorIssues },
  });
  assert.deepEqual(resumed, [failed.id]);
  assert.equal(dispatches.length, dispatchCount, 'no replacement reviewer dispatch');
  assert.equal(result.mode, 'warm');
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
  assert.equal(result.session?.fallback, undefined);
  assert.equal(result.reviewSnapshot?.baseSha, head);
  assert.equal(result.reviewSnapshot?.headSha, currentHead);
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, admissions);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 2);
  assert.equal(reviewers(run.id).length, 2);
});

test('an explicit cold request does not adopt a refunded warm attempt', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  commandFailed = true;
  await assert.rejects(reReview(run.id));
  commandFailed = false;
  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    mode: 'cold',
    reviewId: 'lineage-a',
    publicationReview: true,
    validationDepth: 'static-code',
  });
  assert.equal(result.mode, 'cold');
  assert.notEqual(result.reviewerSessionId, first.reviewerSessionId);
  assert.equal(result.reviewSnapshot?.baseSha, 'b'.repeat(40));
  assert.deepEqual(resumed, []);
});

test('a later valid COLD review supersedes the old refunded WARM attempt', async (t) => {
  const run = await prePublishRun(t);
  await review(run.id);
  commandFailed = true;
  await assert.rejects(reReview(run.id));
  const failed = reviewers(run.id).at(-1)!;
  commandFailed = false;
  currentHead = 'd'.repeat(40);
  const latest = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    mode: 'cold',
    reviewId: 'lineage-a',
    publicationReview: true,
    validationDepth: 'static-code',
  });
  const latestContext = reviewers(run.id).at(-1)!;
  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    mode: 'warm',
    reviewId: 'lineage-a',
    publicationReview: true,
    validationDepth: 'static-code',
    rereview: { lastReviewedHeadSha: currentHead, priorIssues },
  });
  assert.deepEqual(resumed, [], 'the old refunded context must not resume');
  assert.equal(dispatches.at(-1)?.retainedFrom?.contextId, latestContext.id);
  assert.equal(result.reviewerSessionId, latest.reviewerSessionId);
  assert.notEqual(result.reviewerSessionId, failed.runnerSessionId);
  assert.ok(
    getRun(run.id)!.reviewRoundSettlements?.[
      reviewRoundAdmissionId(
        failed.reviewId!,
        failed.reviewLoopNumber!,
        reviewLaunchStartedAt(failed),
      )
    ],
  );
});

test('a newly reserved repair reaches its worker path before any refunded reviewer', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  commandFailed = true;
  await assert.rejects(reReview(run.id));
  commandFailed = false;
  const admissions = [...getRun(run.id)!.reviewRoundAdmissions!];
  expectedFixCheck = new Error('The reserved repair reached its worker path');
  await assert.rejects(
    executeReview(run.id, vars.slotId, {
      reviewRunner: 'claude',
      model: 'opus',
      mode: 'warm',
      reviewId: 'lineage-a',
      publicationReview: true,
      validationDepth: 'static-code',
      resumeFromResult: { ...first, retryCount: 0 },
      reservedFixPass: {},
    }),
    (error) => error === expectedFixCheck,
  );
  assert.deepEqual(resumed, []);
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, admissions);
});

test('a reviewer already launched for the same reserved repair retries without another worker pass', async (t) => {
  const run = await prePublishRun(t);
  const first = await review(run.id);
  commandFailed = true;
  await assert.rejects(reReview(run.id));
  commandFailed = false;
  const failed = reviewers(run.id).at(-1)!;
  await upsertAgentContext(run.id, 'review', {
    id: failed.id,
    pipelineVisualReviewInput: {
      schemaVersion: 2,
      headSha: head,
      repairId: 'owned-repair',
      scopeDigest: 'sha256:' + 'a'.repeat(64),
      sources: [],
      retained: [],
    },
  });
  expectedFixCheck = new Error('The already completed repair must not be repeated');
  const admissions = [...getRun(run.id)!.reviewRoundAdmissions!];
  const result = await executeReview(run.id, vars.slotId, {
    reviewRunner: 'claude',
    model: 'opus',
    mode: 'warm',
    reviewId: 'lineage-a',
    publicationReview: true,
    validationDepth: 'static-code',
    resumeFromResult: { ...first, retryCount: 0 },
    reservedFixPass: { repairId: 'owned-repair' },
  });
  assert.equal(result.reviewerSessionId, first.reviewerSessionId);
  assert.deepEqual(resumed, [failed.id]);
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, admissions);
});

for (const evidence of [false, true, undefined]) {
  test(`stopped reviewer input evidence ${evidence}: only proven empty replaces its session`, async (t) => {
    const run = await prePublishRun(t);
    await review(run.id);
    commandFailed = true;
    await assert.rejects(reReview(run.id));
    const failed = reviewers(run.id).at(-1)!;
    commandFailed = false;
    stoppedEmptyReviewer = true;
    nativeSessionHasInput = evidence;
    const sessionsBefore = freshSessions;
    const result = await executeReview(run.id, vars.slotId, {
      reviewRunner: 'claude',
      model: 'opus',
      mode: 'warm',
      reviewId: 'lineage-a',
      publicationReview: true,
      validationDepth: 'static-code',
      rereview: { lastReviewedHeadSha: head, priorIssues },
    });
    if (evidence === false) {
      assert.equal(result.mode, 'cold');
      assert.match(result.session?.fallback?.detail ?? '', /never received input/);
      assert.equal(freshSessions, sessionsBefore + 1);
      assert.deepEqual(resumed, [], 'never resume an unmaterialized thread');
      assert.notEqual(reviewers(run.id).at(-1)!.id, failed.id);
    } else {
      assert.equal(result.mode, 'warm');
      assert.equal(freshSessions, sessionsBefore);
      assert.deepEqual(resumed, [failed.id]);
    }
  });
}

for (const evidence of [true, undefined]) {
  test(`resume failure with input evidence ${evidence} keeps its reservation`, async (t) => {
    const run = await prePublishRun(t);
    await review(run.id);
    commandFailed = true;
    await assert.rejects(reReview(run.id));
    const failed = reviewers(run.id).at(-1)!;
    const sessionsBefore = freshSessions;
    commandFailed = false;
    stoppedEmptyReviewer = true;
    nativeSessionHasInput = evidence;
    refuseRecovery = true;
    await assert.rejects(
      executeReview(run.id, vars.slotId, {
        reviewRunner: 'claude',
        model: 'opus',
        mode: 'warm',
        reviewId: 'lineage-a',
        publicationReview: true,
        validationDepth: 'static-code',
        rereview: { lastReviewedHeadSha: head, priorIssues },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof NativeWorkerOperationUncertainError &&
        error.cause.message === 'handoff recovery unconfirmed',
    );
    assert.equal(freshSessions, sessionsBefore);
    assert.equal(reviewers(run.id).at(-1)!.id, failed.id);
    assert.equal(
      reviewers(run.id).at(-1)!.nativeSession?.sessionId,
      failed.nativeSession?.sessionId,
    );
  });
}
