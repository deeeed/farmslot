import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

/** Exercise the remote generation-changed reply through the production node route. */
export async function verifyRemoteWorkerCancellationRace({
  runId,
  context,
  binding,
  slotId,
  timeoutMs,
  onRemote,
  remoteRoot = '/Users/deeeed/dev/farmslot-worktrees/native-node-validation',
}) {
  assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
  assert.equal(binding.executionNodeId, 'native-macpro-validation');
  assert.equal(slotId, 'native-worker-remote');
  const fault = process.env.FARMSLOT_NATIVE_REMOTE_RESUME_RACE_FAULT;
  assert.ok(
    fault && path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
  );
  assert.equal(fs.existsSync(fault), false, 'Use a fresh remote resume race fixture');
  assert.equal(
    path.resolve(remoteRoot),
    '/Users/deeeed/dev/farmslot-worktrees/native-node-validation',
  );
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
  const read = () =>
    rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
  const artifact = (suffix) => JSON.parse(fs.readFileSync(`${fault}.${suffix}`, 'utf8'));
  const remote = async (operation) => {
    // Read the principal only inside its existing private remote journal. Evidence
    // and SSH arguments contain session/lease identity, never the owner or tokens.
    const result = await onRemote(`
      (async () => {
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        const { pathToFileURL } = require('node:url');
        const base = ${JSON.stringify(remoteRoot)};
        const node = ${JSON.stringify(binding.executionNodeId)};
        const id = ${JSON.stringify(binding.sessionId)};
        const leaseId = ${JSON.stringify(binding.leaseId)};
        const resumeCommandId = ${JSON.stringify(fs.existsSync(`${fault}.held`) ? artifact('held').commandId : undefined)};
        const root = base + '/native-state/nodes/' + node;
        const moduleRoot = base + '/node/node_modules/@farmslot/agent-runtime/dist/native/';
        const { NativeSessionClient } = await import(pathToFileURL(moduleRoot + 'index.js'));
        const journal = fs.readFileSync(root + '/sessions/' + id + '.journal', 'utf8');
        const info = journal.slice(0, journal.lastIndexOf('\\n')).split('\\n')
          .reverse().map(line => JSON.parse(line)).find(entry => entry.info).info;
        assert.equal(info.id, id);
        assert.equal(info.executionNodeId, node);
        assert.equal(info.workerLeaseId, leaseId);
        const host = JSON.parse(fs.readFileSync(root + '/host.json', 'utf8'));
        process.kill(host.pid, 0);
        assert.ok(fs.existsSync(root + '/ready.json') && fs.existsSync(host.socket));
        const client = new NativeSessionClient(root, node);
        const snapshot = await client.read(info.ownerPrincipalId, id);
        assert.equal(snapshot.session.workerLeaseId, leaseId);
        if (${JSON.stringify(operation)} === 'close') {
          assert.equal(snapshot.session.generation, ${JSON.stringify(binding.generation)});
          assert.equal(fs.existsSync(root + '/sessions/cancelled-workers/' + id + '.json'), false);
          await client.closeWorker(info.ownerPrincipalId, {
            sessionId: id, generation: snapshot.session.generation, leaseId,
          });
          assert.equal(fs.existsSync(root + '/sessions/cancelled-workers/' + id + '.json'), false);
        } else {
          assert.ok(resumeCommandId);
          for (let attempt = 0; attempt < 2; attempt++) {
            const current = await client.read(info.ownerPrincipalId, id);
            assert.equal(current.session.workerLeaseId, leaseId);
            const result = await client.cancelWorker(info.ownerPrincipalId, {
              sessionId: id, generation: current.session.generation, leaseId, resumeCommandId,
            });
            if (result.cancelled) break;
            assert.equal(result.reason, 'generation-changed');
            assert.ok(attempt === 0, 'Remote cleanup generation did not settle');
          }
        }
        const after = (await client.read(info.ownerPrincipalId, id)).session;
        let alive = false;
        if (after.processPid) {
          try { process.kill(after.processPid, 0); alive = true; }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        console.log(JSON.stringify({ generation: after.generation,
          processStopped: after.processStopped, alive }));
      })().catch(() => { process.stderr.write('Private remote native race operation failed\\n'); process.exitCode = 1; });
    `);
    assert.equal(result.processStopped, true);
    assert.equal(result.alive, false);
    return result;
  };
  let before;
  try {
    rpc('run.pause', { runId });
    await remote('close');
    before = read();
    assert.equal(before.session.processStopped, true);
    assert.equal(before.session.generation, binding.generation);
    fs.writeFileSync(fault, JSON.stringify({ gatewayPid, gatewayPort: 18777, ...target }), {
      mode: 0o600,
    });
    assert.throws(
      () => rpc('run.resume', { runId }),
      /Private validation deferred remote native request/,
    );
    const held = artifact('held');
    const intent = rpc('run.get', { runId }).run.agentContexts.find(
      (entry) => entry.id === context.id,
    ).nativeSession;
    assert.equal(intent.generation, before.session.generation);
    assert.equal(intent.recovery.commandId, held.commandId);
    assert.ok(intent.recovery.requestedAt);
    assert.equal(read().session.generation, before.session.generation);
    const cancelled = rpc('run.cancel', { runId, reason: 'Remote resume cancellation race proof' });
    assert.equal(cancelled.run.status, 'cancelled');
    assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
    await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 60000));
    const applied = artifact('applied');
    assert.equal(applied.transportError, undefined);
    assert.equal(applied.ok, true);
    assert.equal(applied.sessionId, target.sessionId);
    assert.notEqual(applied.generation, before.session.generation);
    assert.notEqual(applied.processPid, before.session.processPid);
    assert.equal(applied.processStopped, false);
    const oldCancel = artifact('cancel-held');
    assert.equal(oldCancel.generation, before.session.generation);
    assert.equal(oldCancel.resumeCommandId, held.commandId);
    const receipts = artifact('cancellations');
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].ok, true);
    assert.equal(receipts[0].cancelled, false);
    assert.equal(receipts[0].reason, 'generation-changed');
    assert.equal(receipts[0].requestedGeneration, before.session.generation);
    assert.equal(receipts[0].generation, applied.generation);
    assert.equal(receipts[1].ok, true);
    assert.equal(receipts[1].cancelled, true);
    assert.equal(receipts[1].requestedGeneration, applied.generation);
    assert.equal(receipts[1].processStopped, true);
    const after = read();
    assert.equal(after.session.generation, applied.generation);
    assert.equal(after.session.nativeSessionId, before.session.nativeSessionId);
    assert.equal(after.session.processStopped, true);
    assert.deepEqual(after.commands, before.commands);
    const updated = rpc('run.get', { runId }).run.agentContexts.find(
      (entry) => entry.id === context.id,
    ).nativeSession;
    assert.equal(updated.generation, applied.generation);
    assert.equal(updated.recovery, undefined);
    assert.ok(updated.closedAt);
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
      null,
    );
    await remote('cleanup');
    return { beforeGeneration: before.session.generation, generation: applied.generation };
  } finally {
    if (fs.existsSync(`${fault}.held`)) {
      fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
      await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 95000));
      // A negative route mutation can leave the successor alive after cancellation.
      await remote('cleanup');
    }
  }
}
