// @farmslot:serial — snapshots, overwrites, and restores the shared root `.farm-status.json`.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { Events, type RunDecision } from '@farmslot/protocol';

import {
  addItem,
  claimQueueItem,
  getQueueSnapshot,
  removeQueueItemInternal,
  stampQueueItemRunId,
} from '../../backlog/dispatch-queue.js';
import { statusFile } from '../../core/state.js';
import { cancelRunEngine } from '../../run-engine/orchestrator.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runForceComplete } from './lifecycle-control.js';
import {
  freshDispatchEngineStateForReplay,
  replaySlotReclaimCheck,
  runReplayStep,
} from './replay-step.js';

test('fresh dispatch replay drops only retained-handoff flags', () => {
  assert.deepEqual(
    freshDispatchEngineStateForReplay(
      {
        flags: {
          skipPrepare: true,
          warmSessionReuse: true,
          warmHandoffSucceeded: false,
        },
        generation: 2,
      },
      true,
    ),
    { flags: { skipPrepare: true }, generation: 2 },
  );
});

test('runReplayStep abandons a retained handoff and re-enters normal dispatch', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const taskFile = '/tmp/farmslot-fresh-dispatch/TASK.md';
  await writeFile(
    statusFile,
    `${JSON.stringify({
      slots: [{ slot: 'macwork-ff-fresh-dispatch', lifecycle: 'busy', current_run_id: run.id }],
    })}\n`,
  );
  updateRun(run.id, {
    status: 'failed',
    error: 'Retained runner handoff was not acknowledged',
    slotId: 'macwork-ff-fresh-dispatch',
    taskFile,
    engineState: {
      generation: 2,
      flags: {
        skipPrepare: true,
        warmSessionReuse: true,
        warmHandoffSucceeded: false,
      },
    },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' || step.name === 'write-task' || step.name === 'prepare'
        ? {
            ...step,
            status: 'done',
            outputs: step.name === 'write-task' ? { taskFile } : step.outputs,
          }
        : step.name === 'dispatch'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const replayed = await runReplayStep(
    {
      runId: run.id,
      stepName: 'dispatch',
      freshDispatch: true,
      triggeredBy: 'operator',
    },
    () => {},
  );

  assert.equal(replayed.run.status, 'dispatching');
  assert.equal(replayed.run.error, undefined);
  assert.equal(replayed.run.engineState?.flags?.warmSessionReuse, undefined);
  assert.equal(replayed.run.engineState?.flags?.warmHandoffSucceeded, undefined);
  assert.equal(replayed.run.engineState?.flags?.skipPrepare, undefined);
  assert.equal(replayed.run.steps.find((step) => step.name === 'dispatch')?.status, 'pending');
});

test('replaySlotReclaimCheck rejects slots owned by another active run', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'run-b', lifecycle: 'busy' }, 'run-a'),
    {
      ok: false,
      reason: 'owned-by-other',
      owner: 'run-b',
    },
  );
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'run-a', lifecycle: 'busy' }, 'run-a'),
    {
      ok: true,
    },
  );
  assert.deepEqual(replaySlotReclaimCheck({ current_run_id: null, lifecycle: 'ready' }, 'run-a'), {
    ok: true,
  });
  assert.deepEqual(replaySlotReclaimCheck({ current_run_id: null, lifecycle: 'busy' }, 'run-a'), {
    ok: false,
    reason: 'not-reclaimable',
    lifecycle: 'busy',
  });
});

test('replaySlotReclaimCheck refuses a slot reserved for a foreign handoff', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ lifecycle: 'busy', handoff_run_id: 'other-run' }, 'run-1'),
    { ok: false, reason: 'owned-by-other', owner: 'other-run' },
  );
  // The reservation holder itself may proceed to the normal owner checks.
  assert.deepEqual(
    replaySlotReclaimCheck({ lifecycle: 'ready', handoff_run_id: 'run-1' }, 'run-1'),
    { ok: true },
  );
});

test('replaySlotReclaimCheck refuses a slot mid-release even for its own run id', () => {
  assert.deepEqual(
    replaySlotReclaimCheck(
      { phase: 'releasing', lifecycle: 'busy', current_run_id: 'run-1' },
      'run-1',
    ),
    { ok: false, reason: 'not-reclaimable', lifecycle: 'busy/releasing' },
  );
});

test('replaySlotReclaimCheck allows reclaim when slot owner run record is missing', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'ghost-run', lifecycle: 'busy' }, 'run-a', {
      ownerRunExists: () => false,
    }),
    { ok: true },
  );
});

