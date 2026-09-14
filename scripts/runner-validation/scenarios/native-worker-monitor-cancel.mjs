import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

/** A late native liveness reply cannot resurrect a cancelled run as an operator gate. */
export async function verifyCancelledMonitorLateRead({ runId, binding, slotId, timeoutMs }) {
  const fault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
  const stateRoot = process.env.FARMSLOT_NATIVE_STATE_DIR;
  for (const file of [fault, stateRoot])
    assert.ok(
      file && path.resolve(file).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
  assert.equal(fs.existsSync(fault), false);
  const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(pids.length, 1);
  assert.ok(fs.existsSync(`${fault}.${pids[0]}.loaded`));
  const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
  const client = new NativeSessionClient(stateRoot, binding.executionNodeId);
  await client.closeWorker(binding.ownerPrincipalId, {
    sessionId: binding.sessionId,
    generation: binding.generation,
    leaseId: binding.leaseId,
  });
  fs.writeFileSync(
    fault,
    JSON.stringify({ gatewayPid: pids[0], sessionId: binding.sessionId, method: 'read', limit: 1 }),
    { mode: 0o600 },
  );
  try {
    await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 20000));
    const held = JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8'));
    assert.equal(held.state, 'closed');
    assert.equal(held.processStopped, true);
    assert.equal(rpc('run.get', { runId }).run.status, 'monitoring');
    const cancelled = rpc('run.cancel', {
      runId,
      reason: 'Cancel while native monitor liveness reply is held',
    });
    assert.equal(cancelled.run.status, 'cancelled');
    assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    await wait(() => fs.existsSync(`${fault}.released`), Boolean, 10000);
    // The production monitor retries stopped-worker liveness for ten seconds.
    // Observe beyond that window so a delayed handoff allocation must have run.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const run = rpc('run.get', { runId }).run;
      assert.equal(run.status, 'cancelled', 'Late monitor resurrected a cancelled run');
      assert.equal(
        run.decisions.some(
          (decision) => !decision.resolvedAt && decision.type === 'monitor_interactive_handoff',
        ),
        false,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId).currentRunId,
      null,
    );
  } finally {
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
  }
}
