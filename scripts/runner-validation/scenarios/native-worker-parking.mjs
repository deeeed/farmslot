import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-parking';

/** Real release/restore RPCs on an explicitly selected isolated worker fixture. */
export async function runScenario({ runnerAdapter, slotId, model, timeoutMs, outDir, explicit }) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  if (!slotId && !explicit)
    return { scenario: SCENARIO_ID, runner: report.runner, pass: true, skipped: true };
  let runId;
  let target;
  let pinned;
  const resourceRoot = process.env.FARMSLOT_NATIVE_PARK_RESOURCE_ROOT;
  const resourceId = 'native-parking-proof';
  let resourceBefore;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const slot = rpc('fleet.status').fleet.slots.find((item) => item.slot === slotId);
    assert.ok(slot && !slot.currentRunId, 'Select an idle private worker fixture');
    const remoteRoot = '/Users/deeeed/dev/farmslot-worktrees/native-node-validation';
    const remote = slotId === 'native-worker-remote';
    if (remote) {
      assert.equal(slot.machine, 'native-macpro-validation');
      assert.equal(slot.repo, `${remoteRoot}/worker-fixture`);
    } else {
      assert.ok(
        fs
          .realpathSync(slot.repo)
          .startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
      );
    }
    if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });
    const token = randomUUID();
    const marker = `native-park-${randomUUID()}.txt`;
    const taskFile = path.join(
      ROOT,
      'projects',
      slot.project,
      'tasks/dev',
      `NATIVE-PARK-${Date.now()}`,
      'TASK.md',
    );
    await writeNativeFixtureTask(
      taskFile,
      `# Worker: dev\n\n## Checklist\n\n- [ ] Write ${marker} containing exactly ${token}.\n- [ ] Check both checklist steps.\n\nThen end the turn without a terminal signal. Do not commit, contact services or change other files.\n`,
      slot.project,
      remote
        ? {
            markCommand: `node ${remoteRoot}/node/node_modules/@farmslot/agent-runtime/scripts/mark-checklist-step.cjs`,
          }
        : {},
    );
    const created = rpc('run.createNative', {
      flowType: 'dev',
      project: slot.project,
      ticketOrPr: path.basename(path.dirname(taskFile)),
      taskFile,
      slotId,
      allowedSlots: [slotId],
      runner: report.runner,
      ...(model ? { model } : {}),
      mode: 'interactive',
      skipPrepare: true,
      safetyTier: 'full-auto',
    }).run;
    runId = created.id;
    report.runId = runId;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    const started = await wait(
      () => rpc('run.get', { runId }).run,
      (run) => {
        assert.ok(
          !['failed', 'blocked', 'cancelled'].includes(run.status),
          `${run.status}: ${run.error}`,
        );
        return run.agentContexts?.some((context) => context.nativeSession?.acceptedAt);
      },
      timeoutMs,
    );
    const context = started.agentContexts.find((item) => item.role === 'dev');
    const binding = context.nativeSession;
    assert.equal(context.target, null);
    target = { sessionId: binding.sessionId, executionNodeId: binding.executionNodeId };
    pinned = () => pinnedWorkerTarget(runId, context.id, binding.leaseId);
    const read = () => rpc('native.session.read', pinned());
    const initial = await wait(
      read,
      (snapshot) =>
        snapshot.session.state === 'idle' &&
        snapshot.commands.find((item) => item.commandId === binding.commandId)?.outcome ===
          'completed',
      timeoutMs,
    );
    assert.equal(
      rpc('native.session.workspace.read', { ...pinned(), path: marker }).content.trim(),
      token,
    );
    if (resourceRoot) {
      assert.equal(remote, false, 'Resource fixture files must be on this validation host');
      assert.ok(
        path.resolve(resourceRoot).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      fs.mkdirSync(resourceRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(resourceRoot, 'worker.json'),
        JSON.stringify({ pid: initial.session.processPid }),
        { mode: 0o600 },
      );
      assert.equal(rpc('resource.control', { slotId, resourceId, action: 'boot' }).ok, true);
      resourceBefore = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'state.json'), 'utf8'));
    }
    const selector = { kind: 'include', runIds: [runId] };
    const preview = rpc('machine.pause.preview', {
      machine: slot.machine,
      mode: 'release',
      selector,
    });
    const row = preview.runs.find((item) => item.runId === runId);
    assert.equal(row?.eligibility.eligible, true, row?.eligibility.reason);
    const pauseParams = {
      machine: slot.machine,
      mode: 'release',
      previewId: preview.previewId,
      reviewedTargets: [{ runId, generation: row.generation }],
      operationId: `native-park-${randomUUID()}`,
    };
    const paused = rpc('machine.pause.execute', pauseParams);
    assert.equal(paused.ok, true, JSON.stringify(paused.records));
    assert.equal(rpc('machine.pause.execute', pauseParams).ok, true);
    const parked = rpc('machine.pause.status', { machine: slot.machine }).records.find(
      (item) => item.runId === runId,
    );
    report.parked = parked;
    assert.equal(parked.phase, 'parked');
    assert.ok(
      parked.resourceManifest.resources.length > 0,
      'Parking proof requires a real running resource',
    );
    assert.equal(parked.recoveryHandle.version, 2);
    assert.equal(parked.recoveryHandle.target, undefined);
    assert.equal(parked.recoveryHandle.ownerPrincipalId, binding.ownerPrincipalId);
    assert.equal(parked.recoveryHandle.leaseId, binding.leaseId);
    assert.equal(parked.recoveryHandle.cwd, initial.session.cwd);
    assert.equal(parked.recoveryHandle.sessionId, initial.session.nativeSessionId);
    assert.equal(read().session.processStopped, true);
    assert.equal(read().commands.length, initial.commands.length);
    assert.equal(
      rpc('fleet.status').fleet.slots.find((item) => item.slot === slotId).currentRunId,
      runId,
    );
    const stoppedHealth = rpc('resource.health', { slotId }).resources;
    for (const resource of parked.resourceManifest.resources) {
      const expected = resource.releaseEffect === 'retain' ? 'running' : 'stopped';
      assert.equal(
        parked.residuals.resources.find((item) => item.resourceId === resource.resourceId)?.state,
        expected,
      );
      const live = stoppedHealth.find((item) => item.id === resource.resourceId);
      if (expected === 'running') assert.equal(live?.status, 'running');
      else assert.notEqual(live?.status, 'running');
    }
    const worker = {
      runId,
      contextId: context.id,
      generation: binding.generation,
      leaseId: binding.leaseId,
    };
    assert.throws(
      () =>
        rpc('native.session.send', {
          ...target,
          worker,
          commandId: randomUUID(),
          text: 'Must refuse parked input',
        }),
      /"ok":false/,
    );
    report.checks.push(
      'Release persists exact native ownership, stops its process, applies resource release policy and refuses parked input',
    );
    const restorePreview = rpc('machine.pause.restore', { machine: slot.machine, selector });
    const restoreRow = restorePreview.runs.find((item) => item.runId === runId);
    assert.equal(restoreRow?.eligibility.eligible, true, restoreRow?.eligibility.reason);
    const restoreParams = {
      machine: slot.machine,
      selector,
      execute: true,
      previewId: restorePreview.previewId,
      reviewedTargets: [{ runId, generation: restoreRow.generation }],
      operationId: `native-restore-${randomUUID()}`,
    };
    const result = rpc('machine.pause.restore', restoreParams, timeoutMs);
    assert.equal(result.ok, true, JSON.stringify(result.records));
    assert.equal(rpc('machine.pause.restore', restoreParams).ok, true);
    const restored = await wait(
      read,
      (snapshot) =>
        snapshot.session.state === 'idle' &&
        snapshot.commands.length === initial.commands.length + 1 &&
        snapshot.commands.at(-1).outcome === 'completed',
      timeoutMs,
    );
    const finalRun = rpc('run.get', { runId }).run;
    report.restored = finalRun.park;
    assert.equal(finalRun.park.phase, 'restored');
    assert.equal(finalRun.park.recoveryProof.acknowledgement.kind, 'structured');
    assert.equal(restored.session.nativeSessionId, initial.session.nativeSessionId);
    assert.equal(restored.session.workerLeaseId, binding.leaseId);
    assert.notEqual(restored.session.generation, binding.generation);
    assert.equal(finalRun.slotId, slotId);
    const restoredHealth = rpc('resource.health', { slotId }).resources;
    for (const resource of parked.resourceManifest.resources)
      assert.equal(
        restoredHealth.find((item) => item.id === resource.resourceId)?.status,
        'running',
      );
    if (resourceRoot) {
      const resourceAfter = JSON.parse(
        fs.readFileSync(path.join(resourceRoot, 'state.json'), 'utf8'),
      );
      assert.equal(resourceAfter.id, resourceBefore.id);
      assert.notEqual(resourceAfter.pid, resourceBefore.pid);
      assert.equal(resourceAfter.starts, resourceBefore.starts + 1);
      fs.writeFileSync(
        path.join(resourceRoot, 'worker.json'),
        JSON.stringify({ pid: restored.session.processPid }),
        { mode: 0o600 },
      );
      report.resource = { before: resourceBefore, after: resourceAfter };
    }
    const continuation = restored.commands.at(-1);
    assert.equal(continuation.accepted, true);
    assert.equal(finalRun.park.recoveryProof.acknowledgement.turnToken, continuation.commandId);
    assert.throws(
      () =>
        rpc('native.session.send', {
          ...target,
          worker,
          commandId: randomUUID(),
          text: 'Must refuse old generation',
        }),
      /"ok":false/,
    );
    const memoryFile = `native-park-memory-${randomUUID()}.txt`;
    const commandId = randomUUID();
    rpc('native.session.send', {
      ...target,
      worker: { ...worker, generation: restored.session.generation },
      commandId,
      text: `Write ${memoryFile} containing the first task's token from conversation memory. Do not read the task or old marker. End the turn without a terminal signal.`,
    });
    await wait(
      read,
      (snapshot) =>
        snapshot.session.state === 'idle' &&
        snapshot.commands.find((item) => item.commandId === commandId)?.outcome === 'completed',
      timeoutMs,
    );
    assert.equal(
      rpc('native.session.workspace.read', { ...pinned(), path: memoryFile }).content.trim(),
      token,
    );
    report.checks.push(
      'Original-slot restore resumes the exact conversation with one accepted continuation, restores resources, rejects stale input and preserves memory',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    if (runId) {
      try {
        const cancelled = rpc('run.cancel', { runId });
        assert.ok(
          !cancelled.effects?.some((effect) => effect.status === 'failed'),
          JSON.stringify(cancelled.effects),
        );
        if (pinned) assert.equal(rpc('native.session.read', pinned()).session.processStopped, true);
        if (resourceRoot) {
          assert.equal(
            rpc('resource.control', { slotId, resourceId, action: 'shutdown' }).ok,
            true,
          );
          assert.equal(
            rpc('resource.health', { slotId }).resources.find((item) => item.id === resourceId)
              ?.status,
            'stopped',
          );
        }
        assert.equal(
          rpc('fleet.status').fleet.slots.find((item) => item.slot === slotId).currentRunId,
          null,
        );
        report.checks.push(
          'Cancellation cleans up the resumed process and releases fixture ownership',
        );
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.stack ?? String(error);
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
