import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-reviewer-recovery';

export async function verifyNativeReviewCleanupFailure(statePath, timeoutMs) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const config = process.env.FARMSLOT_NATIVE_REVIEW_CLEANUP_FAULT;
  assert.ok(config && path.resolve(config).startsWith(path.join(ROOT, 'temp/native-validation/')));
  assert.equal(fs.existsSync(config), false, 'Use a fresh private cleanup fault file');
  assert.ok(
    fs.existsSync(`${config}.${state.gatewayPid}.loaded`),
    'Gateway cleanup fixture was not loaded',
  );
  fs.writeFileSync(
    config,
    JSON.stringify({
      gatewayPid: state.gatewayPid,
      filePath: path.join(state.cwd, state.context.taskFile),
    }),
    { mode: 0o600 },
  );
  const binding = state.context.nativeSession;
  rpc('native.session.close', {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    worker: {
      runId: state.runId,
      contextId: state.context.id,
      generation: binding.generation,
      leaseId: binding.leaseId,
    },
  });
  const failed = await wait(
    () => rpc('run.get', { runId: state.runId }).run,
    (run) => run.status === 'failed',
    Math.min(timeoutMs, 30000),
  );
  assert.ok(fs.existsSync(`${config}.fired`), 'Asynchronous close fault must actually fire');
  assert.match(failed.error, /Native reviewer stopped without a valid terminal signal/);
  assert.match(failed.error, /Injected asynchronous native review watcher close failure/);
  assert.ok(!failed.activeTaskFile, 'Other cleanup must restore the active task after close fails');
  assert.equal(
    rpc('native.session.read', {
      ...pinnedWorkerTarget(state.runId, state.context.id, binding.leaseId),
      limit: 1,
    }).session.processStopped,
    true,
  );
  const released = rpc('slot.release', { slotId: failed.slotId, keepWork: true });
  assert.equal(released.released, true);
  for (const context of failed.agentContexts.filter((context) => context.nativeSession))
    assert.equal(
      rpc('native.session.read', {
        ...pinnedWorkerTarget(state.runId, context.id, context.nativeSession.leaseId),
        limit: 1,
      }).session.processStopped,
      true,
    );
}

