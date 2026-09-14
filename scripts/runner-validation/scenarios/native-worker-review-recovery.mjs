import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { readPinnedWorkerHistory } from './native-worker-history.mjs';
import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-review-recovery';

export async function verifyNativeFixReplay(statePath, timeoutMs) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const logPath = process.env.FARMSLOT_VALIDATION_GATEWAY_LOG;
  assert.ok(logPath, 'Replay proof requires the private gateway runtime log');
  assert.ok(fs.realpathSync(logPath).startsWith(path.join(ROOT, 'temp/native-validation/')));
  const offset = fs.statSync(logPath).size;
  const before = rpc('run.get', { runId: state.runId }).run;
  const reviewers = before.agentContexts
    .filter((context) => context.role === 'self-review')
    .map((context) => context.id)
    .sort();
  const generation = before.engineState.generation ?? 0;
  rpc('run.replayStep', { runId: state.runId, stepName: 'monitor' });
  await wait(
    () => rpc('run.get', { runId: state.runId }).run,
    (run) => {
      assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
      return run.engineState.generation > generation && run.status === 'monitoring';
    },
    timeoutMs,
  );
  const retirement = `[run-engine] run ${state.runId.slice(0, 8)} — stale loop in catch (gen ${generation}), not marking failed`;
  const preserved = `[run-engine] run ${state.runId.slice(0, 8)} step self-review threw after monitoring; preserving operator state`;
  fs.writeFileSync(state.releasePath, 'continue\n');
  await wait(
    () => rpc('run.get', { runId: state.runId }).run,
    (run) => {
      assert.equal(run.status, 'monitoring');
      assert.deepEqual(
        run.agentContexts
          .filter((context) => context.role === 'self-review')
          .map((context) => context.id)
          .sort(),
        reviewers,
        'Old review controller launched another reviewer after replay',
      );
      const log = fs.readFileSync(logPath, 'utf8').slice(offset);
      return log.includes(retirement) || log.includes(preserved);
    },
    Math.min(timeoutMs, 120_000),
  );
  await wait(
    () =>
      rpc('native.session.read', {
        ...pinnedWorkerTarget(state.runId, state.fix.id, state.fix.nativeSessionOwner.leaseId),
        limit: 1,
      }),
    (read) => {
      assert.equal(read.commands.length, 2, 'Replay must not send another worker instruction');
      return (
        read.commands.find((command) => command.commandId === state.fix.nativeCommandId)
          ?.outcome === 'completed'
      );
    },
    timeoutMs,
  );
  const after = rpc('run.get', { runId: state.runId }).run;
  assert.equal(after.status, 'monitoring');
  assert.deepEqual(
    after.agentContexts
      .filter((context) => context.role === 'self-review')
      .map((context) => context.id)
      .sort(),
    reviewers,
  );
  assert.equal(after.steps.find((step) => step.name === 'self-review').status, 'pending');
  const cancelled = rpc('run.cancel', {
    runId: state.runId,
    reason: 'Native review replay fixture complete',
  });
  assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
  for (const context of cancelled.run.agentContexts.filter(
    (context) => context.nativeSession && !context.nativeSession.releasedAt,
  ))
    assert.equal(
      rpc('native.session.read', {
        ...pinnedWorkerTarget(state.runId, context.id, context.nativeSession.leaseId),
        limit: 1,
      }).session.processStopped,
      true,
    );
}

