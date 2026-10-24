import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import type { NativeSessionEvent, Principal } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const checklist = await import('../tasks/checklist-target.js');
const snapshots = await import('./snapshots.js');
const reviewAgent = await import('./review-agent.js');
const { upsertAgentContext } = await import('../agents/contexts.js');
const { rewriteStatusFile } = await import('../core/state.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { NativeWorkerOperationUncertainError } = await import('../runners/native/worker-error.js');
const { PromptDeliveryUncertainError } = await import('../runners/registry.js');

type Ending =
  | 'command-failed'
  | 'timeout'
  | 'exit'
  | 'incomplete'
  | 'verdict'
  | 'uncertain-launch'
  | 'uncertain-delivery'
  | 'checklist-progress'
  | 'tool-progress'
  | 'paged-tools'
  | 'foreign-tools'
  | 'stale-checklist'
  | 'accepted-start'
  | 'inactive'
  | 'completion-turn'
  | 'completion-unfinished'
  | 'completion-live'
  | 'completion-restart'
  | 'completion-closed-restart'
  | 'completion-deferred'
  | 'completion-interrupted'
  | 'completion-invalid-idle'
  | 'completion-invalid';
let ending: Ending = 'verdict';
let timeline: { now: number; polls: number; stepMs?: number } | undefined;
let configuredInactivityMinutes: number | undefined;
const readCursors: Array<number | undefined> = [];
const vars = makeVars();
const owner: Principal = {
  id: 'native-review-settlement-owner',
  subject: { type: 'person', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const binding = {
  sessionId: 'reviewer-session',
  executionNodeId: 'local',
  ownerPrincipalId: owner.id,
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'review-command',
};
const noop = async () => {};
// Reviewer contexts whose process the agent stopped, and whether that stop fails.
const stopped: string[] = [];
let stopFails = false;
const completionCommands: string[] = [];
let loseCompletionReply = false;
let completionLaunches = 0;
let completionActivityPages: NativeSessionEvent[][] | undefined;
let deferredClock: { now: number; polls: number } | undefined;
const completionCase = () => ending.startsWith('completion-');

// The reviewer's host, slot files and runner are scripted; the run store and the
// review round budget are real.
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadProjectVars: async () => ({
      projectJson: { review: { review_inactivity_timeout_min: configuredInactivityMinutes } },
    }),
  },
});
// The reviewer's TASK.md, by path.
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
    probeWorkerSignalForRun: async (runId: string) => {
      if (completionCase()) {
        const context = getRun(runId)!.agentContexts?.find((entry) => entry.role === 'review');
        if (
          ending !== 'completion-unfinished' &&
          ending !== 'completion-interrupted' &&
          ending !== 'completion-closed-restart' &&
          context?.nativeSession?.commandId !== binding.commandId
        )
          return { ok: true };
        return {
          ok: false,
          code: 'non_terminal',
          signal: { status: 'running', timestamp: new Date().toISOString() },
        };
      }
      if (timeline) {
        if (ending !== 'inactive' && timeline.polls >= 4) return { ok: true };
        return {
          ok: false,
          code: 'non_terminal',
          signal: {
            role: 'review',
            status: 'running',
            timestamp: new Date(timeline.now).toISOString(),
            checklistTiming: {
              schemaVersion: 1,
              events:
                ending === 'checklist-progress' || ending === 'stale-checklist'
                  ? [
                      {
                        stepNumber: timeline.polls,
                        label: 'Inspect',
                        checkedAt: new Date(
                          ending === 'stale-checklist' ? 0 : timeline.now,
                        ).toISOString(),
                      },
                    ]
                  : [],
            },
          },
        };
      }
      return ending === 'timeout' || ending === 'exit' || ending === 'command-failed'
        ? { ok: false, code: 'missing', message: 'no signal' }
        : { ok: true };
    },
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
    cancelNativeWorkerContext: async (_runId: string, context: { id: string }) => {
      stopped.push(context.id);
      if (stopFails) throw new Error('native worker stop is unconfirmed');
    },
    dispatchNativeWorker: async (input: { runId: string; contextId: string }) => {
      const current = getRun(input.runId)!.agentContexts?.find(
        (entry) => entry.id === input.contextId,
      );
      if (current?.nativeSession?.closedAt)
        throw new Error('Native worker task lease is closed; use explicit recovery');
      if (
        getRun(input.runId)!.agentContexts?.find((entry) => entry.id === input.contextId)
          ?.nativeCommandId
      )
        return;
      if (completionCase()) completionLaunches++;
      await upsertAgentContext(input.runId, 'review', {
        id: input.contextId,
        status: 'working',
        runnerSessionId: 'saved-review-conversation',
        nativeSession: completionCase()
          ? { ...binding, acceptedAt: new Date().toISOString() }
          : ending === 'accepted-start'
            ? { ...binding, acceptedAt: new Date(0).toISOString() }
            : binding,
      });
      // The host may have started the reviewer before its reply was lost.
      if (ending === 'uncertain-launch')
        throw new NativeWorkerOperationUncertainError('launch', 'launch reply lost', undefined);
      if (ending === 'uncertain-delivery')
        throw new PromptDeliveryUncertainError('review prompt delivery is unconfirmed');
    },
  },
});
mock.module('../runners/native/worker-control.js', {
  namedExports: {
    readNativeWorkerSnapshot: async (
      _runId: string,
      _role: string,
      _contextId: string,
      history?: { after?: number },
    ) => {
      if (completionCase()) {
        const current = getRun(_runId)!.agentContexts!.find((entry) => entry.role === 'review')!;
        const continued = current.nativeSession!.commandId !== binding.commandId;
        return {
          session: {
            state:
              ending === 'completion-closed-restart'
                ? 'closed'
                : continued || ['completion-live', 'completion-invalid-idle'].includes(ending)
                  ? 'idle'
                  : 'closed',
            processStopped:
              ending === 'completion-closed-restart' ||
              (!continued && !['completion-live', 'completion-invalid-idle'].includes(ending)),
            nativeSessionId: 'saved-review-conversation',
          },
          commands: [
            {
              commandId: current.nativeSession!.commandId,
              generation: current.nativeSession!.generation,
              accepted: true,
              state:
                continued || ['completion-live', 'completion-invalid-idle'].includes(ending)
                  ? 'completed'
                  : 'failed',
              outcome:
                continued && ending === 'completion-interrupted'
                  ? 'interrupted'
                  : continued || ['completion-live', 'completion-invalid-idle'].includes(ending)
                    ? 'completed'
                    : 'failed',
            },
          ],
          events: completionActivityPages?.[history?.after ?? 0] ?? [],
          pendingRequests: [],
          cursor: completionActivityPages ? (history?.after ?? 0) + 1 : 0,
          hasMore: completionActivityPages
            ? (history?.after ?? 0) + 1 < completionActivityPages.length
            : false,
        };
      }
      if (timeline) {
        readCursors.push(history?.after);
        timeline.now += timeline.stepMs ?? 10 * 60_000;
        timeline.polls++;
        const events: NativeSessionEvent[] = [
          {
            sessionId: binding.sessionId,
            generation: binding.generation,
            commandId: ending === 'foreign-tools' ? 'earlier-command' : binding.commandId,
            sequence: timeline.polls,
            at: new Date(
              ending === 'paged-tools' && timeline.polls === 1 ? 0 : timeline.now,
            ).toISOString(),
            type:
              ending === 'accepted-start'
                ? timeline.polls === 1
                  ? 'command.accepted'
                  : 'tool.completed'
                : ['tool-progress', 'paged-tools', 'foreign-tools'].includes(ending)
                  ? 'tool.completed'
                  : 'text.delta',
          },
        ];
        return {
          session: { state: 'running' },
          commands:
            ending !== 'inactive' && timeline.polls >= 4
              ? [{ commandId: binding.commandId, state: 'completed', outcome: 'completed' }]
              : [],
          events,
          cursor: timeline.polls,
          hasMore: ending === 'paged-tools' && timeline.polls === 1,
        };
      }
      return {
        session:
          ending === 'exit'
            ? { state: 'closed', processStopped: true, error: 'reviewer process exited' }
            : { state: 'running' },
        commands:
          ending === 'command-failed'
            ? [{ commandId: binding.commandId, state: 'failed', outcome: 'failed' }]
            : ending === 'timeout' || ending === 'exit'
              ? []
              : [{ commandId: binding.commandId, state: 'completed', outcome: 'completed' }],
        events: [],
        cursor: 0,
        hasMore: false,
      };
    },
  },
});
mock.module('../runners/native/worker-recovery.js', {
  namedExports: {
    resumeNativeWorker: async (
      runId: string,
      options: { contextId: string; commandId?: string; text: string },
    ) => {
      assert.ok(options.commandId, 'completion must reserve a stable command before recovery');
      const context = getRun(runId)!.agentContexts!.find(
        (entry) => entry.id === options.contextId,
      )!;
      assert.equal(context.nativeCommandId, options.commandId);
      assert.equal(context.nativeCommandText, options.text);
      if (deferredClock) {
        deferredClock.now += 600001;
        if (++deferredClock.polls > 2)
          throw new Error('Deferred completion bypassed the inactivity watchdog');
        return;
      }
      completionCommands.push(options.commandId);
      if (loseCompletionReply) {
        loseCompletionReply = false;
        await upsertAgentContext(runId, 'review', {
          id: context.id,
          nativeSession: {
            ...context.nativeSession!,
            recovery: {
              fromGeneration: context.nativeSession!.generation!,
              commandId: options.commandId,
              text: options.text,
            },
          },
        });
        throw new NativeWorkerOperationUncertainError(
          'delivery',
          'completion reply lost',
          undefined,
        );
      }
      await upsertAgentContext(runId, 'review', {
        id: context.id,
        nativeSession: {
          ...context.nativeSession!,
          commandId: options.commandId,
          generation: 'continued-generation',
          recovery: undefined,
          ...(ending === 'completion-closed-restart' ? { closedAt: new Date().toISOString() } : {}),
        },
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
mock.module('../tasks/watcher.js', { namedExports: { unwatchContext: noop } });
mock.module('./feedback.js', {
  namedExports: {
    readReviewFeedback: async () =>
      ['completion-invalid', 'completion-invalid-idle'].includes(ending)
        ? {
            verdict: 'issues',
            issues: [],
            incomplete: true,
            terminalInvalidReason: 'invalid scoped review result',
          }
        : ending === 'incomplete'
          ? { verdict: 'pass', issues: [], incomplete: true }
          : { verdict: 'issues', issues: [{ file: 'a.ts', description: 'finding' }] },
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
        headSha: 'a'.repeat(40),
        diffPath: 'artifacts/review.diff',
        capturedAt: new Date().toISOString(),
      },
      artifactPaths: [],
    }),
    removeSlotFiles: noop,
    readPersistedReviewSnapshot: async () => ({
      snapshot: {
        source: 'local-git',
        baseSha: 'b'.repeat(40),
        headSha: 'a'.repeat(40),
        diffPath: 'artifacts/review.diff',
        capturedAt: new Date().toISOString(),
      },
      artifactPaths: [],
    }),
  },
});
mock.module('./templates.js', {
  namedExports: { expandReviewTemplate: async () => '# Review\n' },
});

const { runNativeReviewAgent } = await import('./native-review-agent.js');
const { runReviewRoundBudget } = await import('./review-round-budget.js');

async function nativeRun(t: TestContext) {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'dev',
      project: 'native-review-settlement',
      ticketOrPr: `SETTLE-${ending}`,
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

const review = (runId: string) =>
  runNativeReviewAgent({
    vars,
    runner: 'claude',
    model: 'opus',
    taskDir: 'tasks/review',
    runId,
    reviewTimeoutMs: ['timeout', 'completion-invalid-idle', 'completion-interrupted'].includes(
      ending,
    )
      ? 0
      : timeline
        ? (ending === 'inactive' ? 60 : 30) * 60_000
        : 60_000,
    loopNumber: 1,
    validationDepth: 'static-code',
    mode: 'cold',
    reviewId: `pipeline-review-${runId}`,
  });

test('a failed native turn with valid findings receives one completion turn in the same admission', async (t) => {
  ending = 'completion-turn';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  const result = await review(run.id);
  assert.equal(result.verdict, 'issues');
  assert.equal(completionCommands.length, 1);
  const context = getRun(run.id)!.agentContexts!.find((entry) => entry.role === 'review')!;
  assert.equal(context.runnerSessionId, 'saved-review-conversation');
  assert.equal(context.nativeSession?.sessionId, binding.sessionId);
  assert.equal(context.nativeSession?.leaseId, binding.leaseId);
  assert.equal(context.nativeSession?.commandId, completionCommands[0]);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
});

test('an unfinished completion turn fails instead of allocating another turn', async (t) => {
  ending = 'completion-unfinished';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /completion turn.*terminal signal/);
  assert.equal(completionCommands.length, 1);
});

for (const progress of ['checklist-progress', 'tool-progress', 'paged-tools'] as const) {
  test(`a native reviewer with ${progress} survives its configured total-time boundary`, async (t) => {
    ending = progress;
    const clock = { now: 0, polls: 0 };
    timeline = clock;
    readCursors.length = 0;
    t.mock.method(Date, 'now', () => clock.now);
    t.after(() => {
      timeline = undefined;
    });
    const run = await nativeRun(t);
    const result = await review(run.id);
    assert.equal(result.verdict, 'issues');
    assert.equal(clock.polls >= 4, true);
    assert.deepEqual(readCursors.slice(0, 4), [undefined, 1, 2, 3]);
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.equal(budget.used, 1);
  });
}

test('a clean idle native turn also finishes its missing signal in the same conversation', async (t) => {
  ending = 'completion-live';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  assert.equal((await review(run.id)).verdict, 'issues');
  assert.equal(completionCommands.length, 1);
});

test('restart after an uncertain completion reply reuses its reserved command and admission', async (t) => {
  ending = 'completion-restart';
  completionCommands.length = 0;
  completionLaunches = 0;
  loseCompletionReply = true;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /completion reply lost/);
  const context = getRun(run.id)!.agentContexts!.find((entry) => entry.role === 'review')!;
  assert.equal(context.status, 'waiting');
  assert.ok(context.nativeCommandId);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
  assert.equal((await review(run.id)).verdict, 'issues');
  assert.equal(completionLaunches, 1);
  assert.deepEqual(completionCommands, [context.nativeCommandId, context.nativeCommandId]);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
});

test('invalid scoped result never gets an automatic completion turn', async (t) => {
  ending = 'completion-invalid';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /stopped without a valid terminal signal/);
  assert.equal(completionCommands.length, 0);
  assert.equal(
    getRun(run.id)!.agentContexts?.find((entry) => entry.role === 'review')?.status,
    'failed',
  );
});

test('an idle native turn with invalid artifacts retains its normal inactivity failure', async (t) => {
  ending = 'completion-invalid-idle';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /no checklist or tool progress/);
  assert.equal(completionCommands.length, 0);
});

