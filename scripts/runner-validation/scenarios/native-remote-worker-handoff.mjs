import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export async function verifyRemoteWorkerHandoff({
  runId,
  context,
  binding,
  slot,
  token,
  markCommand,
  timeoutMs,
  stopped,
  recordChild,
}) {
  const target = { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
  const worker = {
    runId,
    contextId: context.id,
    generation: binding.generation,
    leaseId: binding.leaseId,
  };
  const sourcePin = () => pinnedWorkerTarget(runId, context.id, binding.leaseId);
  let before = rpc('native.session.read', sourcePin());
  if (stopped) {
    rpc('native.session.close', { ...target, worker });
    before = rpc('native.session.read', sourcePin());
    assert.equal(before.session.processStopped, true);
  }
  const marker = `native-remote-handoff-${randomUUID()}.txt`;
  const ticket = `NATIVE-REMOTE-HANDOFF-${Date.now()}`;
  const taskFile = path.join(ROOT, 'projects', slot.project, 'tasks/dev', ticket, 'TASK.md');
  await writeNativeFixtureTask(
    taskFile,
    `# Worker: dev\n\nWrite ${marker} with exactly the token from the previous task, using conversation memory. Do not read prior tasks or marker files. End the turn without a terminal signal. Do not commit or contact services.\n`,
    slot.project,
    { markCommand },
  );
  const parent = rpc('run.get', { runId }).run;
  const child = rpc('run.createNative', {
    flowType: 'dev',
    project: slot.project,
    ticketOrPr: ticket,
    taskFile,
    slotId: slot.slot,
    allowedSlots: [slot.slot],
    parentRunId: runId,
    familyId: parent.familyId,
    runner: context.runner,
    ...(context.model ? { model: context.model } : {}),
    mode: 'interactive',
    skipPrepare: true,
    safetyTier: 'full-auto',
    engineState: { flags: { warmSessionReuse: true } },
  }).run;
  recordChild(child.id);
  const successor = await wait(
    () => rpc('run.get', { runId: child.id }).run,
    (current) => {
      assert.ok(!['failed', 'cancelled', 'blocked'].includes(current.status), current.error);
      return current.status === 'monitoring';
    },
    timeoutMs,
  );
  const nextContext = successor.agentContexts.find(
    (candidate) => candidate.nativeSession?.handoffFrom?.runId === runId,
  );
  const next = nextContext?.nativeSession;
  assert.ok(next?.handoffCompletedAt);
  assert.equal(next.sessionId, binding.sessionId);
  assert.equal(next.executionNodeId, binding.executionNodeId);
  assert.deepEqual(next.profile, binding.profile);
  assert.notEqual(next.leaseId, binding.leaseId);
  assert.notEqual(next.commandId, binding.commandId);
  const successorPin = () => pinnedWorkerTarget(child.id, nextContext.id, next.leaseId);
  const after = await wait(
    () => rpc('native.session.read', successorPin()),
    (snapshot) => {
      const command = snapshot.commands.find((entry) => entry.commandId === next.commandId);
      assert.notEqual(command?.state, 'failed');
      return snapshot.session.state === 'idle' && command?.outcome === 'completed';
    },
    timeoutMs,
  );
  assert.equal(after.session.nativeSessionId, before.session.nativeSessionId);
  assert.equal(after.session.profileId, before.session.profileId);
  assert.equal(after.session.accountContextId, before.session.accountContextId);
  assert.equal(after.commands.length, 1);
  assert.equal(after.commands[0].commandId, next.commandId);
  assert.equal(after.scope.startAfter, before.scope.endAt);
  const history = rpc('native.session.read', sourcePin());
  assert.equal(history.scope.released, true);
  assert.equal(history.scope.endAt, before.scope.endAt);
  assert.deepEqual(history.commands, before.commands);
  assert.deepEqual(history.pendingRequests, []);
  assert.equal(after.session.workerLeaseId, next.leaseId);
  if (stopped) {
    assert.notEqual(after.session.generation, before.session.generation);
    assert.notEqual(after.session.processPid, before.session.processPid);
  } else {
    assert.equal(after.session.generation, before.session.generation);
    assert.equal(after.session.processPid, before.session.processPid);
  }
  assert.equal(
    rpc('native.session.workspace.read', { ...successorPin(), path: marker }).content.trim(),
    token,
  );
  for (const staleWorker of [
    worker,
    { ...worker, generation: next.generation, leaseId: next.leaseId },
  ])
    assert.throws(
      () =>
        rpc('native.session.send', {
          ...target,
          worker: staleWorker,
          commandId: randomUUID(),
          text: 'Retired task must not receive input.',
        }),
      /closed, transferred or stale/,
    );
  const retired = rpc('run.get', { runId }).run;
  assert.equal(retired.status, 'cancelled');
  assert.ok(
    retired.agentContexts.find((candidate) => candidate.id === context.id)?.nativeSession
      ?.releasedAt,
  );
  assert.equal(
    rpc('fleet.status').fleet.slots.find((candidate) => candidate.slot === slot.slot).currentRunId,
    child.id,
  );
  return { runId: child.id, contextId: nextContext.id, leaseId: next.leaseId };
}