test('in-flight replay refuses revive after operator force-complete', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-2585',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      backlogReconcilePending: undefined,
    });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'self-review exhausted',
    engineState: { generation: 2 },
    steps: run.steps.map((step) =>
      step.name === 'self-review'
        ? { ...step, status: 'failed' }
        : step.name === 'complete' ||
            step.name === 'human-gate' ||
            step.name === 'finalize' ||
            step.name === 'ci-watch'
          ? { ...step, status: 'skipped' }
          : { ...step, status: 'done' },
    ),
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let replayEntered = false;
  const replay = runReplayStep({ runId: run.id, stepName: 'self-review' }, () => {}, {
    afterGenerationBump: async () => {
      replayEntered = true;
      await held;
    },
  });
  while (!replayEntered) {
    await Promise.race([
      new Promise<void>((resolve) => setImmediate(resolve)),
      replay.then(
        () => {
          throw new Error('replay finished before generation-bump hook');
        },
        (err: unknown) => {
          throw err;
        },
      ),
    ]);
  }

  const completed = await runForceComplete({ runId: run.id, prNumber: 35145 }, () => {});
  assert.equal(completed.run.status, 'done');
  const forceGen = completed.run.engineState?.generation;
  release();
  await assert.rejects(replay, /force-completed and cannot be replayed/);
  const stored = getRun(run.id)!;
  assert.equal(stored.status, 'done');
  assert.equal(stored.engineState?.generation, forceGen);
  assert.equal(stored.steps.find((step) => step.name === 'self-review')?.status, 'skipped');
});

test('runReplayStep refuses a force-completed run before mutating', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-2586',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      backlogReconcilePending: undefined,
    });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'self-review exhausted',
    engineState: { generation: 2 },
  });
  await runForceComplete({ runId: run.id, prNumber: 35145 }, () => {});
  const generation = getRun(run.id)!.engineState?.generation;
  let bumpHook = false;
  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'self-review' }, () => {}, {
        afterGenerationBump: async () => {
          bumpHook = true;
        },
      }),
    /force-completed and cannot be replayed/,
  );
  assert.equal(bumpHook, false);
  assert.equal(getRun(run.id)?.engineState?.generation, generation);
});

test('runReplayStep still allows an ordinary done run', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-2587',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      backlogReconcilePending: undefined,
    });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    metrics: { ...run.metrics, outcome: 'success' },
    engineState: { generation: 4 },
    steps: run.steps.map((step) =>
      step.name === 'finalize' || step.name === 'ci-watch'
        ? { ...step, status: 'pending' }
        : { ...step, status: 'done' },
    ),
  });
  const result = await runReplayStep({ runId: run.id, stepName: 'finalize' }, () => {});
  assert.notEqual(result.run.status, 'done');
  assert.equal(result.run.engineState?.operatorForceCompleted, undefined);
});

test('runReplayStep rejects read-only imported reference runs', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `REF-${Date.now()}`,
  });
  updateRun(run.id, { readOnly: true, status: 'done' });
  t.after(async () => {
    if (getRun(run.id)) {
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'prepare' }, () => {}),
    /read-only imported reference and cannot be replayed/,
  );
});

test('replaying a cancelled graph run reclaims the node instead of double-dispatching', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4102',
    prNumber: 4102,
    workGraphId: 'wg_replay_reclaim',
    workNodeId: 'wn_replay_reclaim',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: 'Cancelled by user',
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  // Cancelling releases the node, so the scheduler re-queues its work. That queue
  // item must not survive the run being revived, or the node dispatches twice.
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4102',
      workGraphId: 'wg_replay_reclaim',
      workNodeId: 'wn_replay_reclaim',
    },
    { kind: 'system' },
  );
  assert.ok(
    getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_reclaim'),
    'precondition: the graph has re-queued the node',
  );

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  assert.ok(
    !getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_reclaim'),
    'the duplicate queue item was reclaimed by the revived run',
  );
});

test('a replay that fails validation leaves the re-queued node intact', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4103',
    prNumber: 4103,
    workGraphId: 'wg_replay_strand',
    workNodeId: 'wn_replay_strand',
  });
  updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4103',
      workGraphId: 'wg_replay_strand',
      workNodeId: 'wn_replay_strand',
    },
    { kind: 'system' },
  );

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  // Fails on an unknown step, after the old reclaim point but before the run revives.
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'not-a-step' }, () => {}),
    /Step not found: not-a-step/,
  );
  // The run never went live, so its replacement work must still be queued.
  assert.equal(getRun(run.id)?.status, 'cancelled');
  assert.ok(
    getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_strand'),
    'a failed replay must not strand the node by dropping its queue item',
  );
});