export async function prepareNativeReviewerRestart({
  runId,
  cwd,
  timeoutMs,
  outDir,
  stopReviewer,
  replyFault,
}) {
  const run = await wait(
    () => rpc('run.get', { runId }).run,
    (run) => {
      assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
      return run.agentContexts.some(
        (context) =>
          context.role === 'self-review' &&
          (replyFault
            ? context.nativeSession?.generation && fs.existsSync(`${replyFault}.applied`)
            : context.nativeSession?.acceptedAt &&
              context.signalAttemptId &&
              context.status === 'working'),
      );
    },
    timeoutMs,
  );
  const context = run.agentContexts.find((context) => context.role === 'self-review');
  const before = rpc('native.session.read', {
    ...pinnedWorkerTarget(runId, context.id, context.nativeSession.leaseId),
    limit: 1,
  });
  assert.equal(before.commands.length, 1);
  assert.equal(before.commands[0].accepted, true);
  assert.equal(before.commands[0].outcome, undefined);
  if (replyFault) {
    const applied = JSON.parse(fs.readFileSync(`${replyFault}.applied`, 'utf8'));
    assert.equal(applied.error, undefined);
    assert.equal(applied.accepted, true);
    assert.equal(applied.sessionId, context.nativeSession.sessionId);
    assert.equal(applied.commandId, context.nativeSession.commandId);
    assert.equal(context.nativeSession.acceptedAt, undefined);
  }
  assert.deepEqual(
    rpc('run.list', { active: true }).runs.map((run) => run.id),
    [runId],
  );
  const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  assert.equal(pids.length, 1);
  const state = {
    runId,
    cwd,
    context,
    before: before.session,
    stopReviewer,
    lostSendReply: Boolean(replyFault),
    gatewayPid: Number(pids[0]),
    releasePath: path.join(cwd, path.posix.dirname(context.taskFile), 'NATIVE-REVIEW-RELEASE'),
  };
  const statePath = path.join(outDir, 'native-reviewer-recovery-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  return statePath;
}

export async function runScenario({ runnerAdapter, timeoutMs, outDir, explicit, via }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const statePath = process.env.FARMSLOT_NATIVE_REVIEWER_RECOVERY_STATE;
  if (!statePath && !explicit) {
    report.skipped = true;
    report.skipReason = 'Requires a prepared native reviewer and isolated gateway restart';
    return {
      scenario: SCENARIO_ID,
      runner: report.runner,
      pass: true,
      skipped: true,
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
    assert.equal(candidate.runId, candidate.context.runId);
    assert.equal(
      candidate.releasePath,
      path.join(
        candidate.cwd,
        path.posix.dirname(candidate.context.taskFile),
        'NATIVE-REVIEW-RELEASE',
      ),
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
    const sessionId = state.context.nativeSession.sessionId;
    if (via === 'complete-offline') {
      // Run this leg on the private control gateway with orchestration disabled.
      // The actual reviewer, not the recipe, writes the terminal artifacts.
      fs.writeFileSync(state.releasePath, 'continue\n');
      await wait(
        () =>
          rpc('native.session.read', {
            ...pinnedWorkerTarget(
              state.runId,
              state.context.id,
              state.context.nativeSession.leaseId,
            ),
            limit: 1,
          }),
        (read) => {
          assert.equal(read.session.generation, state.before.generation);
          assert.ok(!['failed', 'closed'].includes(read.session.state));
          return read.commands[0]?.outcome === 'completed' && read.session.state === 'idle';
        },
        timeoutMs,
      );
      const signal = JSON.parse(
        fs.readFileSync(path.join(state.cwd, state.context.signalFile), 'utf8'),
      );
      assert.equal(signal.status, 'complete');
      assert.equal(rpc('run.get', { runId: state.runId }).run.status, 'self-reviewing');
      const binding = state.context.nativeSession;
      const closed = rpc('native.session.close', {
        sessionId,
        executionNodeId: binding.executionNodeId,
        worker: {
          runId: state.runId,
          contextId: state.context.id,
          generation: binding.generation,
          leaseId: binding.leaseId,
        },
      });
      assert.equal(closed.session.processStopped, true);
      fs.writeFileSync(
        statePath,
        JSON.stringify({ ...state, completedWhileOffline: true }, null, 2),
        { mode: 0o600 },
      );
      report.checks.push(
        'reviewer completed its real scoped signal while orchestration was offline, then its process stopped',
      );
      report.complete = false;
      report.awaitingGatewayRestart = true;
      report.pass = true;
      settled = true;
      const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      return { scenario: SCENARIO_ID, runner: report.runner, pass: true, outPath, report };
    }
    const needsResume = state.stopReviewer && !state.completedWhileOffline;
    const recovered = await wait(
      () => rpc('run.get', { runId: state.runId }).run,
      (run) => {
        assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
        const contexts = run.agentContexts.filter((context) => context.role === 'self-review');
        assert.equal(contexts.length, 1, 'Restart must not create another reviewer attempt');
        const context = contexts[0];
        assert.equal(context.id, state.context.id);
        assert.equal(context.taskFile, state.context.taskFile);
        assert.equal(context.signalFile, state.context.signalFile);
        const read = rpc('native.session.read', {
          ...pinnedWorkerTarget(state.runId, state.context.id, state.context.nativeSession.leaseId),
          limit: 1,
        });
        if (state.completedWhileOffline) return run.status === 'done';
        if (needsResume && read.session.generation === state.before.generation) return false;
        return (
          run.status === 'self-reviewing' &&
          context.status === 'working' &&
          (!state.lostSendReply || context.nativeSession?.acceptedAt) &&
          read.commands.some(
            (command) => command.generation === read.session.generation && command.accepted,
          )
        );
      },
      timeoutMs,
    );
    const context = recovered.agentContexts.find((context) => context.id === state.context.id);
    const snapshot = rpc('native.session.read', {
      ...pinnedWorkerTarget(state.runId, state.context.id, state.context.nativeSession.leaseId),
      limit: 1,
    });
    if (state.lostSendReply) {
      assert.equal(state.context.nativeSession.acceptedAt, undefined);
      assert.ok(context.nativeSession.acceptedAt);
      assert.equal(context.nativeSession.commandId, state.context.nativeSession.commandId);
      report.checks.push('lost reviewer send reply reconciles the original accepted command');
    }
    assert.equal(snapshot.session.nativeSessionId, state.before.nativeSessionId);
    assert.equal(context.nativeSession.leaseId, state.context.nativeSession.leaseId);
    assert.equal(snapshot.commands.length, needsResume ? 2 : 1);
    if (!needsResume) {
      assert.equal(snapshot.session.generation, state.before.generation);
      assert.equal(snapshot.session.processPid, state.before.processPid);
    }
    report.checks.push(
      'startup preserves the reviewer attempt, task files and conversation without resending accepted review work',
    );
    if (state.completedWhileOffline)
      report.checks.push(
        'completed reviewer artifacts are recovered without launching a new process or continuation',
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
    const reviewer = done.agentContexts.find((context) => context.id === state.context.id);
    assert.equal(reviewer.status, 'complete');
    assert.ok(reviewer.reviewResultValidatedAt);
    assert.equal(done.steps.find((step) => step.name === 'self-review').outputs.verdict, 'pass');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(state.cwd, reviewer.signalFile), 'utf8')).status,
      'complete',
    );
    const result = JSON.parse(
      fs.readFileSync(
        path.join(state.cwd, path.posix.dirname(reviewer.taskFile), reviewer.reviewResultFile),
        'utf8',
      ),
    );
    assert.equal(result.verdict, 'pass');
    for (const current of done.agentContexts.filter((context) => context.nativeSession))
      assert.equal(
        rpc('native.session.read', {
          ...pinnedWorkerTarget(state.runId, current.id, current.nativeSession.leaseId),
          limit: 1,
        }).session.processStopped,
        true,
      );
    report.checks.push(
      'recovered reviewer writes and validates its scoped terminal result; finalization stops worker and reviewer',
    );
    settled = true;
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (state && !settled) {
      try {
        const run = rpc('run.get', { runId: state.runId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status))
          rpc('run.cancel', {
            runId: state.runId,
            reason: 'Cleanup native reviewer recovery fixture',
          });
        if (run.status === 'failed') rpc('slot.release', { slotId: run.slotId, keepWork: true });
      } catch (error) {
        report.error = [report.error, `Cleanup: ${error.message}`].filter(Boolean).join('\n');
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
