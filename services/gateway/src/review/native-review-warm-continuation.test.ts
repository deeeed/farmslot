import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import type { AgentContext, Principal } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const exec = await import('../core/exec.js');
const checklist = await import('../tasks/checklist-target.js');
const snapshots = await import('./snapshots.js');
const reviewAgent = await import('./review-agent.js');
const { upsertAgentContext } = await import('../agents/contexts.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { NativeWorkerOperationUncertainError } = await import('../runners/native/worker-error.js');

const vars = makeVars();
const owner: Principal = {
  id: 'native-review-warm-owner',
  subject: { type: 'person', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const head = 'a'.repeat(40);
const noop = async () => {};
// Scripted host behaviour; the run store, the session registry and the round budget are real.
let ancestorExitCode = 0;
let failResume = false;
let freshSessions = 0;
const dispatches: Array<{ contextId: string; retainedFrom?: { contextId: string } }> = [];
const deltaCaptures: string[] = [];

mock.module('../core/config.js', {
  namedExports: { ...config, loadProjectVars: async () => ({ projectJson: {} }) },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execOnSlot: async (_vars: unknown, command: string) => ({
      exitCode: command.startsWith('git merge-base --is-ancestor') ? ancestorExitCode : 0,
      stdout: '',
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
  namedExports: { probeWorkerSignalForRun: async () => ({ ok: true }) },
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
    cancelNativeWorkerContext: noop,
    dispatchNativeWorker: async (input: {
      runId: string;
      contextId: string;
      retainedFrom?: { runId: string; contextId: string };
    }) => {
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
      };
      if (source && failResume) {
        // The handoff reservation exists, but the reviewer never accepted the prompt.
        await upsertAgentContext(input.runId, 'review', {
          id: input.contextId,
          nativeSession: binding,
        });
        throw new NativeWorkerOperationUncertainError('handoff', 'transfer refused', undefined);
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
    readNativeWorkerSnapshot: async () => ({
      session: { state: 'running' },
      commands: [{ commandId: 'review-command', state: 'completed', outcome: 'completed' }],
    }),
  },
});
mock.module('../runners/native/worker-recovery.js', { namedExports: { resumeNativeWorker: noop } });
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
mock.module('../tasks/watcher.js', { namedExports: { unwatchContext: noop } });
mock.module('./feedback.js', {
  namedExports: {
    readReviewFeedback: async () => ({
      verdict: 'issues',
      issues: [{ file: 'a.ts', line: 3, description: 'finding' }],
    }),
  },
});
mock.module('./native-reviewer-approvals.js', {
  namedExports: { refuseReviewerApprovals: async () => 0 },
});
mock.module('./progress.js', { namedExports: { startProgressWatcher: () => ({ stop() {} }) } });
mock.module('./review-agent.js', {
  namedExports: {
    ...reviewAgent,
    persistReviewOutputArtifacts: async () => ({ artifactPaths: [] }),
    readTerminalReviewSignal: async () => null,
  },
});
mock.module('./reviewed-inputs.js', { namedExports: { noteReviewInputsAtLaunch: noop } });
mock.module('./snapshots.js', {
  namedExports: {
    ...snapshots,
    captureReviewSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        baseSha: 'b'.repeat(40),
        headSha: head,
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
      range: { lastReviewedHeadSha: string },
    ) => {
      deltaCaptures.push(range.lastReviewedHeadSha);
      return {
        snapshot: {
          source: 'local-git',
          baseSha: range.lastReviewedHeadSha,
          headSha: head,
          diffPath: 'artifacts/review.diff',
          capturedAt: new Date().toISOString(),
        },
        artifactPaths: [],
        comparedRanges: [`${range.lastReviewedHeadSha}..${head}`],
      };
    },
    removeSlotFiles: noop,
  },
});
mock.module('./templates.js', {
  namedExports: { expandReviewTemplate: async () => '# Review\n' },
});

const { runNativeReviewAgent } = await import('./native-review-agent.js');
const { resetWarmReviewerSessionsForTest } = await import('./session-mode.js');

/** A run before publication: no PR exists yet. */
async function prePublishRun(t: TestContext) {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  resetWarmReviewerSessionsForTest();
  ancestorExitCode = 0;
  failResume = false;
  dispatches.length = 0;
  deltaCaptures.length = 0;
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'dev',
      project: 'native-review-warm',
      ticketOrPr: 'WARM-PREPUBLISH',
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
  assert.deepEqual(deltaCaptures, []);
});

test('an automatic re-review with no retained session runs a delta-scoped COLD and records why', async (t) => {
  const run = await prePublishRun(t);
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
  const run = await prePublishRun(t);
  await assert.rejects(
    review(run.id, { loopNumber: 2, mode: 'warm' }),
    /WARM review refused \(missing-session\)/,
  );
  assert.deepEqual(dispatches, []);
});

test('a head that no longer descends from the reviewed head falls back to the delta', async (t) => {
  const run = await prePublishRun(t);
  await review(run.id);
  ancestorExitCode = 1;
  const result = await reReview(run.id);
  assert.equal(result.session?.fallback?.reason, 'reviewed-head-not-ancestor');
  assert.equal(dispatches[1]?.retainedFrom, undefined);
  assert.notEqual(result.reviewerSessionId, reviewers(run.id)[0]!.runnerSessionId);
});

test('a resume that fails to start runs the fallback under the same admitted round', async (t) => {
  const run = await prePublishRun(t);
  await review(run.id);
  const admittedBefore = getRun(run.id)!.reviewRoundAdmissions?.length ?? 0;
  failResume = true;
  const result = await reReview(run.id);
  assert.equal(result.mode, 'cold');
  assert.equal(result.session?.fallback?.reason, 'session-unavailable');
  assert.match(result.session?.fallback?.detail ?? '', /could not resume/);
  assert.equal(dispatches.length, 3);
  assert.ok(dispatches[1]!.retainedFrom);
  assert.equal(dispatches[2]!.retainedFrom, undefined);
  assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length, admittedBefore + 1);
  assert.equal(getRun(run.id)!.reviewRoundSettlements, undefined);
  assert.deepEqual(
    reviewers(run.id).map((context) => context.status),
    ['complete', 'failed', 'complete'],
  );
});
