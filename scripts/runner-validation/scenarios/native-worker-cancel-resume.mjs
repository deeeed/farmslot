import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

/** Delay the real RESUME request beyond its client's failure, then cancel before delivery. */
export async function verifyCancelledDeferredResume({
  runId,
  context,
  binding,
  slotId,
  timeoutMs,
  duringProbe = false,
  raceApplied = false,
}) {
  const fault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
  const stateRoot = process.env.FARMSLOT_NATIVE_STATE_DIR;
  for (const file of [fault, stateRoot])
    assert.ok(
      file && path.resolve(file).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
  assert.equal(fs.existsSync(fault), false, 'Use a fresh deferred resume fixture');
  const gatewayPids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(gatewayPids.length, 1);
  const gatewayPid = gatewayPids[0];
  assert.ok(fs.existsSync(`${fault}.${gatewayPid}.loaded`));
  const target = { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
  const worker = {
    runId,
    contextId: context.id,
    generation: binding.generation,
    leaseId: binding.leaseId,
  };
  const read = () =>
    rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
  rpc('run.pause', { runId });
  if (raceApplied) {
    const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
    const client = new NativeSessionClient(stateRoot, binding.executionNodeId);
    await client.closeWorker(binding.ownerPrincipalId, {
      ...target,
      generation: binding.generation,
      leaseId: binding.leaseId,
    });
    assert.equal(
      fs.existsSync(
        path.join(stateRoot, 'sessions/cancelled-workers', `${binding.sessionId}.json`),
      ),
      false,
      'Use a source stopped without a cancellation marker',
    );
  } else rpc('native.session.close', { ...target, worker });
  const before = read();
  assert.equal(before.session.processStopped, true);
  fs.writeFileSync(
    fault,
    JSON.stringify({
      gatewayPid,
      sessionId: binding.sessionId,
      mode: duringProbe ? 'probe-request' : 'defer-request',
      cancelAfterResume: raceApplied,
      ...(duringProbe
        ? { hostPid: before.session.hostPid, executable: before.session.executable }
        : {}),
    }),
    { mode: 0o600 },
  );
  try {
    assert.throws(() => rpc('run.resume', { runId }), /Private validation deferred native request/);
    const held = JSON.parse(fs.readFileSync(`${fault}.held`, 'utf8'));
    if (duringProbe)
      assert.equal(
        JSON.parse(fs.readFileSync(`${fault}.probe`, 'utf8')).hostPid,
        before.session.hostPid,
      );
    const intent = rpc('run.get', { runId }).run.agentContexts.find(
      (entry) => entry.id === context.id,
    ).nativeSession;
    assert.equal(intent.generation, before.session.generation);
    assert.equal(intent.recovery.commandId, held.commandId);
    assert.ok(intent.recovery.requestedAt);
    assert.equal(read().session.generation, before.session.generation);
    const cancelled = rpc('run.cancel', {
      runId,
      reason: 'Cancel before deferred native resume arrives',
    });
    assert.equal(cancelled.run.status, 'cancelled');
    assert.ok(
      cancelled.effects.every((effect) => effect.status !== 'failed'),
      JSON.stringify(cancelled.effects),
    );
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 60000));
    const reply = JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8'));
    assert.equal(
      reply.transportError,
      undefined,
      'A transport failure does not prove the host refused the delayed operation',
    );
    if (raceApplied) {
      assert.equal(reply.error, undefined);
      assert.notEqual(reply.generation, before.session.generation);
      assert.equal(
        JSON.parse(fs.readFileSync(`${fault}.cancel-held`, 'utf8')).generation,
        before.session.generation,
      );
    }
    const after = read();
    if (raceApplied) {
      assert.equal(after.session.generation, reply.generation);
      const updated = rpc('run.get', { runId }).run.agentContexts.find(
        (entry) => entry.id === context.id,
      ).nativeSession;
      assert.equal(updated.generation, reply.generation);
      assert.equal(updated.recovery, undefined);
      assert.ok(updated.closedAt);
    } else {
      assert.equal(
        after.session.generation,
        before.session.generation,
        'Cancelled resume launched another process generation',
      );
      assert.equal(after.session.processPid, before.session.processPid);
      assert.match(reply.error, /recovery operation was cancelled/);
    }
    assert.equal(after.session.processStopped, true);
    assert.deepEqual(after.commands, before.commands);
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
      null,
    );
  } finally {
    // Negative source mutations can allow the late process to launch after the run
    // is already cancelled. Stop only this exact private lease through the host API.
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    if (fs.existsSync(`${fault}.held`))
      await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 60000));
    const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
    const client = new NativeSessionClient(stateRoot, binding.executionNodeId);
    const snapshot = await client.read(binding.ownerPrincipalId, binding.sessionId);
    assert.equal(snapshot.session.workerLeaseId, binding.leaseId);
    if (snapshot.session.processPid && !snapshot.session.processStopped) {
      const result = await client.cancelWorker(binding.ownerPrincipalId, {
        ...target,
        generation: snapshot.session.generation,
        leaseId: binding.leaseId,
      });
      assert.equal(
        result.session?.processStopped,
        true,
        'Deferred resume fixture cleanup did not stop the process',
      );
    }
    const run = rpc('run.get', { runId }).run;
    const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
    if (run.status === 'cancelled' && slot.currentRunId === runId)
      rpc('slot.release', { slotId, keepWork: true });
  }
}