test('deferred completion delivery still reaches the inactivity watchdog', async (t) => {
  ending = 'completion-deferred';
  const clock = { now: Date.now(), polls: 0 };
  deferredClock = clock;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => {
    deferredClock = undefined;
  });
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /no checklist or tool progress/);
  assert.equal(clock.polls, 1);
});

test('an interrupted completion fails with its terminal-signal reason', async (t) => {
  ending = 'completion-interrupted';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /completion turn.*terminal signal/);
  assert.equal(completionCommands.length, 1);
});

test('restart settles a stopped unfinished completion without redispatching its closed lease', async (t) => {
  ending = 'completion-closed-restart';
  completionCommands.length = 0;
  completionLaunches = 0;
  loseCompletionReply = true;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /completion reply lost/);
  await assert.rejects(review(run.id), /completion turn.*terminal signal/);
  assert.equal(completionLaunches, 1);
  assert.equal(completionCommands.length, 2);
  assert.equal(completionCommands[0], completionCommands[1]);
});

test('restart recovery enforces the completion inactivity limit and drains fresh tool activity', async (t) => {
  ending = 'completion-turn';
  completionCommands.length = 0;
  const run = await nativeRun(t);
  await review(run.id);
  const context = getRun(run.id)!.agentContexts!.find((entry) => entry.role === 'review')!;
  const acceptedAt = Date.parse(context.nativeSession!.acceptedAt!);
  const now = acceptedAt + 600001;
  t.mock.method(Date, 'now', () => now);
  ending = 'completion-unfinished';
  const control = await import('../runners/native/worker-control.js');
  const monitor = await import('../run-engine/run-monitor.js');
  const { continueNativeReviewCompletion } = await import('./native-review-completion.js');
  const read = await control.readNativeWorkerSnapshot(run.id, 'review', context.id);
  const snapshot = {
    ...read,
    commands: read.commands.map((command) => ({
      ...command,
      state: 'accepted' as const,
      outcome: undefined,
    })),
  };
  const probe = await monitor.probeWorkerSignalForRun(run.id, vars.slotId, context);
  const input = {
    runId: run.id,
    vars,
    context,
    snapshot,
    probe,
    assertCurrent: () => {},
    enforceProgressTimeout: true,
  };
  await assert.rejects(continueNativeReviewCompletion(input), /inactivity limit/);
  const event: NativeSessionEvent = {
    sessionId: context.nativeSession!.sessionId,
    generation: context.nativeSession!.generation!,
    commandId: context.nativeCommandId!,
    sequence: 1,
    at: new Date(now).toISOString(),
    type: 'tool.completed',
  };
  completionActivityPages = [[event]];
  t.after(() => {
    completionActivityPages = undefined;
  });
  assert.equal(
    await continueNativeReviewCompletion({
      ...input,
      snapshot: { ...snapshot, cursor: 0, hasMore: true },
    }),
    false,
  );
  assert.equal(completionCommands.length, 1);
});