test('replay revokes a claimed dispatching row and revives the cancelled run', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104',
    prNumber: 4104,
    workGraphId: 'wg_replay_handoff',
    workNodeId: 'wn_replay_handoff',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4104',
      workGraphId: 'wg_replay_handoff',
      workNodeId: 'wn_replay_handoff',
    },
    { kind: 'system' },
  );
  // Claim through the public API (not a direct status mutate) so holder/epoch
  // persistence matches production. Replay must revoke it and revive the run.
  const staged = getQueueSnapshot().find((item) => item.workNodeId === 'wn_replay_handoff');
  assert.ok(staged);
  const claim = claimQueueItem(staged.id, 'stale-dispatcher');
  assert.ok(claim);

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  assert.ok(
    !getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_handoff'),
    'claimed replacement row was reclaimed',
  );
});

test('replay refuses when a live Run owns the node even without a queue row', async (t) => {
  const cancelled = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-live-owner',
    prNumber: 4104,
    workGraphId: 'wg_replay_live_owner',
    workNodeId: 'wn_replay_live_owner',
  });
  updateRun(cancelled.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  const genBefore = getRun(cancelled.id)?.engineState?.generation ?? 0;
  const stepsBefore = getRun(cancelled.id)
    ?.steps.map((s) => s.status)
    .join(',');
  // Successful handoff already dropped the queue row; a later replacement Run is live.
  const live = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-live-owner',
    prNumber: 4104,
    workGraphId: 'wg_replay_live_owner',
    workNodeId: 'wn_replay_live_owner',
  });

  t.after(async () => {
    for (const id of [cancelled.id, live.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'cancelled', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await assert.rejects(
    () =>
      runReplayStep(
        { runId: cancelled.id, stepName: 'ci-watch', triggeredBy: 'operator' },
        () => {},
      ),
    /already owned by live run/,
  );
  assert.equal(getRun(cancelled.id)?.status, 'cancelled');
  assert.equal(getRun(live.id)?.status, 'created');
  // Rejection must not mutate the cancelled run (generation / step reset).
  assert.equal(getRun(cancelled.id)?.engineState?.generation ?? 0, genBefore);
  assert.equal(
    getRun(cancelled.id)
      ?.steps.map((s) => s.status)
      .join(','),
    stepsBefore,
  );
  assert.equal(getRun(cancelled.id)?.recoveryProposal, undefined);
});

test('replay refuses when replacement row already has a stamped runId', async (t) => {
  const cancelled = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-stamped',
    prNumber: 4104,
    workGraphId: 'wg_replay_stamped',
    workNodeId: 'wn_replay_stamped',
  });
  updateRun(cancelled.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4104-stamped',
      workGraphId: 'wg_replay_stamped',
      workNodeId: 'wn_replay_stamped',
    },
    { kind: 'system' },
  );
  const staged = getQueueSnapshot().find((item) => item.workNodeId === 'wn_replay_stamped');
  assert.ok(staged);
  const claim = claimQueueItem(staged.id, 'dispatcher');
  assert.ok(claim);
  const handedOff = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-stamped',
    prNumber: 4104,
    workGraphId: 'wg_replay_stamped',
    workNodeId: 'wn_replay_stamped',
  });
  stampQueueItemRunId(claim.itemId, handedOff.id);

  t.after(async () => {
    for (const id of [cancelled.id, handedOff.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'cancelled', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
    const leftover = getQueueSnapshot().find((item) => item.workNodeId === 'wn_replay_stamped');
    if (leftover) {
      removeQueueItemInternal(leftover.id, 'test-cleanup');
    }
  });

  await assert.rejects(
    () =>
      runReplayStep(
        { runId: cancelled.id, stepName: 'ci-watch', triggeredBy: 'operator' },
        () => {},
      ),
    // Live owner check (no queue required) or stamped-row check both refuse.
    /already owned by live run|redispatched to run/,
  );
  assert.equal(getRun(cancelled.id)?.status, 'cancelled');
  assert.ok(getRun(handedOff.id));
});