export async function prepareNativeFixRestart({
  runId,
  sessionId,
  cwd,
  fixture,
  timeoutMs,
  outDir,
  stopWorker,
}) {
  const run = await wait(
    () => rpc('run.get', { runId }).run,
    (current) => {
      assert.ok(!['failed', 'cancelled'].includes(current.status), current.error);
      const fix = current.agentContexts.find((context) => context.role === 'self-review-fix');
      if (!fix?.nativeCommandId || !fix.signalAttemptId) return false;
      const snapshot = rpc('native.session.read', {
        ...pinnedWorkerTarget(runId, fix.id, fix.nativeSessionOwner.leaseId),
        limit: 1,
      });
      return snapshot.commands.some(
        (command) =>
          command.commandId === fix.nativeCommandId && command.accepted && !command.outcome,
      );
    },
    timeoutMs,
  );
  const fix = run.agentContexts.find((context) => context.role === 'self-review-fix');
  const owner = run.agentContexts.find(
    (context) => context.id === fix.nativeSessionOwner.contextId,
  );
  for (const mode of ['reconcile', 'restore-window', 'reload-session']) {
    assert.throws(
      () => rpc('tmux.worker.restore', { runId, slotId: run.slotId, mode }),
      /Use native session recovery/,
    );
  }
  const before = rpc('native.session.read', {
    ...pinnedWorkerTarget(runId, fix.id, fix.nativeSessionOwner.leaseId),
    limit: 1,
  }).session;
  assert.equal(run.activeTaskFile, fix.taskFile);
  assert.equal(fs.readFileSync(fixture.path, 'utf8'), 'Incorrect native review fixture.\n');
  assert.deepEqual(
    rpc('run.list', { active: true }).runs.map((run) => run.id),
    [runId],
  );
  if (stopWorker) {
    rpc('native.session.close', {
      sessionId,
      executionNodeId: owner.nativeSession.executionNodeId,
      worker: {
        runId,
        contextId: fix.id,
        generation: owner.nativeSession.generation,
        leaseId: owner.nativeSession.leaseId,
      },
    });
    assert.equal(
      rpc('native.session.read', {
        ...pinnedWorkerTarget(runId, fix.id, fix.nativeSessionOwner.leaseId),
        limit: 1,
      }).session.processStopped,
      true,
    );
  }
  const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  assert.equal(pids.length, 1);
  const state = {
    runId,
    sessionId,
    cwd,
    fixture,
    stopWorker,
    before,
    fix,
    gatewayPid: Number(pids[0]),
    releasePath: path.join(cwd, path.posix.dirname(fix.taskFile), 'NATIVE-FIX-RELEASE'),
  };
  const statePath = path.join(outDir, 'native-review-recovery-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  return statePath;
}

export async function runScenario({ runnerAdapter, timeoutMs, outDir, explicit }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const statePath = process.env.FARMSLOT_NATIVE_REVIEW_RECOVERY_STATE;
  if (!statePath && !explicit) {
    report.skipped = true;
    report.skipReason = 'Requires a prepared native fix and an isolated gateway restart';
    return {
      scenario: SCENARIO_ID,
      runner: report.runner,
      skipped: true,
      pass: true,
      outPath: writeEvidence(report, SCENARIO_ID, report.runner, outDir),
      report,
    };
  }
  let state;
  let settled = false;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(statePath);
    const candidate = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(candidate.cwd.startsWith(path.join(ROOT, 'temp/native-validation/')));
    assert.equal(candidate.fixture.path, path.join(candidate.cwd, 'fixture.txt'));
    assert.equal(
      candidate.releasePath,
      path.join(candidate.cwd, path.posix.dirname(candidate.fix.taskFile), 'NATIVE-FIX-RELEASE'),
    );
    state = candidate;
    report.runId = state.runId;
    const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map(Number);
    assert.ok(
      pids.length === 1 && pids[0] !== state.gatewayPid,
      'Restart the private gateway with orchestration enabled',
    );
    const recovered = await wait(
      () => rpc('run.get', { runId: state.runId }).run,
      (run) => {
        assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
        const fix = run.agentContexts.find((context) => context.id === state.fix.id);
        if (fix) {
          assert.equal(fix.status, 'working', 'Startup must preserve the active fix task');
          assert.equal(
            fix.attemptStartedAt,
            state.fix.attemptStartedAt,
            'Startup must not create a replacement fix attempt',
          );
        }
        if (!fix || (state.stopWorker && fix.nativeCommandId === state.fix.nativeCommandId))
          return false;
        const snapshot = rpc('native.session.read', {
          ...pinnedWorkerTarget(state.runId, state.fix.id, state.fix.nativeSessionOwner.leaseId),
          limit: 1,
        });
        return snapshot.commands.some(
          (command) => command.commandId === fix.nativeCommandId && command.accepted,
        );
      },
      timeoutMs,
    );
    const fix = recovered.agentContexts.find((context) => context.id === state.fix.id);
    assert.equal(fix.attemptStartedAt, state.fix.attemptStartedAt);
    assert.deepEqual(fix.nativeSessionOwner, state.fix.nativeSessionOwner);
    assert.equal(fix.taskFile, state.fix.taskFile);
    assert.equal(recovered.activeTaskFile, state.fix.taskFile);
    const snapshot = rpc('native.session.read', {
      ...pinnedWorkerTarget(state.runId, state.fix.id, state.fix.nativeSessionOwner.leaseId),
      limit: 1,
    });
    assert.equal(snapshot.session.nativeSessionId, state.before.nativeSessionId);
    if (state.stopWorker) assert.notEqual(snapshot.session.generation, state.before.generation);
    else assert.equal(snapshot.session.generation, state.before.generation);
    assert.equal(snapshot.commands.length, state.stopWorker ? 3 : 2);
    assert.equal(
      snapshot.commands.filter((command) => command.commandId === state.fix.nativeCommandId).length,
      1,
    );
    report.checks.push(
      'startup preserves the fix attempt and task lease, recovers the same conversation, and does not resend an accepted instruction',
    );
    fs.writeFileSync(state.releasePath, 'continue\n');
    const done = await wait(
      () => rpc('run.get', { runId: state.runId }).run,
      (run) => {
        assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
        return run.status === 'done';
      },
      timeoutMs,
    );
    assert.equal(fs.readFileSync(state.fixture.path, 'utf8'), state.fixture.text);
    assert.equal(done.steps.find((step) => step.name === 'self-review').outputs.verdict, 'pass');
    assert.equal(
      done.agentContexts.find((context) => context.id === state.fix.id).status,
      'complete',
    );
    const reviewers = done.agentContexts.filter((context) => context.role === 'self-review');
    assert.equal(reviewers.length, 2);
    assert.ok(reviewers.every((context) => context.reviewResultValidatedAt));
    assert.equal(reviewers[0].nativeSession.sessionId, reviewers[1].nativeSession.sessionId);
    const priorReview = readPinnedWorkerHistory(
      state.runId,
      reviewers[0].id,
      reviewers[0].nativeSession.leaseId,
    );
    const currentReview = readPinnedWorkerHistory(
      state.runId,
      reviewers[1].id,
      reviewers[1].nativeSession.leaseId,
    );
    assert.equal(priorReview.scope.released, true);
    assert.equal(currentReview.scope.startAfter, priorReview.scope.endAt);
    assert.deepEqual(priorReview.pendingRequests, []);
    assert.deepEqual(
      priorReview.commands.map((command) => command.commandId),
      [reviewers[0].nativeSession.commandId],
    );
    assert.deepEqual(
      currentReview.commands.map((command) => command.commandId),
      [reviewers[1].nativeSession.commandId],
    );
    assert.equal(currentReview.session.processStopped, true);
    assert.equal(
      rpc(
        'native.session.read',
        pinnedWorkerTarget(state.runId, state.fix.id, state.fix.nativeSessionOwner.leaseId),
      ).session.processStopped,
      true,
    );
    report.checks.push(
      'recovered fix completes, retained reviewer validates it, and artifact-only completion stops both processes',
    );
    report.pass = true;
    settled = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (state && !settled) {
      try {
        const run = rpc('run.get', { runId: state.runId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status))
          rpc('run.cancel', {
            runId: state.runId,
            reason: 'Cleanup native review recovery fixture',
          });
        if (run.status === 'failed') rpc('slot.release', { slotId: run.slotId, keepWork: true });
      } catch (error) {
        report.error = [report.error, `Cleanup: ${error.message}`].filter(Boolean).join('\n');
      }
    }
    if (state) fs.writeFileSync(state.fixture.path, state.fixture.text);
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
