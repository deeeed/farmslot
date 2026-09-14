import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-resume-reply';

export async function resumeNativeWorkerInUi({ runId, outDir, timeoutMs }) {
  assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
  assert.equal(new URL(process.env.FARMSLOT_UI_URL).origin, 'http://127.0.0.1:18778');
  const route = `run/${runId}`;
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 20000 },
      ),
    );
  cdp('goto', route);
  const selector =
    'const walk=(r)=>[...r.querySelectorAll("*")].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]); const elements=walk(document); const button=elements.find(e=>e.matches("[data-testid=native-worker-resume]"));';
  const readButton = () =>
    cdp(
      'eval',
      route,
      '--file',
      path.join(ROOT, 'apps/command-center/scripts/probes/native-worker-resume.js'),
    );
  await wait(readButton, (button) => button?.visible && !button.disabled, timeoutMs);
  const checkpoint = process.env.FARMSLOT_NATIVE_WORKER_UI_CHECKPOINT;
  if (checkpoint) {
    assert.ok(
      path.resolve(checkpoint).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
    assert.equal(fs.existsSync(checkpoint), false, 'Use a fresh UI checkpoint');
    fs.writeFileSync(checkpoint, JSON.stringify({ runId, route }), { mode: 0o600 });
    await wait(() => fs.existsSync(`${checkpoint}.continue`), Boolean, timeoutMs);
  }
  const button = await wait(readButton, (button) => button?.visible && !button.disabled, timeoutMs);
  assert.equal(button.label, 'Resume stopped worker');
  cdp('screenshot', route, path.join(outDir, 'native-worker-resume-before.png'));
  cdp(
    'eval',
    route,
    selector +
      'if(!button||button.disabled)throw Error("Native resume unavailable");button.click();return {clicked:true};',
  );
  await wait(
    () =>
      cdp(
        'eval',
        route,
        selector +
          'return {present:Boolean(button),errors:elements.filter(e=>e.matches(".ih-error")).map(e=>e.textContent.trim())};',
      ),
    (result) => {
      assert.deepEqual(result.errors, []);
      return !result.present;
    },
    timeoutMs,
  );
  cdp('screenshot', route, path.join(outDir, 'native-worker-resume-after.png'));
}