test('replay does not reclaim a sibling launch-plan candidate sharing the node', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4105',
    prNumber: 4105,
    workGraphId: 'wg_replay_sibling',
    workNodeId: 'wn_replay_sibling',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  // Comparison candidates are built with the baseline's graph and node ids, so a
  // graph/node-only reclaim would delete this row — and the candidate projection
  // would keep the dead queue id, so the work never comes back.
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4105',
      workGraphId: 'wg_replay_sibling',
      workNodeId: 'wn_replay_sibling',
      launchPlanId: 'lp_1',
      launchCandidateId: 'cand_comparison',
    },
    { kind: 'system' },
  );

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  assert.ok(
    getQueueSnapshot().some((item) => item.launchCandidateId === 'cand_comparison'),
    'the comparison candidate must survive the baseline being replayed',
  );
});

test('replay does not reclaim a replacement plan reusing the same candidate id', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4106',
    prNumber: 4106,
    workGraphId: 'wg_replay_plan',
    workNodeId: 'wn_replay_plan',
    launchPlanId: 'lp_superseded',
    launchCandidateId: 'cand_shared',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  // Candidate ids are scoped to their plan (launchCandidateKey keys on
  // [backlogItemId, launchPlanId, candidateId]), so a replacement plan may reuse
  // one. This row belongs to the CURRENT plan and must not be taken by a run from
  // the superseded plan — the current plan would keep a dead queue id, and the
  // revived run's observations are rejected as foreign-plan.
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4106',
      workGraphId: 'wg_replay_plan',
      workNodeId: 'wn_replay_plan',
      launchPlanId: 'lp_current',
      launchCandidateId: 'cand_shared',
    },
    { kind: 'system' },
  );

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.ok(
    getQueueSnapshot().some((item) => item.launchPlanId === 'lp_current'),
    "the current plan's work must survive a replay from the superseded plan",
  );
});

test('runReplayStep rejects monitor replay when dispatch is still running', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'dispatching',
    slotId: 'macwork-ff-1',
    steps: run.steps.map((step) =>
      step.name === 'write-task' || step.name === 'find-slot' || step.name === 'prepare'
        ? { ...step, status: 'done' }
        : step.name === 'dispatch'
          ? { ...step, status: 'running', startedAt: new Date().toISOString() }
          : step,
    ),
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {}),
    /dispatch has not completed/,
  );
});

test('runReplayStep rejects non-authorized triggeredBy actor before replay', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'llm' as any }, () => {}),
    /Invalid runReplayStep triggeredBy/,
  );
});

