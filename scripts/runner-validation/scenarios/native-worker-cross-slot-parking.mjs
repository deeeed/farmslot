import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-cross-slot-parking';

function privatePath(value) {
  const root = fs.realpathSync(path.join(ROOT, 'temp/native-validation'));
  assert.ok(path.resolve(value).startsWith(root + path.sep), 'Fault fixture must remain private');
  return value;
}

function checkedArchive(run) {
  const handle = run.park.recoveryHandle;
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'machine-park',
        run.id,
        run.park.createdAt,
        handle.leaseId,
        handle.generation,
      ]),
    )
    .digest('hex');
  return privatePath(path.join(handle.stateDirectory, 'parks', key, 'task'));
}

/** These are actual corrupted storage and colliding task files, never manufactured run state. */
async function archiveChecks({
  runId,
  before,
  destination,
  machine,
  selector,
  read,
  report,
  timeoutMs,
}) {
  const archive = checkedArchive(before);
  const preview = () => rpc('machine.pause.restore', { machine, selector });
  const unchanged = () => {
    const run = rpc('run.get', { runId }).run;
    assert.equal(run.slotId, before.slotId);
    assert.equal(run.park.phase, 'parked');
    assert.equal(read().session.processStopped, true);
    assert.ok(
      !rpc('fleet.status').fleet.slots.find((slot) => slot.slot === destination.slot).currentRunId,
    );
  };
  const missing = archive + '.missing-proof';
  assert.equal(fs.existsSync(missing), false);
  fs.renameSync(archive, missing);
  try {
    const result = preview();
    assert.equal(result.runs.find((row) => row.runId === runId).eligibility.eligible, false);
    unchanged();
    report.archiveMissing = result;
  } finally {
    fs.renameSync(missing, archive);
  }
  const file = path.join(archive, 'CHECKLIST.md');
  const bytes = fs.readFileSync(file);
  fs.appendFileSync(file, '\nDamaged private archive proof\n');
  try {
    const result = preview();
    const row = result.runs.find((row) => row.runId === runId);
    assert.equal(row.eligibility.eligible, false);
    assert.match(row.eligibility.reason, /integrity changed/);
    unchanged();
    report.archiveDamaged = result;
  } finally {
    fs.writeFileSync(file, bytes);
  }
  const restored = preview();
  assert.equal(restored.runs.find((row) => row.runId === runId).eligibility.eligible, true);
  const task = privatePath(
    path.join(destination.repo, before.park.recoveryHandle.taskBundle.relativeDirectory),
  );
  assert.equal(fs.existsSync(task), false, 'Collision fixture must not overwrite an existing task');
  fs.mkdirSync(task, { recursive: true });
  const sentinel = `other-task-${randomUUID()}`;
  fs.writeFileSync(path.join(task, 'TASK.md'), sentinel);
  try {
    const row = restored.runs.find((row) => row.runId === runId);
    const result = rpc(
      'machine.pause.restore',
      {
        machine,
        selector,
        execute: true,
        previewId: restored.previewId,
        reviewedTargets: [{ runId, generation: row.generation }],
        operationId: `native-collision-${randomUUID()}`,
      },
      timeoutMs,
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.records.some((record) =>
        record.errors.some((error) => error.message.includes('different task bundle')),
      ),
    );
    assert.equal(fs.readFileSync(path.join(task, 'TASK.md'), 'utf8'), sentinel);
    assert.equal(read().session.processStopped, true);
    report.destinationCollision = result;
  } finally {
    assert.equal(fs.readFileSync(path.join(task, 'TASK.md'), 'utf8'), sentinel);
    assert.deepEqual(fs.readdirSync(task), ['TASK.md']);
    fs.rmSync(task, { recursive: true });
  }
  const ready = preview();
  assert.equal(ready.runs.find((row) => row.runId === runId).eligibility.eligible, true);
  report.checks.push(
    'missing archive refused without claim',
    'damaged archive refused without claim',
    'restored archive became eligible',
    'destination task collision preserved existing data and stopped process',
    'collision removal permits recovery',
  );
}

function armReplyFault(binding, mode) {
  const config = privatePath(process.env.FARMSLOT_NATIVE_PARK_REPLY_FAULT);
  const gatewayPid = Number(process.env.FARMSLOT_NATIVE_PARK_GATEWAY_PID);
  assert.ok(Number.isSafeInteger(gatewayPid) && gatewayPid > 0);
  assert.ok(
    fs.existsSync(`${config}.${gatewayPid}.loaded`),
    'Exact live gateway must have the fault preload',
  );
  for (const suffix of ['', '.held', '.applied', '.release', '.released'])
    assert.equal(
      fs.existsSync(config + suffix),
      false,
      'Archive prior fault evidence before arming another operation',
    );
  fs.writeFileSync(config, JSON.stringify({ gatewayPid, sessionId: binding.sessionId, mode }), {
    mode: 0o600,
  });
  return config;
}

