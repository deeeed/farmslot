import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

function request(method, params) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      {
        cwd: ROOT,
        env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '45000' },
        timeout: 50000,
      },
      (error, stdout, stderr) => {
        if (error) resolve({ error: String(stderr || error.message) });
        else {
          try {
            resolve({ value: JSON.parse(stdout) });
          } catch (error) {
            resolve({ error: error.message });
          }
        }
      },
    );
  });
}

/** Close must finish against its pinned generation before a queued Resume replaces it. */
export async function verifyNativeCloseResumeOrder({ runId, context, binding, timeoutMs }) {
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
  const gatewayPid = pids[0];
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
  const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
  const client = new NativeSessionClient(stateRoot, binding.executionNodeId);
  await client.closeWorker(binding.ownerPrincipalId, {
    ...target,
    generation: binding.generation,
    leaseId: binding.leaseId,
  });
  const before = read();
  fs.writeFileSync(
    fault,
    JSON.stringify({
      gatewayPid,
      sessionId: binding.sessionId,
      runId,
      method: 'native.worker.cancel',
      serializeClose: true,
    }),
    { mode: 0o600 },
  );
  const closing = request('native.session.close', { ...target, worker });
  let resuming;
  try {
    await wait(() => fs.existsSync(`${fault}.applied`), Boolean, 15000);
    assert.equal(JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8')).error, undefined);
    resuming = request('run.resume', { runId });
    await wait(() => fs.existsSync(`${fault}.resume-arrived`), Boolean, 15000);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      assert.equal(
        read().session.generation,
        before.session.generation,
        'Resume replaced the process while public close still owned its transition',
      );
      const current = rpc('run.get', { runId }).run.agentContexts.find(
        (entry) => entry.id === context.id,
      ).nativeSession;
      assert.equal(
        current.recovery,
        undefined,
        'Resume entered while public close was still pending',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    const closed = await closing;
    assert.equal(closed.error, undefined, closed.error);
    assert.equal(closed.value.closed, true);
    assert.equal(closed.value.session.generation, before.session.generation);
    assert.equal(closed.value.session.processStopped, true);
    const resumed = await resuming;
    assert.equal(resumed.error, undefined, resumed.error);
    assert.equal(resumed.value.run.status, 'monitoring');
    const after = await wait(
      read,
      (snapshot) =>
        snapshot.commands.length === before.commands.length + 1 &&
        snapshot.commands.at(-1)?.outcome === 'completed' &&
        snapshot.session.state === 'idle',
      timeoutMs,
    );
    assert.notEqual(after.session.generation, before.session.generation);
    assert.equal(after.session.nativeSessionId, before.session.nativeSessionId);
  } finally {
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    await Promise.all([closing, ...(resuming ? [resuming] : [])]);
  }
}
