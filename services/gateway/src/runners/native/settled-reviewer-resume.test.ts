import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { NATIVE_WORKER_CANCEL } from '@farmslot/agent-runtime/native';
import { type AgentContext, Methods } from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { rewriteStatusFile } = await import('../../core/state.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { makeVars } = await import('../test-fixtures.js');
const node = await import('./node.js');
const owner = await import('../../security/native-worker-owner.js');

// The host is scripted. A stop is confirmed with the session closed and its process
// stopped; any other call is recorded and refused, so a resume shows where it got.
const routed: string[] = [];
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      _owner: string,
      method: string,
      params: { sessionId: string; leaseId: string; generation: string },
    ) => {
      routed.push(method);
      if (method === NATIVE_WORKER_CANCEL)
        return {
          cancelled: true,
          sessionId: params.sessionId,
          leaseId: params.leaseId,
          generation: params.generation,
          session: { state: 'closed', processStopped: true },
        };
      throw new Error('native host reached');
    },
  },
});
mock.module('../../security/native-worker-owner.js', {
  namedExports: { ...owner, assertNativeRunOwner: () => {} },
});

const { resumeNativeWorker } = await import('./worker-recovery.js');
const { cancelNativeWorkerContext } = await import('./worker.js');

const vars = makeVars();

/** A tmux (default-transport) run whose native reviewer was stopped and is being handed on. */
async function runWithStoppedContext(t: TestContext, role: AgentContext['role']) {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  });
  const run = createRun({
    flowType: 'dev',
    project: 'worker-recovery-transport',
    ticketOrPr: `TRANSPORT-${role}`,
    slotId: vars.slotId,
  });
  const context: AgentContext = {
    id: `${role}-context`,
    role,
    label: role,
    slotId: vars.slotId,
    runId: run.id,
    status: 'launching',
    runner: 'claude',
    model: 'opus',
    taskFile: 'tasks/review/TASK.md',
    runnerSessionId: '2014464c-5e8c-40c6-ab2a-59cc0cc9ecaa',
    nativeSession: {
      sessionId: 'reviewer-session',
      leaseId: 'successor-lease',
      commandId: 'review-command',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      generation: 'generation',
      launchDigest: 'digest',
      safetyTier: 'sandboxed',
      handoffFrom: { runId: 'settled-run', contextId: 'settled-reviewer', leaseId: 'source-lease' },
      handoffCompletedAt: new Date().toISOString(),
    },
  };
  updateRun(run.id, { status: 'reviewing', agentContexts: [context] });
  await rewriteStatusFile((current) => ({
    ...current,
    slots: [
      ...(current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId),
      { slot: vars.slotId, current_run_id: run.id },
    ],
  }));
  t.after(async () => {
    await rewriteStatusFile((current) => ({
      ...current,
      slots: (current?.slots ?? []).filter((entry) => entry.slot !== vars.slotId),
    }));
    const closedAt = new Date().toISOString();
    updateRun(run.id, {
      status: 'done',
      completedAt: closedAt,
      agentContexts: getRun(run.id)!.agentContexts?.map((entry) =>
        entry.nativeSession
          ? { ...entry, nativeSession: { ...entry.nativeSession, closedAt } }
          : entry,
      ),
    });
    await deleteRun(run.id);
  });
  return { run, context };
}

// #1387 stops a settled reviewer, so a WARM re-review on an ordinary tmux run now
// resumes it. Recovery used to admit a non-native run only for purpose 'review'.
test('a WARM handoff resumes a stopped reviewer on a tmux run; other workers stay refused', async (t) => {
  routed.length = 0;
  const reviewer = await runWithStoppedContext(t, 'review');
  assert.equal(getRun(reviewer.run.id)!.transport, undefined);
  await assert.rejects(
    resumeNativeWorker(reviewer.run.id, {
      purpose: 'handoff',
      contextId: reviewer.context.id,
      assertCurrent: () => {},
    }),
    /native host reached/,
  );
  assert.deepEqual(routed, [Methods.NATIVE_SESSION_READ]);

  routed.length = 0;
  const worker = await runWithStoppedContext(t, 'dev');
  await assert.rejects(
    resumeNativeWorker(worker.run.id, {
      purpose: 'handoff',
      contextId: worker.context.id,
      assertCurrent: () => {},
    }),
    /Native worker recovery requires a paused run with its owned slot/,
  );
  assert.deepEqual(routed, []);
});

// What the settled-reviewer stop leaves: a closed binding that WARM can still hand on.
test('stopping a settled reviewer keeps its session, lease and conversation', async (t) => {
  routed.length = 0;
  const { run, context } = await runWithStoppedContext(t, 'review');
  const settled = {
    ...context,
    status: 'complete' as const,
    nativeSession: {
      ...context.nativeSession!,
      handoffFrom: undefined,
      handoffCompletedAt: undefined,
      acceptedAt: new Date().toISOString(),
      launchRequestedAt: new Date().toISOString(),
    },
  };
  updateRun(run.id, { agentContexts: [settled] });
  await cancelNativeWorkerContext(run.id, settled);
  assert.deepEqual(routed, [NATIVE_WORKER_CANCEL]);
  const stopped = getRun(run.id)!.agentContexts![0]!;
  assert.equal(stopped.status, 'complete');
  assert.equal(stopped.runnerSessionId, settled.runnerSessionId);
  assert.ok(stopped.nativeSession?.closedAt, 'the process is recorded stopped');
  assert.equal(stopped.nativeSession?.releasedAt, undefined, 'the identity is not released');
  assert.equal(stopped.nativeSession?.sessionId, settled.nativeSession.sessionId);
  assert.equal(stopped.nativeSession?.leaseId, settled.nativeSession.leaseId);
});