test('a native reviewer with no checklist or tool progress fails at ten idle minutes, before a one-hour budget', async (t) => {
  ending = 'inactive';
  const clock = { now: 0, polls: 0 };
  timeline = clock;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => {
    timeline = undefined;
  });
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /no checklist or tool progress for 600000ms/);
  assert.equal(clock.polls, 1);
});

test('the native review inactivity window uses its project override', async (t) => {
  ending = 'inactive';
  configuredInactivityMinutes = 5;
  const clock = { now: 0, polls: 0, stepMs: 5 * 60_000 };
  timeline = clock;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => {
    timeline = undefined;
    configuredInactivityMinutes = undefined;
  });
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /no checklist or tool progress for 300000ms/);
  assert.equal(clock.polls, 1);
});

test('a previous native command cannot keep the current reviewer alive', async (t) => {
  ending = 'foreign-tools';
  const clock = { now: 0, polls: 0 };
  timeline = clock;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => {
    timeline = undefined;
  });
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /no checklist or tool progress for 600000ms/);
  assert.equal(clock.polls, 1);
});

test('re-reading old checklist marks and fresh signal heartbeats does not count as progress', async (t) => {
  ending = 'stale-checklist';
  const clock = { now: 0, polls: 0 };
  timeline = clock;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => {
    timeline = undefined;
  });
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /no checklist or tool progress for 600000ms/);
  assert.equal(clock.polls, 1);
});

