import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { fixtureChecklistPath, writeNativeFixtureTask } from '../lib/native-task.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-dispatch-reply';

function gatewayPid() {
  const pids = [
    ...new Set(
      execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .map(Number),
    ),
  ];
  assert.equal(pids.length, 1);
  return pids[0];
}

/** Internal corroboration only: a withheld ENSURE reply may leave no public generation pin. */
async function readUnreconciledReservation(state) {
  const root = process.env.FARMSLOT_NATIVE_STATE_DIR;
  assert.ok(
    root && path.resolve(root).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
  );
  assert.equal(state.executionNodeId, 'local');
  const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
  const client = new NativeSessionClient(root, state.executionNodeId);
  const snapshot = await client.readWorker(
    state.binding.ownerPrincipalId,
    state.sessionId,
    state.binding.leaseId,
  );
  assert.equal(snapshot.session.id, state.sessionId);
  assert.equal(snapshot.session.ownerPrincipalId, state.binding.ownerPrincipalId);
  assert.equal(snapshot.scope.leaseId, state.binding.leaseId);
  return snapshot;
}

// Restart only the isolated gateway between prepare and recovery. Never stop its native host.
export async function runScenario({
  runnerAdapter,
  slotId,
  model,
  via,
  timeoutMs,
  outDir,
  explicit,
}) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const preparing = ['send-prepare', 'ensure-prepare'].includes(via);
  let state;
  let preserved = false;
  let fault;
  let stateFile = process.env.FARMSLOT_NATIVE_WORKER_RECOVERY_STATE;
  if (!explicit && !stateFile) {
    report.skipped = true;
    report.skipReason = 'Requires an isolated gateway and staged lost-dispatch-reply restart';
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
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    if (preparing) {
      fault = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
      assert.ok(
        fault &&
          path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      assert.equal(fs.existsSync(fault), false, 'Use a fresh fault file');
      const pid = gatewayPid();
      assert.ok(
        fs.existsSync(`${fault}.${pid}.loaded`),
        'Gateway has not loaded the reply fixture',
      );
      const slot = rpc('fleet.status').fleet.slots.find((candidate) => candidate.slot === slotId);
      assert.ok(slot?.project.startsWith('native-worker-'));
      assert.equal(slot.currentRunId, null);
      const cwd = fs.realpathSync(slot.repo);
      assert.ok(
        cwd.startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
      );
      if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });
      const id = `NATIVE-REPLY-${Date.now()}`;
      const marker = `native-reply-${randomUUID()}.txt`;
      const taskFile = path.join(ROOT, 'projects', slot.project, 'tasks', 'dev', id, 'TASK.md');
      fs.mkdirSync(path.dirname(taskFile), { recursive: true });
      await writeNativeFixtureTask(
        taskFile,
        `# Worker: dev\n\n## Checklist\n\n- [ ] Append exactly one line containing ${id} to ${marker}.\n- [ ] Check both boxes in CHECKLIST.md.\n\nThen end the turn without a terminal signal. Do not commit or modify other files.\n`,
        slot.project,
      );
      const method = via === 'ensure-prepare' ? 'native.worker.ensure' : 'native.worker.send';
      fs.writeFileSync(fault, JSON.stringify({ gatewayPid: pid, method }), { mode: 0o600 });
      const created = rpc('run.createNative', {
        flowType: 'dev',
        project: slot.project,
        ticketOrPr: id,
        slotId,
        allowedSlots: [slotId],
        taskFile,
        runner: report.runner,
        ...(model ? { model } : {}),
        mode: 'interactive',
        skipPrepare: true,
        safetyTier: 'full-auto',
      });
      state = {
        phase: 'preparing',
        runId: created.run.id,
        gatewayPid: pid,
        method,
        slotId,
        cwd,
        marker: path.join(cwd, marker),
        expectedMarker: id,
      };
      stateFile = path.join(outDir, 'dispatch-reply-state.json');
      report.runId = state.runId;
      writeEvidence(report, SCENARIO_ID, report.runner, outDir);
      await wait(() => fs.existsSync(`${fault}.applied`), Boolean, timeoutMs);
      state.applied = JSON.parse(fs.readFileSync(`${fault}.applied`, 'utf8'));
      assert.equal(state.applied.error, undefined);
      const run = rpc('run.get', { runId: state.runId }).run;
      const context = run.agentContexts.find((context) => context.role === 'dev');
      state.binding = context.nativeSession;
      state.contextId = context.id;
      state.sessionId = state.binding.sessionId;
      state.executionNodeId = state.binding.executionNodeId;
      state.taskFile = fixtureChecklistPath(cwd, context.taskFile);
      assert.equal(state.binding.acceptedAt, undefined);
      assert.equal(state.applied.sessionId, state.sessionId);
    } else {
      assert.ok(
        stateFile &&
          path.resolve(stateFile).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(state.phase, 'reply-held');
      assert.notEqual(gatewayPid(), state.gatewayPid, 'Gateway was not restarted');
    }
    report.runId = state.runId;
    const read = () =>
      rpc(
        'native.session.read',
        pinnedWorkerTarget(state.runId, state.contextId, state.binding.leaseId),
      );
    if (preparing) {
      const snapshot =
        state.method === 'native.worker.send'
          ? await wait(
              read,
              (snapshot) =>
                snapshot.commands.find((command) => command.commandId === state.binding.commandId)
                  ?.outcome === 'completed' && snapshot.session.state === 'idle',
              timeoutMs,
            )
          : state.binding.generation
            ? read()
            : await readUnreconciledReservation(state);
      if (!state.binding.generation) {
        assert.throws(
          () =>
            rpc('native.session.read', {
              sessionId: state.sessionId,
              executionNodeId: state.executionNodeId,
            }),
          /pinned run context/,
        );
        state.reservationEvidenceSource =
          'private host scoped read; public generation not yet reconciled';
        report.checks.push(
          'withheld ENSURE is corroborated through the private host; an unpinned public read is refused',
        );
      }
      state.session = snapshot.session;
      assert.equal(snapshot.commands.length, state.method === 'native.worker.send' ? 1 : 0);
      if (state.method === 'native.worker.send') {
        assert.equal(snapshot.commands[0].accepted, true);
        assert.equal(fs.readFileSync(state.marker, 'utf8').trim(), state.expectedMarker);
        state.taskContent = fs.readFileSync(state.taskFile, 'utf8');
        assert.equal(state.taskContent.match(/\[x\]/gi)?.length, 2);
      }
      const current = rpc('run.get', { runId: state.runId }).run;
      assert.equal(
        current.agentContexts.find((context) => context.id === state.contextId).nativeSession
          .acceptedAt,
        undefined,
      );
      state.phase = 'reply-held';
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
      report.checks.push(
        `${state.method} applied with its reply withheld and gateway acceptance unset`,
      );
      report.recoveryState = stateFile;
      report.awaitingGatewayRestart = true;
      report.complete = false;
      preserved = true;
    } else {
      const run = await wait(
        () => rpc('run.get', { runId: state.runId }).run,
        (run) => {
          assert.ok(
            !['failed', 'cancelled', 'blocked'].includes(run.status),
            `${run.status}: ${run.error}`,
          );
          return run.status === 'monitoring';
        },
        timeoutMs,
      );
      const binding = run.agentContexts.find(
        (context) => context.id === state.contextId,
      ).nativeSession;
      assert.equal(binding.sessionId, state.sessionId);
      assert.equal(binding.leaseId, state.binding.leaseId);
      assert.equal(binding.commandId, state.binding.commandId);
      assert.ok(binding.acceptedAt);
      const snapshot = await wait(
        read,
        (snapshot) =>
          snapshot.commands.find((command) => command.commandId === binding.commandId)?.outcome ===
            'completed' && snapshot.session.state === 'idle',
        timeoutMs,
      );
      assert.equal(snapshot.session.generation, state.session.generation);
      assert.equal(snapshot.session.processPid, state.session.processPid);
      assert.equal(snapshot.session.nativeSessionId, state.session.nativeSessionId);
      assert.equal(snapshot.commands.length, 1, 'Initial task was delivered twice');
      assert.equal(fs.readFileSync(state.marker, 'utf8').trim(), state.expectedMarker);
      const taskContent = fs.readFileSync(state.taskFile, 'utf8');
      assert.equal(taskContent.match(/\[x\]/gi)?.length, 2, 'Recovery overwrote worker progress');
      if (state.taskContent) assert.equal(taskContent, state.taskContent);
      report.checks.push(
        'restart keeps the original process, lease and single command, preserving task edits',
      );
      state.phase = 'complete';
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (!preserved && state?.runId) {
      if (fault) fs.writeFileSync(`${fault}.release`, 'cleanup');
      try {
        const result = rpc('run.cancel', {
          runId: state.runId,
          reason: 'Native dispatch reply proof cleanup',
        });
        assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
        if (state.sessionId) {
          const currentBinding = rpc('run.get', { runId: state.runId }).run.agentContexts.find(
            (context) => context.id === state.contextId,
          )?.nativeSession;
          assert.equal(currentBinding?.leaseId, state.binding.leaseId);
          const snapshot = currentBinding.generation
            ? rpc(
                'native.session.read',
                pinnedWorkerTarget(state.runId, state.contextId, state.binding.leaseId),
              )
            : await readUnreconciledReservation(state);
          if (!currentBinding.generation)
            report.checks.push(
              'cleanup process stop corroborated through private host because the initial generation remains unreconciled',
            );
          assert.equal(snapshot.session.processStopped, true);
        }
        assert.equal(
          rpc('fleet.status').fleet.slots.find((slot) => slot.slot === state.slotId).currentRunId,
          null,
        );
        report.checks.push('normal cancellation stops the native process and releases the slot');
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `cleanup: ${error.message}`].filter(Boolean).join('; ');
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
