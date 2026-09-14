import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

/** Hold a real queued task behind a live worker, then exercise the production dispatcher. */
export async function verifyNativeWorkerQueue({
  runId,
  binding,
  slotId,
  cwd,
  runner,
  model,
  timeoutMs,
  outDir,
  prepareOnly = false,
  resumeState,
}) {
  if (!resumeState)
    assert.equal(rpc('dispatch.queue.list').items.length, 0, 'Private queue must be empty');
  assert.ok(cwd.startsWith(path.join(ROOT, 'temp/native-validation') + path.sep));
  const parent = rpc('run.get', { runId }).run;
  const parentContext = parent.agentContexts.find(
    (context) =>
      context.nativeSession?.sessionId === binding.sessionId &&
      context.nativeSession.leaseId === binding.leaseId,
  );
  assert.ok(parentContext, 'Selected queue parent lease disappeared');
  const parentPin = () => pinnedWorkerTarget(runId, parentContext.id, binding.leaseId);
  const marker = resumeState?.marker ?? `native-queued-${randomUUID()}.txt`;
  const token = resumeState?.token ?? randomUUID();
  const ticket = resumeState?.ticket ?? `NATIVE-QUEUED-${Date.now()}`;
  const template = path.join(
    ROOT,
    'temp/native-validation/projects',
    parent.project,
    'templates/worker/dev.md',
  );
  const original = resumeState?.originalTemplate ?? fs.readFileSync(template, 'utf8');
  const approved = new Set();
  let itemId = resumeState?.itemId;
  let preserve = false;
  let queuedRunId;
  try {
    let item;
    if (resumeState) {
      const owned = parent.agentContexts.find(
        (context) => context.nativeSession?.sessionId === binding.sessionId,
      )?.nativeSession;
      assert.equal(owned?.leaseId, binding.leaseId);
      assert.equal(owned?.generation, binding.generation);
      const snapshot = rpc('native.session.read', parentPin());
      for (const key of ['id', 'generation', 'processPid', 'nativeSessionId', 'workerLeaseId'])
        assert.equal(snapshot.session[key], resumeState.parentSnapshot.session[key], key);
      assert.deepEqual(snapshot.commands, resumeState.parentSnapshot.commands);
      item = rpc('dispatch.queue.list').items.find((entry) => entry.id === itemId);
      assert.ok(item, 'Queued item did not survive gateway restart');
    } else {
      fs.writeFileSync(
        template,
        `# Worker: dev\n\n## Checklist\n\n- [ ] Write ${marker} containing exactly ${token}.\n\nMark the step, then end the turn without terminal signals. Do not commit, publish, contact services or change other files.\n`,
      );
      const params = {
        flowType: 'dev',
        project: parent.project,
        ticketOrPr: ticket,
        runner,
        model,
        transport: 'native',
        skipPrepare: true,
        mode: 'interactive',
        devInteractiveProfile: 'reviewed',
        slotId,
        allowedSlots: [slotId],
      };
      const ownerToken = process.env.FARMSLOT_GATEWAY_TOKEN;
      try {
        process.env.FARMSLOT_GATEWAY_TOKEN = fs
          .readFileSync(path.join(ROOT, 'temp/native-validation/auth/other-token'), 'utf8')
          .trim();
        assert.throws(() => rpc('dispatch.queue.add', params), /AUTH_FORBIDDEN/);
        assert.equal(rpc('dispatch.queue.list').items.length, 0);
      } finally {
        if (ownerToken === undefined) delete process.env.FARMSLOT_GATEWAY_TOKEN;
        else process.env.FARMSLOT_GATEWAY_TOKEN = ownerToken;
      }
      item = rpc('dispatch.queue.add', params).item;
      itemId = item.id;
    }
    assert.equal(item.transport, 'native', 'Queue discarded native transport');
    assert.equal(item.skipPrepare, true);
    assert.equal(item.originator, undefined, 'Public queue leaked private ownership metadata');
    const queueFile = path.join(ROOT, '.dispatch-queue.json');
    const saved = await wait(
      () =>
        fs.existsSync(queueFile)
          ? JSON.parse(fs.readFileSync(queueFile, 'utf8')).find((entry) => entry.id === itemId)
          : undefined,
      Boolean,
      10000,
    );
    assert.equal(saved.transport, 'native');
    assert.equal(saved.skipPrepare, true);
    assert.deepEqual(saved.originator, {
      kind: 'principal',
      principalId: binding.ownerPrincipalId,
    });
    // The add write can include a quiet claim that was released in memory.
    // Restart recovery explicitly reconciles either state before dispatch.
    assert.ok(['queued', 'dispatching'].includes(saved.status));
    await wait(
      () => rpc('dispatch.queue.list').items.find((item) => item.id === itemId),
      (item) => item?.status === 'queued',
      10000,
    );
    assert.equal(
      rpc('run.list', { limit: 20 }).runs.some((run) => run.ticketOrPr.includes(ticket)),
      false,
    );
    fs.writeFileSync(
      path.join(outDir, 'queued-native-state.json'),
      JSON.stringify(
        {
          parentRunId: runId,
          itemId,
          transport: saved.transport,
          skipPrepare: saved.skipPrepare,
          originator: saved.originator,
          heldBySlot: slotId,
        },
        null,
        2,
      ),
    );
    if (prepareOnly) {
      const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .map(Number);
      assert.equal(pids.length, 1);
      const statePath = path.join(outDir, 'queue-restart-state.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            runId,
            binding,
            slotId,
            cwd,
            runner,
            model,
            marker,
            token,
            ticket,
            itemId,
            originalTemplate: original,
            gatewayPid: pids[0],
            parentSnapshot: rpc('native.session.read', {
              ...parentPin(),
              limit: 1,
            }),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      preserve = true;
      return statePath;
    }
    const cancelled = rpc('run.cancel', {
      runId,
      reason: 'Release fixture slot for queued native task',
    });
    assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
    const next = await wait(
      () => {
        const queued = rpc('dispatch.queue.list').items.find((item) => item.id === itemId);
        assert.ok(
          !queued?.waitingReason,
          `Queued native dispatch refused: ${queued?.waitingReason}`,
        );
        return rpc('run.list', { limit: 20 }).runs.find((run) => run.ticketOrPr.includes(ticket));
      },
      Boolean,
      timeoutMs,
    );
    queuedRunId = next.id;
    assert.equal(next.transport, 'native');
    assert.equal(next.nativeOwnerPrincipalId, binding.ownerPrincipalId);
    assert.equal(next.createdByPrincipalId, binding.ownerPrincipalId);
    await wait(
      () => rpc('dispatch.queue.list').items.some((item) => item.id === itemId),
      (present) => !present,
      10000,
    );
    const dispatched = await wait(
      () => rpc('run.get', { runId: queuedRunId }).run,
      (run) => {
        assert.ok(!['failed', 'blocked', 'cancelled'].includes(run.status), run.error);
        return run.agentContexts?.some((context) => context.nativeSession?.acceptedAt);
      },
      timeoutMs,
    );
    const context = dispatched.agentContexts.find((context) => context.nativeSession?.acceptedAt);
    const nextBinding = context.nativeSession;
    assert.equal(
      dispatched.steps.find((step) => step.name === 'prepare').outputs.reason,
      'operator-skip',
    );
    const target = {
      sessionId: nextBinding.sessionId,
      executionNodeId: nextBinding.executionNodeId,
    };
    await wait(
      async () => {
        const snapshot = rpc(
          'native.session.read',
          pinnedWorkerTarget(queuedRunId, context.id, nextBinding.leaseId),
        );
        for (const request of snapshot.pendingRequests) {
          if (approved.has(request.request.id)) continue;
          assert.equal(request.type, 'approval.requested');
          if (request.data?.cwd) assert.equal(request.data.cwd, cwd);
          rpc('native.session.respond', {
            ...target,
            worker: {
              runId: queuedRunId,
              contextId: context.id,
              generation: nextBinding.generation,
              leaseId: nextBinding.leaseId,
            },
            requestId: request.request.id,
            decision: 'approve',
          });
          approved.add(request.request.id);
        }
        return snapshot;
      },
      (snapshot) =>
        snapshot.session.state === 'idle' &&
        snapshot.commands.find((command) => command.commandId === nextBinding.commandId)
          ?.outcome === 'completed',
      timeoutMs,
    );
    assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), token);
    assert.equal(
      rpc('run.list', { limit: 100 }).runs.filter((run) => run.ticketOrPr.includes(ticket)).length,
      1,
      'Queued task created more than one run',
    );
    fs.writeFileSync(
      path.join(outDir, 'queued-native-result.json'),
      JSON.stringify(
        {
          runId: queuedRunId,
          transport: next.transport,
          owner: next.nativeOwnerPrincipalId,
          createdBy: next.createdByPrincipalId,
          sessionId: nextBinding.sessionId,
          marker,
          approvals: approved.size,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!preserve) {
      fs.writeFileSync(template, original);
      if (itemId && rpc('dispatch.queue.list').items.some((item) => item.id === itemId))
        rpc('dispatch.queue.remove', { itemId });
      if (!queuedRunId)
        queuedRunId = rpc('run.list', { limit: 20 }).runs.find((run) =>
          run.ticketOrPr.includes(ticket),
        )?.id;
      if (queuedRunId) {
        const run = rpc('run.get', { runId: queuedRunId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status)) {
          const cancelled = rpc('run.cancel', {
            runId: queuedRunId,
            reason: 'Queued native fixture cleanup',
          });
          assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
        } else if (run.status === 'failed')
          rpc('slot.release', { slotId, keepWork: true, expectedRunId: queuedRunId });
      }
    }
  }
}

export const SCENARIO_ID = 'native-worker-queue';

export async function runScenario({ runnerAdapter, timeoutMs, outDir, explicit }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  const statePath = process.env.FARMSLOT_NATIVE_QUEUE_STATE;
  if (!statePath && !explicit)
    return { scenario: SCENARIO_ID, runner: report.runner, pass: true, skipped: true };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(
      statePath &&
        path.resolve(statePath).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(pids.length, 1);
    assert.notEqual(
      pids[0],
      state.gatewayPid,
      'Restart the private gateway before recovery validation',
    );
    report.runId = state.runId;
    await verifyNativeWorkerQueue({ ...state, timeoutMs, outDir, resumeState: state });
    report.checks.push(
      'queued transport, private owner and native parent process survive gateway restart; background dispatch creates the owned native child once',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