test('a recovered native command gets its startup grace from its verified acceptance', async (t) => {
  ending = 'accepted-start';
  const clock = { now: 2 * 60 * 60_000, polls: 0, stepMs: 60_000 };
  timeline = clock;
  t.mock.method(Date, 'now', () => clock.now);
  t.after(() => {
    timeline = undefined;
  });
  const run = await nativeRun(t);
  const result = await review(run.id);
  assert.equal(result.verdict, 'issues');
});

for (const [end, reason] of [
  ['timeout', /no checklist or tool progress/],
  ['exit', /reviewer process exited/],
] as const) {
  test(`a reviewer ${end} settles its admitted round no-verdict`, async (t) => {
    ending = end;
    const run = await nativeRun(t);
    await assert.rejects(review(run.id));
    const settled = Object.values(getRun(run.id)!.reviewRoundSettlements ?? {});
    assert.equal(settled.length, 1);
    assert.match(settled[0]!.reason, reason);
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.deepEqual([budget.used, budget.noVerdict], [0, 1]);
  });
}

test('a reviewer that leaves no feedback file settles no-verdict; a verdict counts', async (t) => {
  ending = 'incomplete';
  const incomplete = await nativeRun(t);
  assert.equal((await review(incomplete.id)).incomplete, true);
  assert.deepEqual(
    Object.values(getRun(incomplete.id)!.reviewRoundSettlements ?? {}).map((entry) => entry.reason),
    ['no-feedback-file'],
  );

  ending = 'verdict';
  const reviewed = await nativeRun(t);
  assert.equal((await review(reviewed.id)).verdict, 'issues');
  assert.equal(getRun(reviewed.id)!.reviewRoundSettlements, undefined);
  const budget = await runReviewRoundBudget(getRun(reviewed.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [1, 0]);
});

test('a slot reviewer is told to keep probe tests and scratch out of the checkout', async (t) => {
  // A gate reviewer's probe tests in the task's artifacts broke the product's unit run.
  ending = 'verdict';
  const run = await nativeRun(t);
  await review(run.id);
  const reviewer = getRun(run.id)!.agentContexts!.find((context) => context.role === 'review')!;
  const contract = slotFiles.get(reviewer.taskFile!) ?? '';
  assert.match(contract, /^## Reviewer-specific execution contract/);
  assert.ok(contract.includes(`\${TMPDIR:-/tmp}/farmslot-review/${reviewer.id}`));
  assert.match(contract, /write nothing in the checkout/);
  assert.match(contract, /delete it before you write your result/);
  assert.match(contract, /reviewer_recipe_replay\(\)/);
  assert.match(contract, /env -u RECIPE_TASK_DIR -u FARMSLOT_TASK_DIR/);
});

for (const [end, uncertainty] of [
  ['uncertain-launch', NativeWorkerOperationUncertainError],
  ['uncertain-delivery', PromptDeliveryUncertainError],
] as const) {
  test(`an ${end.replace('-', ' ')} leaves its round counted while the reviewer may run`, async (t) => {
    ending = end;
    const run = await nativeRun(t);
    await assert.rejects(review(run.id), uncertainty);
    assert.equal(getRun(run.id)!.reviewRoundSettlements, undefined);
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.deepEqual([budget.used, budget.noVerdict], [1, 0]);
  });
}

// TAT-4006 run 7721a02b, 10-20: its reviewer completed at 03:15Z and its
// process, with seven MCP servers, was still alive at 08:20Z.
test('a settled reviewer stops its process and keeps its resumable identity', async (t) => {
  for (const end of ['verdict', 'incomplete'] as const) {
    ending = end;
    stopped.length = 0;
    const run = await nativeRun(t);
    await review(run.id);
    const reviewer = getRun(run.id)!.agentContexts!.find((context) => context.role === 'review')!;
    assert.deepEqual(stopped, [reviewer.id], `${end}: the reviewer process is stopped once`);
    assert.equal(reviewer.nativeSession?.sessionId, binding.sessionId);
    assert.equal(reviewer.nativeSession?.releasedAt, undefined, `${end}: identity kept for WARM`);
  }

  // The verdict is already recorded, so an unconfirmed stop does not fail the review.
  ending = 'verdict';
  stopFails = true;
  t.after(() => {
    stopFails = false;
  });
  const run = await nativeRun(t);
  assert.equal((await review(run.id)).verdict, 'issues');
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [1, 0]);
});

// TAT-4158 4237202e: the failed schema-bound turn left its runner and MCP children alive.
test('a failed native command stops its still-live process before returning no verdict', async (t) => {
  ending = 'command-failed';
  stopped.length = 0;
  const run = await nativeRun(t);
  await assert.rejects(review(run.id));
  const reviewer = getRun(run.id)!.agentContexts!.find((context) => context.role === 'review')!;
  assert.deepEqual(stopped, [reviewer.id]);
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.equal(budget.used, 0, 'a runner failure produces no review round');
});

test('an unconfirmed failed-command stop keeps the round reserved until cleanup is confirmed', async (t) => {
  ending = 'command-failed';
  stopFails = true;
  t.after(() => {
    stopFails = false;
  });
  const run = await nativeRun(t);
  await assert.rejects(review(run.id), /process cleanup is unconfirmed/);
  assert.equal(getRun(run.id)!.reviewRoundSettlements, undefined);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
});
