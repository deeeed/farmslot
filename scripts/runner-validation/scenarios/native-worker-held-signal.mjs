import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fixtureChecklistPath } from '../lib/native-task.mjs';

import { recoverHeldContinuation } from './native-worker-held-recovery.mjs';
import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

/** A real worker terminal signal pauses an interactive run while its process stays alive. */
export async function verifyHeldNativeWorkerResume({
  runId,
  context,
  binding,
  cwd,
  timeoutMs,
  recoveryTest,
}) {
  const target = { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
  const read = () =>
    rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
  const worker = {
    runId,
    contextId: context.id,
    generation: binding.generation,
    leaseId: binding.leaseId,
  };
  const signal = () => JSON.parse(fs.readFileSync(path.join(cwd, context.signalFile), 'utf8'));
  const checklist = fixtureChecklistPath(cwd, context.taskFile);
  const beforeChecklist = fs.readFileSync(checklist, 'utf8');
  const marker = `native-held-resume-${randomUUID()}.txt`;
  const token = randomUUID();
  const commandId = randomUUID();
  rpc('native.session.send', {
    ...target,
    worker,
    commandId,
    text:
      `Run ${path.posix.join(path.posix.dirname(context.taskFile), 'mark')} blocked --reason "Waiting for operator continuation fixture", then end this turn. ` +
      `Only when the operator later asks you to continue, start a fresh signal attempt with mark start, write ${marker} containing exactly ${token}, and end that turn without a terminal signal. Preserve completed checklist boxes.`,
  });
  const held = await wait(
    () => rpc('run.get', { runId }).run,
    (run) => run.status === 'paused',
    timeoutMs,
  );
  assert.equal(
    held.steps.find((step) => step.name === 'monitor').outputs.workerTerminalSignalHeld,
    'blocked',
  );
  const before = await wait(
    read,
    (snapshot) =>
      snapshot.session.state === 'idle' &&
      snapshot.commands.find((entry) => entry.commandId === commandId)?.outcome === 'completed',
    timeoutMs,
  );
  assert.equal(before.session.processStopped, false);
  const oldAttempt = signal().attemptId;
  assert.equal(signal().status, 'blocked');
  let after;
  if (recoveryTest)
    after = await recoverHeldContinuation({
      runId,
      context,
      binding,
      worker,
      before,
      read,
      timeoutMs,
      recoveryTest,
    });
  else {
    rpc('run.resume', { runId });
    assert.equal(
      read().commands.length,
      before.commands.length + 1,
      'Resume did not deliver a continuation to the live paused worker',
    );
    after = await wait(
      read,
      (snapshot) =>
        snapshot.session.state === 'idle' && snapshot.commands.at(-1)?.outcome === 'completed',
      timeoutMs,
    );
    assert.equal(after.session.processPid, before.session.processPid);
    assert.equal(after.session.generation, before.session.generation);
  }
  assert.equal(after.session.nativeSessionId, before.session.nativeSessionId);
  assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), token);
  assert.notEqual(signal().attemptId, oldAttempt);
  assert.equal(signal().status, 'running');
  assert.equal(fs.readFileSync(checklist, 'utf8'), beforeChecklist);
  const firstPoll = rpc('run.get', { runId }).run.monitorState?.lastPollAt;
  await wait(
    () => rpc('run.get', { runId }).run,
    (run) => {
      assert.equal(
        run.status,
        'monitoring',
        'Resumed monitor consumed the previous terminal signal',
      );
      return run.monitorState?.lastPollAt !== firstPoll;
    },
    timeoutMs,
  );
}