/** Requires a real native publication gate plus an independently dispatched terminal successor.
 * Run once with FARMSLOT_NATIVE_REHOME_STAGE=park, dispatch the successor through the gateway,
 * then run restore with the same run ID and FARMSLOT_NATIVE_REHOME_SUCCESSOR_RUN_ID.
 * The split permits a gateway restart between durable park and restore without fixture injection.
 */
export async function runScenario({ runnerAdapter, timeoutMs, outDir }) {
  const runId = process.env.FARMSLOT_NATIVE_REHOME_RUN_ID;
  const stage = process.env.FARMSLOT_NATIVE_REHOME_STAGE ?? 'restore';
  const report = {
    runner: runnerAdapter.RUNNER_ID,
    stage,
    runId,
    checks: [],
    pass: false,
    error: null,
  };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(runId, 'Supply an existing private native worker held at a publication gate');
    assert.ok(['park', 'restore', 'archive-checks', 'cancel-deferred'].includes(stage));
    const before = rpc('run.get', { runId }).run;
    assert.equal(before.transport, 'native');
    const context = before.agentContexts.find(
      (item) => item.nativeSession && !item.nativeSession.releasedAt,
    );
    const binding = context.nativeSession;
    assert.ok(binding.stateDirectory, 'New worker with stable native state is required');
    if (process.env.FARMSLOT_NATIVE_PARK_REQUIRE_PROFILE === '1')
      assert.ok(binding.profile, 'Explicit registered profile required');
    if (binding.profile) {
      assert.deepEqual(binding.profile, before.nativeProfile);
      report.profile = binding.profile;
    }
    const originalSlotId = before.park?.rehome?.fromSlotId ?? before.slotId;
    const slots = () => rpc('fleet.status').fleet.slots;
    const original = slots().find((item) => item.slot === originalSlotId);
    assert.ok(original);
    assert.ok(
      fs
        .realpathSync(original.repo)
        .startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
      'Use private local worktrees',
    );
    const pinned = () => pinnedWorkerTarget(runId, context.id, binding.leaseId);
    const read = () => rpc('native.session.read', pinned());
    if (stage === 'park') {
      assert.ok(
        before.steps.some((step) => step.name === 'human-gate' && step.status === 'running'),
        'Worker must reach its real publication gate',
      );
      const session = read().session;
      assert.equal(session.capabilities.resumeAcrossWorkspaces, true);
      const applied = rpc('runtime.posture.apply', {
        runId,
        gateChoice: 'free-slot',
        operationId: `native-rehome-park-${randomUUID()}`,
      });
      assert.equal(applied.ok, true, JSON.stringify(applied.transition?.rejection));
      const parked = rpc('run.get', { runId }).run.park;
      report.applied = applied;
      report.parked = parked;
      assert.equal(parked.phase, 'parked');
      assert.deepEqual(parked.recoveryHandle.profile, binding.profile);
      assert.equal(parked.slotDisposition, 'freed');
      assert.ok(parked.preservedWorkspace?.detachedAt);
      assert.equal(read().session.processStopped, true);
      assert.notEqual(slots().find((item) => item.slot === originalSlotId).currentRunId, runId);
      report.checks.push('gate choice stopped worker and preserved branch before releasing slot');
    } else {
      const successorId = process.env.FARMSLOT_NATIVE_REHOME_SUCCESSOR_RUN_ID;
      assert.ok(successorId, 'Supply the independently dispatched terminal successor run ID');
      const successor = rpc('run.get', { runId: successorId }).run;
      assert.notEqual(successor.transport, 'native');
      assert.equal(successor.slotId, originalSlotId);
      assert.equal(original.currentRunId, successorId);
      const successorTargets = successor.agentContexts.map((item) => item.target);
      assert.ok(
        successorTargets.some((target) => target?.paneId),
        'Successor must own a real terminal runner',
      );
      const record = before.park;
      assert.ok(
        ['parked', 'partial'].includes(record.phase),
        `Unexpected restore phase ${record.phase}`,
      );
      assert.equal(record.slotDisposition, 'freed');
      const selector = { kind: 'include', runIds: [runId] };
      const preview = rpc('machine.pause.restore', { machine: original.machine, selector });
      const entry = preview.runs.find((item) => item.runId === runId);
      assert.equal(entry.eligibility.eligible, true, entry.eligibility.reason);
      assert.notEqual(entry.restoreTarget.slotId, originalSlotId);
      const destination = slots().find((item) => item.slot === entry.restoreTarget.slotId);
      assert.equal(destination.machine, original.machine);
      assert.ok(
        fs
          .realpathSync(destination.repo)
          .startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
      );
      assert.equal(
        rpc('run.get', { runId }).run.slotId,
        before.slotId,
        'Preview must not move ownership',
      );
      if (stage === 'archive-checks') {
        await archiveChecks({
          runId,
          before,
          destination,
          machine: original.machine,
          selector,
          read,
          report,
          timeoutMs,
        });
        assert.equal(
          slots().find((slot) => slot.slot === originalSlotId).currentRunId,
          successorId,
        );
        report.pass = true;
        return {
          scenario: SCENARIO_ID,
          runner: report.runner,
          pass: true,
          report,
          outPath: writeEvidence(report, SCENARIO_ID, report.runner, outDir),
        };
      }
      const params = {
        machine: original.machine,
        selector,
        execute: true,
        previewId: preview.previewId,
        reviewedTargets: [{ runId, generation: entry.generation }],
        operationId: `native-rehome-restore-${randomUUID()}`,
      };
      let fault;
      if (process.env.FARMSLOT_NATIVE_PARK_REPLY_FAULT)
        fault = armReplyFault(
          binding,
          stage === 'cancel-deferred' ? 'defer-request' : 'fail-applied-reply',
        );
      let restored = rpc('machine.pause.restore', params, timeoutMs);
      if (fault) {
        assert.equal(restored.ok, false, 'The withheld reply must leave restore incomplete');
        report.uncertainRestore = restored;
        if (stage === 'cancel-deferred') {
          assert.ok(fs.existsSync(fault + '.held'));
          const held = JSON.parse(fs.readFileSync(fault + '.held', 'utf8'));
          const cancellation = rpc('run.cancel', { runId });
          report.cancellation = cancellation;
          fs.writeFileSync(fault + '.release', '');
          const applied = await wait(
            () =>
              fs.existsSync(fault + '.applied')
                ? JSON.parse(fs.readFileSync(fault + '.applied', 'utf8'))
                : null,
            Boolean,
            timeoutMs,
          );
          assert.match(applied.error ?? '', /cancelled before launch/);
          assert.equal(applied.commandId, held.commandId);
          const stopped = read().session;
          assert.equal(stopped.processStopped, true);
          assert.equal(stopped.generation, binding.generation);
          assert.equal(
            slots().find((slot) => slot.slot === originalSlotId).currentRunId,
            successorId,
          );
          report.deferredResume = applied;
          report.checks.push(
            'cancellation fenced delayed relocation before launch',
            'original stopped generation preserved',
            'terminal successor unchanged',
          );
          report.pass = true;
          return {
            scenario: SCENARIO_ID,
            runner: report.runner,
            pass: true,
            report,
            outPath: writeEvidence(report, SCENARIO_ID, report.runner, outDir),
          };
        }
        const applied = JSON.parse(fs.readFileSync(fault + '.applied', 'utf8'));
        assert.notEqual(applied.generation, binding.generation);
        assert.equal(applied.nativeSessionId, context.runnerSessionId);
        report.appliedResume = applied;
        fs.writeFileSync(fault + '.release', '');
        await wait(() => fs.existsSync(fault + '.released'), Boolean, timeoutMs);
        const retry = rpc('machine.pause.restore', { machine: original.machine, selector });
        const row = retry.runs.find((row) => row.runId === runId);
        assert.equal(row.eligibility.eligible, true, row.eligibility.reason);
        params.previewId = retry.previewId;
        params.reviewedTargets = [{ runId, generation: row.generation }];
        params.operationId = `native-rehome-reconcile-${randomUUID()}`;
        restored = rpc('machine.pause.restore', params, timeoutMs);
        assert.equal(
          read().session.generation,
          applied.generation,
          'Retry must retain the already launched process generation',
        );
        report.checks.push('lost-reply retry preserves the already launched process');
      }
      report.restored = restored;
      assert.equal(restored.ok, true, JSON.stringify(restored.records));
      assert.equal(
        rpc('machine.pause.restore', params).ok,
        true,
        'Retry must reconcile the same completed restore',
      );
      const after = rpc('run.get', { runId }).run;
      const moved = after.agentContexts.find((item) => item.id === context.id);
      assert.equal(after.slotId, destination.slot);
      assert.equal(moved.slotId, destination.slot);
      assert.equal(moved.target, null);
      assert.equal(moved.nativeSession.sessionId, binding.sessionId);
      assert.equal(moved.nativeSession.leaseId, binding.leaseId);
      assert.equal(moved.nativeSession.stateDirectory, binding.stateDirectory);
      assert.equal(moved.nativeSession.launchDigest, binding.launchDigest);
      assert.deepEqual(moved.nativeSession.profile, binding.profile);
      assert.deepEqual(after.park.recoveryHandle.profile, binding.profile);
      assert.notEqual(moved.nativeSession.generation, binding.generation);
      assert.equal(after.park.recoveryProof.sessionId, context.runnerSessionId);
      const commandId = after.park.recoveryProof.acknowledgement.turnToken;
      const continued = await wait(
        read,
        (snapshot) =>
          snapshot.session.state === 'idle' &&
          snapshot.commands.some(
            (command) => command.commandId === commandId && command.outcome === 'completed',
          ),
        timeoutMs,
      );
      report.continuation = {
        sessionId: continued.session.id,
        nativeSessionId: continued.session.nativeSessionId,
        generation: continued.session.generation,
        processPid: continued.session.processPid,
        cwd: continued.session.cwd,
        workerLeaseId: continued.session.workerLeaseId,
        profileId: continued.session.profileId,
        accountContextId: continued.session.accountContextId,
        command: continued.commands.find((command) => command.commandId === commandId),
      };
      assert.equal(continued.session.nativeSessionId, context.runnerSessionId);
      if (binding.profile) {
        assert.equal(continued.session.profileId, binding.profile.profileId);
        assert.equal(continued.session.accountContextId, binding.profile.accountContextId);
        report.checks.push('registered profile identity survived saved-session relocation');
      }
      assert.equal(continued.session.cwd, fs.realpathSync(destination.repo));
      assert.equal(
        continued.commands.filter((command) => command.commandId === commandId && command.accepted)
          .length,
        1,
      );
      assert.throws(() =>
        rpc('native.session.send', {
          sessionId: binding.sessionId,
          executionNodeId: binding.executionNodeId,
          worker: {
            runId,
            contextId: context.id,
            generation: binding.generation,
            leaseId: binding.leaseId,
          },
          commandId: randomUUID(),
          text: 'Stale source generation must be refused',
        }),
      );
      assert.equal(slots().find((item) => item.slot === originalSlotId).currentRunId, successorId);
      assert.deepEqual(
        rpc('run.get', { runId: successorId }).run.agentContexts.map((item) => item.target),
        successorTargets,
      );
      report.checks.push(
        'preview preserved source',
        'same saved session/account/lease moved to sibling workspace',
        'single accepted continuation',
        'stale source generation refused',
        'terminal successor retained ownership and pane',
      );
      // A run's original prompt should contain a unique private nonce supplied before parking.
      // It must not be included in this question, so the file proves conversation recall.
      const nonce = process.env.FARMSLOT_NATIVE_REHOME_MEMORY;
      assert.ok(nonce, 'Supply the nonce taught before parking');
      const filename = `native-relocation-memory-${randomUUID()}.txt`;
      const question = randomUUID();
      rpc('native.session.send', {
        ...pinned(),
        commandId: question,
        text: `Write the private relocation nonce from our earlier conversation into ${filename} in the current working directory. Do not inspect other files for it. Do not change any other file or send a terminal task signal.`,
      });
      await wait(
        read,
        (snapshot) =>
          snapshot.session.state === 'idle' &&
          snapshot.commands.some(
            (command) =>
              command.commandId === question && command.accepted && command.outcome === 'completed',
          ),
        timeoutMs,
      );
      assert.equal(
        rpc('native.session.workspace.read', { ...pinned(), path: filename }).content.trim(),
        nonce,
      );
      assert.equal(fs.existsSync(path.join(original.repo, filename)), false);
      report.memoryProof = {
        filename,
        commandId: question,
        destinationSlotId: destination.slot,
        nonceSha256: createHash('sha256').update(nonce).digest('hex'),
        sourceFileAbsent: true,
        command: read().commands.find((command) => command.commandId === question),
      };
      report.checks.push('saved memory produced a file only in destination workspace');
    }
    report.pass = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
  }
  return {
    scenario: SCENARIO_ID,
    runner: report.runner,
    pass: report.pass,
    report,
    outPath: writeEvidence(report, SCENARIO_ID, report.runner, outDir),
    ...(report.error ? { error: report.error } : {}),
  };
}