test('runReplayStep does not open a recovery attempt before replay validation passes', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Math.floor(Date.now() / 1000)}`,
  });
  const badTicketRun = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `not-a-ticket-${Date.now()}`,
  });
  const events: any[] = [];
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
    if (getRun(badTicketRun.id)) {
      updateRun(badTicketRun.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(badTicketRun.id);
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'not-a-step' }, (event, payload) =>
        events.push({ event, payload }),
      ),
    /Step not found: not-a-step/,
  );

  assert.equal(events.length, 0);
  assert.equal(getRun(run.id)?.recoveryProposal?.status, undefined);
  assert.equal(getRun(run.id)?.recoveryAttempts?.length ?? 0, 0);

  await assert.rejects(
    () =>
      runReplayStep({ runId: badTicketRun.id, stepName: 'prepare' }, (event, payload) =>
        events.push({ event, payload }),
      ),
    /Cannot replay run:/,
  );
  assert.equal(events.length, 0);
  assert.equal(getRun(badTicketRun.id)?.recoveryProposal?.status, undefined);
  assert.equal(getRun(badTicketRun.id)?.recoveryAttempts?.length ?? 0, 0);
});

test('runReplayStep allows prepare replay for backlog-dispatched MANUAL-* runs', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    backlogItemId: 'backlog-item-1',
  });
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-1', lifecycle: 'busy', current_run_id: run.id }] },
      null,
      2,
    ) + '\n',
  );
  updateRun(run.id, {
    status: 'failed',
    slotId: 'macwork-ff-1',
    taskFile: '/tmp/farmslot-task/TASK.md',
    steps: run.steps.map((step) =>
      step.name === 'find-slot' || step.name === 'write-task'
        ? { ...step, status: 'done', completedAt: new Date().toISOString() }
        : step.name === 'prepare'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'preparing');
});

test('runReplayStep still rejects MANUAL-* replay without backlogItemId', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep still rejects PR-bound replays without a linked prNumber', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep still rejects write-task replay for chained PR-bound runs with Jira ticketOrPr', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
    prNumber: 3398,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep allows chained PR-bound replays when prNumber is already linked', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
    prNumber: 3398,
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: 'Cancelled by user',
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
});

test('runReplayStep restores taskFile from completed write-task output for downstream replays', async (t) => {
  const taskFile = '/tmp/farmslot-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'No task file specified',
    taskFile: null,
    steps: run.steps.map((step) =>
      step.name === 'write-task'
        ? { ...step, status: 'done', outputs: { taskFile } }
        : step.name === 'prepare'
          ? { ...step, status: 'done' }
          : step.name === 'dispatch'
            ? { ...step, status: 'failed' }
            : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' }, () => {});

  assert.equal(getRun(run.id)?.taskFile, taskFile);
});

test('runReplayStep moves terminal runs back to the active replay phase immediately', async (t) => {
  const taskFile = '/tmp/farmslot-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'dispatch failed',
    taskFile,
    steps: run.steps.map((step) =>
      step.name === 'write-task' || step.name === 'prepare'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'dispatch'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });
  const emittedStatuses: string[] = [];

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' },
    (event, payload) => {
      if (event === Events.RUN_UPDATED) {
        emittedStatuses.push((payload as { run: { status: string } }).run.status);
      }
    },
  );

  assert.equal(emittedStatuses[0], 'dispatching');
});

test('runReplayStep normalizes stale earlier steps when replaying from a later step', async (t) => {
  const taskFile = '/tmp/farmslot-stale-monitor-task/TASK.md';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'blocked',
    error: 'monitor timed out',
    taskFile,
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'monitor'
          ? { ...step, status: 'running', startedAt: '2026-06-22T12:00:00.000Z' }
          : step.name === 'self-review'
            ? { ...step, status: 'failed', detail: 'retry requested' }
            : step,
    ),
  });
  const emittedStatuses: string[] = [];

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'self-review', triggeredBy: 'operator' },
    (event, payload) => {
      if (event === Events.RUN_UPDATED) {
        emittedStatuses.push((payload as { run: { status: string } }).run.status);
      }
    },
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.steps.find((step) => step.name === 'monitor')?.status, 'done');
  assert.equal(
    replayed.steps.find((step) => step.name === 'monitor')?.outputs?.replayPrerequisiteNormalized,
    true,
  );
  assert.equal(replayed.steps.find((step) => step.name === 'self-review')?.status, 'running');
  assert.equal(emittedStatuses[0], 'self-reviewing');
});

test('runReplayStep can replace an exhausted runner before self-review', async (t) => {
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const taskFile = '/tmp/farmslot-runner-replacement/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    runner: 'grok',
    model: 'grok-4.6',
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    metrics: {
      ...run.metrics,
      runner: 'grok',
      model: 'grok-4.6',
      runnerSessionId: 'old-grok-session',
      runnerSessionPath: '/tmp/old-grok-session',
    },
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Bugfix',
        status: 'blocked',
        slotId: 'mini-mm-2',
        runId: run.id,
        runner: 'grok',
        model: 'grok-4.6',
        runnerSessionId: 'old-grok-session',
        runnerSessionPath: '/tmp/old-grok-session',
      },
    ],
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch' ||
      step.name === 'monitor'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'self-review'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await runReplayStep(
    {
      runId: run.id,
      stepName: 'self-review',
      runner: 'claude',
      model: 'opus',
      triggeredBy: 'operator',
    },
    () => {},
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.metrics.runner, 'claude');
  assert.equal(replayed.metrics.model, 'opus');
  assert.equal(replayed.metrics.runnerSessionId, null);
  assert.equal(replayed.metrics.runnerSessionPath, null);
  const workerContext = replayed.agentContexts?.find((context) => context.role === 'fix-bug');
  assert.equal(workerContext?.runner, 'claude');
  assert.equal(workerContext?.model, 'opus');
  assert.equal(workerContext?.runnerSessionId, null);
  assert.equal(workerContext?.runnerSessionPath, null);
  assert.equal(replayed.status, 'self-reviewing');
  assert.equal(replayed.steps.find((step) => step.name === 'self-review')?.status, 'pending');
});

test('runReplayStep rejects an incompatible runner/model override before mutation', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    runner: 'grok',
    model: 'grok-4.6',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const before = structuredClone(getRun(run.id));

  await assert.rejects(
    runReplayStep(
      {
        runId: run.id,
        stepName: 'self-review',
        runner: 'codex',
        model: 'opus',
      },
      () => {},
    ),
    /does not support model 'opus'/,
  );
  assert.deepEqual(getRun(run.id), before);
});

test('runReplayStep clears stale decisions when replaying task generation', async (t) => {
  const taskFile = '/tmp/farmslot-stale-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const staleDecision: RunDecision = {
    id: 'stale-recipe-strategy',
    type: 'engine_recipe_strategy',
    title: 'Stale recipe strategy',
    description: 'Old decision from a prior task generation',
    actions: [{ id: 'accept', label: 'Use recommended', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: { kind: 'recipe-strategy' } as any,
  };
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    executionTemplate: {
      id: 'fix-bug/default',
      sourceId: 'project:farmslot-farm',
      flow: 'fix-bug',
      platforms: ['*'],
      labels: [],
      relativePath: 'fix-bug.md',
      sha256: 'a'.repeat(64),
    },
    templateProvenance: {
      kind: 'task-template',
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      role: 'worker',
      templatePath: '/tmp/fix-bug.md',
      templateName: 'fix-bug.md',
      contentHash: 'a'.repeat(64),
      source: 'current-project',
      renderedAt: '2026-09-02T00:00:00.000Z',
    },
    decisions: [staleDecision],
    steps: run.steps.map((step) =>
      step.name === 'write-task' ? { ...step, status: 'failed', outputs: { taskFile } } : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.taskFile, null);
  assert.equal(replayed.executionTemplate, undefined);
  assert.equal(replayed.templateProvenance, undefined);
  assert.deepEqual(replayed.decisions, []);
});

test('runReplayStep clears stale publish approval when replaying human gate', async (t) => {
  const taskFile = '/tmp/farmslot-human-gate-task/TASK.md';
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const staleApproval: RunDecision = {
    id: 'stale-approve-publish',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Old approval from a prior gate generation',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:10:00.000Z',
    resolvedAction: 'approve-publish',
    payload: { kind: 'ready' } as any,
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
  ]);
  updateRun(run.id, {
    status: 'failed',
    taskFile,
    decisions: [staleApproval],
    engineState: {
      publishGate: {
        packageId: 'pkg-stale',
        packageHash: 'package-hash-stale',
        approvedPackageHash: 'package-hash-stale',
        approvedAt: '2026-04-15T00:10:00.000Z',
        publicationStatus: 'publish_failed',
        independentReviews: [],
        reviewRecovery: {
          status: 'operator-required',
          attempts: 3,
          startedAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:10:00.000Z',
          lastError: 'Reviewer result requires operator remediation',
        },
      },
    },
    steps: run.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate' || step.name === 'finalize'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    cancelRunEngine(run.id);
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(replayed.decisions, []);
  assert.equal(replayed.engineState?.publishGate?.publicationStatus, 'not_published');
  assert.equal(replayed.engineState?.publishGate?.approvedAt, undefined);
  assert.equal(replayed.engineState?.publishGate?.approvedPackageHash, undefined);
  assert.equal(replayed.engineState?.publishGate?.reviewRecovery, undefined);
});

test('runReplayStep supersedes a pending human-gate decision instead of deleting it', async (t) => {
  const taskFile = '/tmp/farmslot-human-gate-pending/TASK.md';
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const pendingGate: RunDecision = {
    id: 'pending-gate',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Pending decision owned by a dead engine loop',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-07-18T10:00:00.000Z',
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
  ]);
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    decisions: [pendingGate],
    metrics: {
      ...run.metrics,
      outcome: 'success',
      disposition: 'already_fixed',
      terminalEvidence: { reportPath: 'artifacts/no-change-report.md' },
    },
    steps: run.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  t.after(async () => {
    cancelRunEngine(run.id);
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  // Retained for audit and closed to concurrent resolution — deleting it both
  // destroyed the trail and let an operator resolve a decision the replayed
  // gate no longer owned.
  const superseded = replayed.decisions.find((d) => d.id === 'pending-gate');
  assert.ok(superseded, 'pending gate decision must be retained');
  assert.equal(superseded.resolvedAction, 'superseded');
  assert.ok(superseded.resolvedAt);
  assert.equal(superseded.context?.supersededBy, 'gate-reentry');
  assert.equal(replayed.metrics.outcome, 'success');
  assert.equal(replayed.metrics.disposition, 'already_fixed');
  assert.deepEqual(replayed.metrics.terminalEvidence, {
    reportPath: 'artifacts/no-change-report.md',
  });
});

test('runReplayStep supersedes pending gate decisions before its first awaited operation', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const taskFile = '/tmp/farmslot-human-gate-race/TASK.md';
  const slotOwner = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}1`,
  });
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}2`,
  });
  const pendingGate: RunDecision = {
    id: 'pending-gate-race',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Pending decision that must close before any await',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-07-18T10:00:00.000Z',
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
  ]);
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    slotId: 'macwork-ff-9',
    decisions: [pendingGate],
    steps: run.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  // The slot is owned by ANOTHER live run, so the replay's first awaited
  // operation — the slot re-claim — fails.
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-9', lifecycle: 'busy', current_run_id: slotOwner.id }] },
      null,
      2,
    ) + '\n',
  );
  t.after(async () => {
    cancelRunEngine(run.id);
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    for (const r of [run, slotOwner]) {
      if (getRun(r.id)) {
        updateRun(r.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(r.id);
      }
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {}),
    /no longer safely reclaimable/,
  );

  // Even though the replay died at its FIRST awaited operation, the pending
  // gate decision was already superseded — an operator resolving it during
  // the awaited window can no longer spawn a competing engine loop.
  const after = getRun(run.id);
  assert.ok(after);
  const superseded = after.decisions.find((d) => d.id === 'pending-gate-race');
  assert.ok(superseded);
  assert.equal(superseded.resolvedAction, 'superseded');
  assert.equal(superseded.context?.supersededBy, 'gate-reentry');
});

test('runReplayStep drops a stale monitor decision when replaying from prepare', async (t) => {
  const taskFile = '/tmp/farmslot-monitor-replay/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  // A monitor-owned handoff decision left unresolved from a prior generation.
  const staleHandoff: RunDecision = {
    id: 'stale-monitor-handoff',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Prior monitor run left this open',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' as const },
    ],
    createdAt: '2026-04-15T00:00:00.000Z',
  };
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    decisions: [staleHandoff],
    steps: run.steps.map((step) =>
      step.name === 'write-task' ? { ...step, status: 'done', outputs: { taskFile } } : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  // Monitor re-runs from a prepare replay, so its stale handoff must be cleared
  // instead of re-blocking the reset run.
  assert.equal(
    replayed.decisions.some((d) => d.id === 'stale-monitor-handoff'),
    false,
  );
});

test('runReplayStep forces eval worker replays through prepare to reinstall harness', async (t) => {
  const taskFile = '/tmp/farmslot-eval-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-replay-harness',
        experimentKey: 'experiment-key-replay-harness',
        experimentManifestPath: '/tmp/experiment-manifest.json',
        packagePath: '/tmp/candidate.result-package.json',
        candidateStrategyFingerprint: 'fingerprint-replay-harness',
        trialId: 'trial-replay-harness',
      },
    },
    steps: run.steps.map((step) =>
      step.name === 'write-task'
        ? { ...step, status: 'done', outputs: { taskFile } }
        : step.name === 'prepare' || step.name === 'dispatch'
          ? { ...step, status: 'done' }
          : step.name === 'monitor'
            ? { ...step, status: 'failed' }
            : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.taskFile, taskFile);
  assert.equal(replayed.steps.find((step) => step.name === 'write-task')?.status, 'done');
  assert.equal(replayed.steps.find((step) => step.name === 'prepare')?.status, 'pending');
  assert.equal(replayed.steps.find((step) => step.name === 'dispatch')?.status, 'pending');
  assert.equal(replayed.steps.find((step) => step.name === 'monitor')?.status, 'pending');
  assert.equal(replayed.recoveryAttempts?.at(-1)?.stepName, 'prepare');
});

test('runReplayStep restores skipPrepare for chained follow-ups when the flag was already cleared', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'prepare failed',
    engineState: { flags: { warmRecovery: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task' || step.name === 'prepare'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
  assert.equal(replayed.engineState?.flags?.warmRecovery, true);
});

test('runReplayStep clears skipPrepare when chained follow-up replays from find-slot', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'find-slot failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ? { ...step, status: 'failed' } : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, null);
  assert.equal(replayed.engineState?.flags?.skipPrepare, undefined);
});

test('runReplayStep preserves skipPrepare for review-pr chained follow-up replays', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'write-task failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
});

test('runReplayStep preserves skipPrepare for CI-watch chained follow-up replays', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'write-task failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
  assert.equal(replayed.engineState?.flags?.nudgeReuse, undefined);
});

test('runReplayStep preserves resolved publish approvals for post-gate publish retries', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const approvedDecision: RunDecision = {
    id: 'publish-gate',
    type: 'engine_human_gate',
    title: 'Approve publication',
    description: 'Approve publication',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:01:00.000Z',
    resolvedAction: 'approve-publish',
    payload: { kind: 'ready' } as any,
  };
  const pendingDecision: RunDecision = {
    ...approvedDecision,
    id: 'pending-followup',
    resolvedAt: undefined,
    resolvedAction: undefined,
  };
  updateRun(run.id, {
    status: 'failed',
    error: 'publish failed',
    decisions: [approvedDecision, pendingDecision],
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'finalize', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(
    replayed.decisions.map((decision) => decision.id),
    ['publish-gate', 'pending-followup'],
    'finalize replay should keep the resolved publish approval as well as unresolved decisions',
  );
});

test('runReplayStep keeps unresolved decisions for no-human-gate finalize retries', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
  });
  const resolvedDecision: RunDecision = {
    id: 'old-decision',
    type: 'engine_human_gate',
    title: 'Old decision',
    description: 'Old decision',
    actions: [{ id: 'ok', label: 'OK', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:01:00.000Z',
    resolvedAction: 'ok',
    payload: { kind: 'test' } as any,
  };
  const pendingDecision: RunDecision = {
    ...resolvedDecision,
    id: 'pending-decision',
    resolvedAt: undefined,
    resolvedAction: undefined,
  };
  updateRun(run.id, {
    status: 'failed',
    error: 'publish failed',
    decisions: [resolvedDecision, pendingDecision],
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'finalize', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(
    replayed.decisions.map((decision) => decision.id),
    ['pending-decision'],
    'no-human-gate finalize replay should not clear unresolved decisions by pretending there is a gate boundary',
  );
});

test('runReplayStep rejects monitor replay when dispatch is still pending', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'preparing',
    slotId: 'macwork-ff-4',
    taskFile: '/tmp/TASK.md',
    steps: run.steps.map((step) => {
      if (step.name === 'find-slot' || step.name === 'write-task' || step.name === 'prepare') {
        return { ...step, status: 'done' as const };
      }
      return step;
    }),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {}),
    /dispatch has not completed/,
  );
  assert.equal(getRun(run.id)?.slotId, 'macwork-ff-4');
});

test('runReplayStep preserves worker session state when replaying monitor only', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-4', lifecycle: 'ready', current_run_id: null }] },
      null,
      2,
    ) + '\n',
  );
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    runner: 'grok',
    model: 'grok-4.6',
  });
  updateRun(run.id, {
    status: 'failed',
    slotId: 'macwork-ff-4',
    taskFile: '/tmp/TASK.md',
    metrics: {
      ...run.metrics,
      runnerSessionId: 'preserved-session',
      runnerSessionPath: '/tmp/preserved-session',
    },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch'
        ? { ...step, status: 'done' as const }
        : step.name === 'monitor'
          ? { ...step, status: 'failed' as const }
          : step,
    ),
  });

  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.status, 'monitoring');
  assert.equal(replayed.metrics.runnerSessionId, 'preserved-session');
  assert.equal(replayed.metrics.runnerSessionPath, '/tmp/preserved-session');
});

test('runReplayStep recovers slotId from find-slot outputs on dispatch replay', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-4', lifecycle: 'ready', current_run_id: null }] },
      null,
      2,
    ) + '\n',
  );

  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'No slot assigned',
    slotId: null,
    taskFile: '/tmp/TASK.md',
    steps: run.steps.map((step) => {
      if (step.name === 'find-slot') {
        return {
          ...step,
          status: 'done' as const,
          outputs: { selectedSlot: 'macwork-ff-4', runner: 'grok', model: 'grok-build' },
        };
      }
      if (step.name === 'write-task' || step.name === 'prepare') {
        return { ...step, status: 'done' as const };
      }
      if (step.name === 'dispatch') {
        return { ...step, status: 'failed' as const, detail: 'No slot assigned' };
      }
      return step;
    }),
  });

  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'dispatch', skipPrepare: true, triggeredBy: 'operator' },
    () => {},
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, 'macwork-ff-4');
  assert.notEqual(replayed.steps.find((step) => step.name === 'dispatch')?.status, 'failed');
  cancelRunEngine(run.id);
});
