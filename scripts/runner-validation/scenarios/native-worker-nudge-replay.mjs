import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

/** Called after native-nudge-busy observes the waiting child and running parent. */
export async function verifyNativeNudgeReplay({
  runId,
  parentRunId,
  releasePath,
  binding,
  read,
  timeoutMs,
  outDir,
}) {
  const logPath = process.env.FARMSLOT_VALIDATION_GATEWAY_LOG;
  const root = path.join(ROOT, 'temp/native-validation') + path.sep;
  for (const value of [logPath, releasePath, outDir])
    assert.ok(value && path.resolve(value).startsWith(root));
  const before = rpc('run.get', { runId }).run;
  const source = rpc('run.get', { runId: parentRunId }).run.agentContexts.find(
    (c) => c.nativeSession?.leaseId === binding.leaseId,
  );
  assert.equal(before.status, 'dispatching');
  assert.ok(!before.agentContexts.some((c) => c.nativeSession));
  assert.equal(read().session.state, 'running');
  const offset = fs.statSync(logPath).size;
  fs.mkdirSync(outDir, { recursive: true });
  const observation = {
    runId,
    parentRunId,
    beforeGeneration: before.engineState?.generation ?? 0,
    samples: [],
  };
  const save = () =>
    fs.writeFileSync(
      path.join(outDir, 'nudge-replay-observation.json'),
      JSON.stringify(observation, null, 2) + '\n',
    );
  try {
    // Replay invalidates the old engine before its slot claim is refused. That
    // real generation change must retire the old nudge despite no replacement.
    try {
      rpc('run.replayStep', { runId, stepName: 'dispatch', skipPrepare: true });
    } catch (error) {
      observation.replayError = error.message;
    }
    assert.match(observation.replayError ?? '', /no longer safely reclaimable/);
    const replayed = rpc('run.get', { runId }).run;
    assert.ok((replayed.engineState?.generation ?? 0) > (before.engineState?.generation ?? 0));
    assert.notDeepEqual(
      [replayed.metrics.runner, replayed.metrics.model],
      [source.runner, source.model],
      'Use a parent runner/model different from the nudge wizard settings',
    );
    observation.replayedGeneration = replayed.engineState?.generation ?? 0;
    save();
    fs.writeFileSync(releasePath, 'continue\n');
    await wait(
      () => {
        const current = rpc('run.get', { runId }).run;
        observation.samples.push({
          runner: current.metrics.runner,
          model: current.metrics.model,
          safetyTier: current.safetyTier,
          effort: current.effort,
          nativeLeases: current.agentContexts.filter((c) => c.nativeSession).length,
        });
        save();
        assert.deepEqual(
          [current.metrics.runner, current.metrics.model, current.safetyTier, current.effort],
          [replayed.metrics.runner, replayed.metrics.model, replayed.safetyTier, replayed.effort],
          'Superseded nudge overwrote replay settings',
        );
        assert.ok(
          !current.agentContexts.some((c) => c.nativeSession),
          'Superseded nudge reserved or dispatched a task lease',
        );
        assert.equal(read().session.workerLeaseId, binding.leaseId);
        return fs.readFileSync(logPath, 'utf8').slice(offset);
      },
      (log) => {
        const retired = log.includes(
          `run ${runId.slice(0, 8)} step dispatch threw after ${replayed.status}; preserving operator state`,
        );
        if (retired) {
          observation.retiredOldDispatch = true;
          save();
        }
        return retired;
      },
      Math.min(timeoutMs, 30000),
    );
  } finally {
    // The failed replay leaves a stopped controller; release only this fixture child.
    const current = rpc('run.get', { runId }).run;
    if (!['cancelled', 'done', 'failed'].includes(current.status))
      rpc('run.cancel', { runId, reason: 'Nudge replay race proof complete' });
    save();
  }
}
