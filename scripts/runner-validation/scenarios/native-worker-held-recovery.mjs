import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

/** Reconcile an uncertain held-worker continuation across death or explicit close. */
export async function recoverHeldContinuation({
  runId,
  context,
  binding,
  worker,
  before,
  read,
  timeoutMs,
  recoveryTest,
}) {
  const fault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
  assert.ok(
    fault && path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
  );
  assert.equal(fs.existsSync(fault), false, 'Use a fresh held-continuation fault');
  const gatewayPids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(gatewayPids.length, 1);
  const gatewayPid = gatewayPids[0];
  assert.ok(fs.existsSync(`${fault}.${gatewayPid}.loaded`));
  const accepted = recoveryTest === 'after-send-death';
  const target = { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
  const currentBinding = () =>
    rpc('run.get', { runId }).run.agentContexts.find((entry) => entry.id === context.id)
      .nativeSession;
  fs.writeFileSync(
    fault,
    JSON.stringify({
      gatewayPid,
      sessionId: binding.sessionId,
      method: 'native.worker.send',
      mode: accepted ? 'fail-applied-reply' : 'defer-request',
    }),
    { mode: 0o600 },
  );
  try {
    assert.throws(() => rpc('run.resume', { runId }), /Private validation deferred native request/);
    const intent = currentBinding().recovery;
    assert.equal(intent.continueLive, true);
    if (accepted) {
      assert.equal(JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8')).accepted, true);
      await wait(
        read,
        (snapshot) =>
          snapshot.commands.find((command) => command.commandId === intent.commandId)?.outcome ===
            'completed' && snapshot.session.state === 'idle',
        timeoutMs,
      );
    } else
      assert.equal(
        read().commands.some((command) => command.commandId === intent.commandId),
        false,
      );
    if (recoveryTest === 'close-uncertain') {
      rpc('native.session.close', { ...target, worker });
      assert.equal(currentBinding().recovery, undefined);
      assert.equal(currentBinding().recoveryEpoch, (binding.recoveryEpoch ?? 0) + 1);
    } else {
      const live = read().session;
      assert.equal(live.generation, before.session.generation);
      assert.equal(live.cwd, before.session.cwd);
      assert.ok(live.cwd.startsWith(path.join(ROOT, 'temp/native-validation') + path.sep));
      const command = execFileSync('ps', ['-p', String(live.processPid), '-o', 'command='], {
        encoding: 'utf8',
      });
      assert.match(
        command,
        /app-server/,
        'Refuse to signal a process that no longer matches the native runner',
      );
      process.kill(live.processPid, 'SIGKILL');
    }
    await wait(read, (snapshot) => snapshot.session.processStopped, timeoutMs);
    rpc('run.resume', { runId });
    if (accepted) {
      assert.equal(currentBinding().recovery, undefined);
      assert.equal(
        read().commands.length,
        before.commands.length + 1,
        'Accepted continuation was resent after worker death',
      );
      assert.equal(read().session.generation, before.session.generation);
      const blocked = await wait(
        () => rpc('run.get', { runId }).run,
        (run) => run.status === 'blocked',
        timeoutMs,
      );
      const decision = blocked.decisions.find(
        (decision) => !decision.resolvedAt && decision.type === 'monitor_interactive_handoff',
      );
      assert.ok(decision?.actions.some((action) => action.id === 'resume-native-worker'));
      rpc('run.resolveDecision', {
        runId,
        decisionId: decision.id,
        actionId: 'resume-native-worker',
      });
    }
    const expectedCount = before.commands.length + (accepted ? 2 : 1);
    const after = await wait(
      read,
      (snapshot) =>
        snapshot.commands.length === expectedCount &&
        snapshot.commands.at(-1)?.outcome === 'completed' &&
        snapshot.session.state === 'idle',
      timeoutMs,
    );
    assert.notEqual(after.session.generation, before.session.generation);
    assert.equal(after.session.nativeSessionId, before.session.nativeSessionId);
    assert.equal(currentBinding().recovery, undefined);
    if (recoveryTest === 'close-uncertain') {
      assert.notEqual(after.commands.at(-1).commandId, intent.commandId);
      assert.equal(
        after.commands.some((command) => command.commandId === intent.commandId),
        false,
      );
    } else if (!accepted) assert.equal(after.commands.at(-1).commandId, intent.commandId);
    else
      assert.equal(
        after.commands.filter((command) => command.commandId === intent.commandId).length,
        1,
      );
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 60000));
    if (!accepted) {
      const delayed = JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8'));
      assert.equal(delayed.transportError, undefined);
      assert.match(delayed.error, /generation or task lease changed/);
      assert.equal(read().commands.length, expectedCount);
    }
    return after;
  } finally {
    fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
    if (fs.existsSync(`${fault}.held`))
      await wait(() => fs.existsSync(`${fault}.applied`), Boolean, Math.min(timeoutMs, 60000));
  }
}