export async function prepareNativeResumeReply({
  runId,
  context,
  binding,
  cwd,
  marker,
  expectedMarker,
  slotId,
  outDir,
  decisionId,
  holdSendReply = false,
  timeoutMs = 180000,
}) {
  const fault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
  assert.ok(
    fault && path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
  );
  assert.equal(fs.existsSync(fault), false, 'Use a fresh resume reply fault file');
  const pids = [
    ...new Set(
      execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number),
    ),
  ];
  assert.equal(pids.length, 1);
  const gatewayPid = pids[0];
  assert.ok(fs.existsSync(`${fault}.${gatewayPid}.loaded`));
  const sessionId = binding.sessionId;
  fs.writeFileSync(
    fault,
    JSON.stringify({
      gatewayPid,
      sessionId,
      method: holdSendReply ? 'native.worker.send' : 'native.worker.resume',
    }),
    { mode: 0o600 },
  );
  const replyLog = `${fault}.client-reply`;
  const output = fs.openSync(replyLog, 'w', 0o600);
  const errors = fs.openSync(`${fault}.client-errors`, 'w', 0o600);
  const client = spawn(
    process.execPath,
    [
      path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      decisionId ? 'run.resolveDecision' : 'run.resume',
      JSON.stringify(
        decisionId ? { runId, decisionId, actionId: 'resume-native-worker' } : { runId },
      ),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '120000' },
      detached: true,
      stdio: ['ignore', output, errors],
    },
  );
  fs.closeSync(output);
  fs.closeSync(errors);
  let launchError;
  client.on('error', (error) => {
    launchError = error;
  });
  client.unref();
  await wait(
    () => {
      if (launchError) throw launchError;
      return fs.existsSync(`${fault}.applied`);
    },
    Boolean,
    20000,
  );
  const reply = JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8'));
  assert.equal(reply.sessionId, sessionId);
  assert.equal(reply.error, undefined);
  let applied = reply;
  if (holdSendReply) {
    assert.equal(reply.accepted, true);
    const snapshot = await wait(
      () => rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId)),
      (snapshot) =>
        snapshot.commands.find((command) => command.commandId === reply.commandId)?.outcome ===
          'completed' && snapshot.session.state === 'idle',
      timeoutMs,
    );
    applied = snapshot.session;
    assert.equal(
      snapshot.commands.filter((command) => command.commandId === reply.commandId).length,
      1,
    );
  }
  assert.equal(applied.state, 'idle');
  assert.notEqual(applied.generation, binding.generation);
  assert.equal(fs.statSync(replyLog).size, 0, 'Resume reply was not withheld');
  const run = rpc('run.get', { runId }).run;
  const intent = run.agentContexts.find((candidate) => candidate.id === context.id).nativeSession;
  assert.equal(run.status, decisionId ? 'blocked' : 'paused');
  assert.equal(intent.generation, holdSendReply ? applied.generation : binding.generation);
  assert.equal(intent.recovery.fromGeneration, binding.generation);
  assert.ok(intent.recovery.requestedAt);
  if (holdSendReply) assert.equal(reply.commandId, intent.recovery.commandId);
  if (decisionId) {
    const decision = run.decisions.find((decision) => decision.id === decisionId);
    assert.ok(!decision.resolvedAt);
    assert.equal(decision.context.nativeWorkerResume.commandId, intent.recovery.commandId);
  }
  const statePath = path.join(outDir, 'resume-reply-state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        phase: 'reply-held',
        runId,
        sessionId,
        executionNodeId: binding.executionNodeId,
        contextId: context.id,
        original: binding,
        recovery: intent.recovery,
        commandAccepted: holdSendReply,
        applied,
        gatewayPid,
        clientPid: client.pid,
        marker: path.join(cwd, marker),
        expectedMarker,
        slotId,
        ...(decisionId ? { decisionId } : {}),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return statePath;
}
// Staged proof: restart only the isolated gateway after resume-reply-prepare.
// The scenario itself never restarts a gateway or the retained native host.
export async function runScenario({ runnerAdapter, via, timeoutMs, outDir, explicit }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const stateFile = process.env.FARMSLOT_NATIVE_WORKER_RECOVERY_STATE;
  if (!stateFile && !explicit) {
    report.skipped = true;
    report.skipReason =
      'Requires the prepared lost-reply checkpoint and an isolated gateway restart';
    const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    return {
      scenario: SCENARIO_ID,
      runner: report.runner,
      pass: true,
      skipped: true,
      outPath,
      report,
    };
  }
  let state;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(
      stateFile &&
        path.resolve(stateFile).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.phase, 'reply-held');
    report.runId = state.runId;
    const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.ok(pids.length && !pids.includes(state.gatewayPid), 'Gateway was not restarted');
    const read = () =>
      rpc(
        'native.session.read',
        pinnedWorkerTarget(state.runId, state.contextId, state.original.leaseId),
      );
    const before = read();
    assert.equal(before.session.generation, state.applied.generation);
    assert.equal(before.session.processPid, state.applied.processPid);
    const paused = rpc('run.get', { runId: state.runId }).run;
    const binding = paused.agentContexts.find(
      (context) => context.id === state.contextId,
    ).nativeSession;
    const resolvedInUi = via === 'resolved-in-ui';
    if (resolvedInUi) {
      assert.ok(state.decisionId);
      assert.equal(paused.status, 'monitoring');
      assert.equal(binding.generation, state.applied.generation);
      assert.equal(binding.recovery, undefined);
    } else {
      assert.equal(paused.status, state.decisionId ? 'blocked' : 'paused');
      assert.equal(
        binding.generation,
        state.commandAccepted ? state.applied.generation : state.original.generation,
      );
      assert.equal(binding.recovery.commandId, state.recovery.commandId);
      assert.equal(
        before.commands.some(
          (command) => command.commandId === state.recovery.commandId && command.accepted,
        ),
        Boolean(state.commandAccepted),
      );
    }
    if (via !== 'cancel') {
      if (!resolvedInUi && state.decisionId)
        rpc('run.resolveDecision', {
          runId: state.runId,
          decisionId: state.decisionId,
          actionId: 'resume-native-worker',
        });
      else if (!resolvedInUi) rpc('run.resume', { runId: state.runId });
      const resumed = await wait(
        () => rpc('run.get', { runId: state.runId }).run,
        (run) => run.status === 'monitoring',
        timeoutMs,
      );
      assert.equal(resumed.status, 'monitoring');
      const current = resumed.agentContexts.find(
        (context) => context.id === state.contextId,
      ).nativeSession;
      assert.equal(current.generation, state.applied.generation);
      assert.equal(current.recovery, undefined);
      if (state.decisionId) {
        const decision = resumed.decisions.find((decision) => decision.id === state.decisionId);
        assert.ok(decision.resolvedAt);
        assert.equal(decision.context.nativeWorkerResume.commandId, state.recovery.commandId);
      }
      const completed = await wait(
        read,
        (snapshot) => {
          const receipt = snapshot.commands.find(
            (command) => command.commandId === state.recovery.commandId,
          );
          assert.ok(receipt?.state !== 'failed');
          return receipt?.outcome === 'completed' && snapshot.session.state === 'idle';
        },
        timeoutMs,
      );
      assert.equal(completed.session.processPid, state.applied.processPid);
      assert.equal(completed.session.nativeSessionId, state.applied.nativeSessionId);
      assert.equal(
        completed.commands.filter((command) => command.commandId === state.original.commandId)
          .length,
        1,
      );
      assert.equal(
        completed.commands.filter((command) => command.commandId === state.recovery.commandId)
          .length,
        1,
      );
      assert.equal(fs.readFileSync(state.marker, 'utf8').trim(), state.expectedMarker);
      report.checks.push(
        'lost resume reply reconciles the already-created generation/process and sends exactly one continuation',
      );
    }
    const cancelled = rpc('run.cancel', {
      runId: state.runId,
      reason: 'Lost native resume reply proof complete',
    });
    assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
    const closed = read();
    assert.equal(closed.session.generation, state.applied.generation);
    assert.equal(closed.session.state, 'closed');
    assert.equal(closed.session.processStopped, true);
    if (via === 'cancel') {
      assert.equal(
        closed.commands.some((command) => command.commandId === state.recovery.commandId),
        Boolean(state.commandAccepted),
      );
      report.checks.push(
        'cancel discovers and stops the unacknowledged resumed generation without sending work',
      );
    }
    assert.equal(
      rpc('fleet.status').fleet.slots.find((slot) => slot.slot === state.slotId).currentRunId,
      null,
    );
    report.pass = true;
    state.phase = 'complete';
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (error) {
    report.error = error.message;
    if (state?.runId) {
      try {
        const run = rpc('run.get', { runId: state.runId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status)) {
          const result = rpc('run.cancel', {
            runId: state.runId,
            reason: 'Cleanup failed native reply proof',
          });
          assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
        }
        assert.equal(
          rpc('native.session.read', {
            ...pinnedWorkerTarget(state.runId, state.contextId, state.original.leaseId),
          }).session.processStopped,
          true,
        );
      } catch (cleanupError) {
        report.error += `; cleanup: ${cleanupError.message}`;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
