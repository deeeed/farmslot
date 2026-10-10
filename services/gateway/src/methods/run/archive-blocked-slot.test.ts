// @farmslot:serial — snapshots, overwrites, and restores the shared root `.farm-status.json`.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { PipelineSteps, type Run, type SlotReleaseParams } from '@farmslot/protocol';

import { assertReloadStillOwnsSlot, restoreTmuxWorker } from '../../agents/runtime-recovery.js';
import { readSlotField, updateSlotStatus } from '../../core/index.js';
import { statusFile } from '../../core/state.js';
import {
  beginRunArchive,
  endRunArchive,
  isRunArchiving,
} from '../../run-lifecycle/archive-fence.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { createRun, deleteRun, getRun, getRunWithArchived, updateRun } from '../../runs/store.js';
import { type SlotReleasePreflight, slotReleasePreflight } from '../slot/release.js';
import { detachRunsForReleasedSlot } from '../slot/release-run-ownership.js';

import { type ArchiveSlotRelease, runArchive } from './admin.js';
import { runAdopt } from './adopt.js';
import { rebindReleasedSlot, runReplayStep } from './replay-step.js';

// The real-release case resolves the committed demo pool's slot.
process.env.FARMSLOT_DEMO_POOL = '1';

const slotId = 'demo-work-1';
const noopEmit = () => {};

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

/** What a fleet refresh writes for a blocked run's slot: held, owned by the run. */
async function holdSlotFor(t: test.TestContext, runId: string, phase = 'pr-watch'): Promise<void> {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const data = priorStatus ? JSON.parse(priorStatus) : { slots: [] };
  const others = (data.slots ?? []).filter((row: { slot: string }) => row.slot !== slotId);
  const row = { slot: slotId, lifecycle: 'held', phase, current_run_id: runId };
  await writeFile(statusFile, JSON.stringify({ ...data, slots: [...others, row] }, null, 2) + '\n');
  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
  });
}

function blockedRun(t: test.TestContext, label: string, steps: Run['steps']): Run {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-${label}`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  return updateRun(run.id, { status: 'blocked', error: 'worker blocked', steps, decisions: [] });
}

const clean = { unmergedWork: null } as SlotReleasePreflight;

test('blocked archive authority permits only its owner-bound release preflight', async (t) => {
  const run = blockedRun(t, 'archive-owner-preflight', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  const params = { slotId, expectedRunId: run.id, keepWork: true };
  await assert.rejects(slotReleasePreflight(params), /non-terminal run/);
  beginRunArchive(run.id);
  try {
    await assert.rejects(slotReleasePreflight({ slotId, keepWork: true }), /non-terminal run/);
    // The demo fixture is the operator root. Passing the owner guard must still
    // reach and retain that independent destructive-operation refusal.
    await assert.rejects(slotReleasePreflight(params), /operator root/);
  } finally {
    endRunArchive(run.id);
  }
});

/** Stubbed release that ends where the real one does: slot ready, runs detached. */
function recordingSlot(preflight: SlotReleasePreflight | null = clean) {
  const calls = { preflight: 0, releases: [] as SlotReleaseParams[] };
  const slot: ArchiveSlotRelease = {
    preflight: async () => {
      calls.preflight += 1;
      return preflight;
    },
    release: async (params) => {
      calls.releases.push(params);
      await updateSlotStatus(params.slotId, { current_run_id: null, lifecycle: 'ready' });
      detachRunsForReleasedSlot(params.slotId, noopEmit, params.expectedRunId);
      return { released: true };
    },
  };
  return { calls, slot };
}

test('archiving a settled blocked run that holds its slot releases the slot first', async (t) => {
  const run = blockedRun(t, 'archive-release', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  // An explicit dispatch waiting in find-slot for this slot to come free.
  const waiter = blockedRun(t, 'archive-waiter', [{ name: 'find-slot', status: 'running' }]);
  updateRun(waiter.id, { status: 'slot-finding' });
  const { calls, slot } = recordingSlot();

  const result = await runArchive({ runId: run.id }, noopEmit, slot);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.releases, [{ slotId, expectedRunId: run.id }]);
  assert.equal(await readSlotField(slotId, 'current_run_id'), null);
  assert.equal(getRun(run.id), undefined, 'the blocked run is archived');
  const archived = await getRunWithArchived(run.id);
  assert.equal(archived?.status, 'blocked', 'archiving keeps the blocked outcome');
  assert.equal(archived?.slotId, null, 'the release detached the run from its slot');
  assert.equal(getRun(waiter.id)?.slotId, slotId, 'the waiting dispatch keeps its pick');
  assert.equal(isRunArchiving(run.id), false);
});

test('a slot release guard refusing refuses the archive with its reason', async (t) => {
  const run = blockedRun(t, 'archive-guard', [{ name: 'monitor', status: 'done' }]);
  // A publication gate held on the same slot: the real preflight refuses.
  const gated = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-archive-gate`,
    slotId,
  });
  t.after(() => cleanupRun(gated.id));
  updateRun(gated.id, {
    status: 'human-gating',
    steps: [
      { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
    ],
  });
  await holdSlotFor(t, run.id);

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit),
    new RegExp(`gate-held for run ${gated.id}`),
  );
  assert.equal(getRun(run.id)?.status, 'blocked', 'the run stays in the store, still blocked');
  assert.equal(getRun(run.id)?.slotId, slotId);
  assert.equal(await readSlotField(slotId, 'current_run_id'), run.id, 'slot still held');
  assert.equal(isRunArchiving(run.id), false);
});

test('unpushed work on the slot refuses the archive before the release touches the worker', async (t) => {
  const run = blockedRun(t, 'archive-unpushed', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  const before = structuredClone(getRun(run.id)!);
  const { calls, slot } = recordingSlot({
    ...clean,
    unmergedWork: { branch: 'PROJ-1-fix', details: '2 unpushed commits' },
  });

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit, slot),
    /slot demo-work-1 has work on 'PROJ-1-fix' \(2 unpushed commits\) that releasing it would lose/,
  );
  assert.equal(calls.releases.length, 0, 'the release (and its worker kill) never ran');
  assert.deepEqual(getRun(run.id), before, 'the run is unchanged');
  assert.equal(await readSlotField(slotId, 'current_run_id'), run.id, 'slot still held');
  assert.equal(await readSlotField(slotId, 'lifecycle'), 'held');
  assert.equal(isRunArchiving(run.id), false);
});

test('archiving a live blocked run keeps refusing without touching its slot', async (t) => {
  const run = blockedRun(t, 'archive-live', [{ name: 'human-gate', status: 'running' }]);
  await holdSlotFor(t, run.id);
  const { calls, slot } = recordingSlot();

  await assert.rejects(runArchive({ runId: run.id }, noopEmit, slot), /Cannot archive active run/);
  assert.equal(calls.preflight, 0);
  assert.equal(calls.releases.length, 0);
  assert.equal(await readSlotField(slotId, 'current_run_id'), run.id);
  assert.ok(getRun(run.id));
});

test('a resume admitted before the archive takes the run makes the archive back off', async (t) => {
  const run = blockedRun(t, 'archive-resumed', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  let finishResume!: () => void;
  const resumeMayFinish = new Promise<void>((resolve) => (finishResume = resolve));
  let resumeAdmitted!: () => void;
  const admitted = new Promise<void>((resolve) => (resumeAdmitted = resolve));
  // Stands in for Resume replaying the monitor under the run transition.
  const resume = withRunTransition(run.id, async () => {
    resumeAdmitted();
    await resumeMayFinish;
    updateRun(run.id, { status: 'monitoring', steps: [{ name: 'monitor', status: 'running' }] });
  });
  await admitted;
  const { calls, slot } = recordingSlot();

  // The archive passed its first checks and queues for the run transition the
  // resume holds; the resume lands first.
  const archive = runArchive({ runId: run.id }, noopEmit, slot);
  finishResume();
  await assert.rejects(archive, /no longer a settled blocked run \(status=monitoring\)/);
  assert.equal(calls.preflight, 0);
  await resume;
  assert.equal(calls.releases.length, 0, 'the resumed worker was never torn down');
  assert.equal(getRun(run.id)?.status, 'monitoring');
  assert.equal(await readSlotField(slotId, 'current_run_id'), run.id);
  assert.equal(isRunArchiving(run.id), false);
});

test('nothing can put a worker back on a run while its archive releases the slot', async (t) => {
  const run = blockedRun(t, 'archive-replay', [{ name: 'monitor', status: 'done' }]);
  updateRun(run.id, { taskFile: '/tmp/archive-replay/TASK.md' });
  await holdSlotFor(t, run.id);
  const { calls, slot } = recordingSlot();
  const release = slot.release;
  const refusals: Record<string, unknown> = {};
  const attempt = (name: string, action: () => Promise<unknown>) =>
    action()
      .then(() => assert.fail(`${name} must not start on a run being archived`))
      .catch((error: unknown) => (refusals[name] = error));
  slot.release = async (params, emit) => {
    // What the operator can click while the release copies artifacts.
    await attempt('replay', () =>
      runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, noopEmit),
    );
    await attempt('adopt', () => runAdopt({ runId: run.id, tmux: 'operator-shell' }, noopEmit));
    await attempt('reload', () =>
      restoreTmuxWorker({ slotId, runId: run.id, mode: 'reload-session' }),
    );
    return release(params, emit);
  };

  await runArchive({ runId: run.id }, noopEmit, slot);

  for (const name of ['replay', 'adopt', 'reload'])
    assert.match(String(refusals[name]), /is being archived and its slot released/, name);
  assert.equal(calls.releases.length, 1);
  assert.equal(getRun(run.id), undefined, 'the archive completed');
  assert.equal(isRunArchiving(run.id), false);
});

test('a replay already past its generation bump aborts when the archive fences the run', async (t) => {
  const created = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now() % 100_000}`,
    slotId,
  });
  t.after(() => cleanupRun(created.id));
  const run = updateRun(created.id, {
    status: 'blocked',
    error: 'worker blocked',
    decisions: [],
    steps: created.steps.map((step) =>
      step.name === 'self-review'
        ? { ...step, status: 'failed' }
        : ['complete', 'human-gate', 'finalize', 'ci-watch'].includes(step.name)
          ? { ...step, status: 'skipped' }
          : { ...step, status: 'done' },
    ),
  });
  await holdSlotFor(t, run.id);
  const slotBefore = await readSlotField(slotId, 'current_run_id');

  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'self-review' }, noopEmit, {
      // The archive takes the run between the replay's bump and its slot work.
      afterGenerationBump: async () => beginRunArchive(run.id),
    }),
    /is being archived and its slot released/,
  );
  endRunArchive(run.id);
  assert.equal(getRun(run.id)?.status, 'blocked', 'the replay did not revive the run');
  assert.equal(getRun(run.id)?.slotId, slotId);
  assert.equal(await readSlotField(slotId, 'current_run_id'), slotBefore, 'slot left as it was');
  assert.equal(await readSlotField(slotId, 'phase'), 'pr-watch');
});

test('a release a restart cut short is named instead of a retry loop', async (t) => {
  const run = blockedRun(t, 'archive-interrupted', [{ name: 'monitor', status: 'done' }]);
  // What survives a restart mid-release: the fence, the blocked owner, no teardown.
  await holdSlotFor(t, run.id, 'releasing');

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit),
    /slot demo-work-1 is still fenced by a release that did not finish/,
  );
  assert.ok(getRun(run.id));
  assert.equal(isRunArchiving(run.id), false);
});

test('a release that left the slot held refuses the archive with its held reason', async (t) => {
  const run = blockedRun(t, 'archive-held', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  const { slot } = recordingSlot();
  slot.release = async (params) => {
    await updateSlotStatus(params.slotId, {
      lifecycle: 'held',
      phase: 'occupied',
      held_reason: 'Workspace process census is unavailable; slot teardown was skipped',
    });
    return { released: false };
  };

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit, slot),
    /slot demo-work-1 was left held: Workspace process census is unavailable/,
  );
  assert.ok(getRun(run.id));
  assert.equal(isRunArchiving(run.id), false);
});

test('a session reload re-checks slot ownership right before relaunching', async (t) => {
  const run = blockedRun(t, 'reload-owner', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  await updateSlotStatus(slotId, { slot_epoch: 7 });

  await assertReloadStillOwnsSlot(run.id, slotId, 7);

  beginRunArchive(run.id);
  await assert.rejects(
    assertReloadStillOwnsSlot(run.id, slotId, 7),
    /is being archived and its slot released/,
  );
  endRunArchive(run.id);

  // While the reload awaited remote setup, the archive finished and dispatch
  // handed the slot to another run: relaunching would take over its window.
  const successor = blockedRun(t, 'reload-successor', [{ name: 'monitor', status: 'done' }]);
  await updateSlotStatus(slotId, { current_run_id: successor.id, slot_epoch: 8 });
  await assert.rejects(
    assertReloadStillOwnsSlot(run.id, slotId, 7),
    /no longer belongs to run .*; its session was not reloaded/,
  );
});

test('a free-slot archive goes through the run transition, so a re-bind before it is released', async (t) => {
  // The block's cleanup left the slot ready while the run kept its slotId, and
  // its worker kept going: the automatic resume re-binds such a slot under the
  // run transition. An archive that skipped the transition evicted the run
  // with the slot still naming it, and the reconciler later reset it under
  // that live worker.
  const run = blockedRun(t, 'archive-free-slot', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  await updateSlotStatus(slotId, { current_run_id: null, lifecycle: 'ready', phase: null });
  const { calls, slot } = recordingSlot();
  let resumeAdmitted!: () => void;
  const admitted = new Promise<void>((resolve) => (resumeAdmitted = resolve));
  let letResumeRun!: () => void;
  const resumeMayRun = new Promise<void>((resolve) => (letResumeRun = resolve));
  let rebound: string | null | undefined;
  const resume = withRunTransition(run.id, async () => {
    resumeAdmitted();
    await resumeMayRun;
    rebound = await rebindReleasedSlot(getRun(run.id)!);
  });
  await admitted;

  const archive = runArchive({ runId: run.id }, noopEmit, slot);
  letResumeRun();
  await resume;
  await archive;

  assert.equal(rebound, null, 'the resume re-bound the slot before the archive took the run');
  assert.deepEqual(calls.releases, [{ slotId, expectedRunId: run.id }], 'so archive released it');
  assert.equal(getRun(run.id), undefined, 'the run is archived');
  assert.equal(await readSlotField(slotId, 'current_run_id'), null, 'no archived run holds it');
});

test('a slot re-bind refuses a run being archived', async (t) => {
  const run = blockedRun(t, 'rebind-fenced', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  await updateSlotStatus(slotId, { current_run_id: null, lifecycle: 'ready', phase: null });

  beginRunArchive(run.id);
  t.after(() => endRunArchive(run.id));
  assert.match(String(await rebindReleasedSlot(run)), /being archived/);
  assert.equal(await readSlotField(slotId, 'current_run_id'), null);
});

test('a release that throws because it left the slot held aborts the archive with that reason', async (t) => {
  const run = blockedRun(t, 'archive-held-throw', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  const { slot } = recordingSlot();
  // What a prepare-scope reap failure or stop timeout does after the kill.
  slot.release = async (params) => {
    throw new Error(`Slot ${params.slotId} stays held: In-flight prepare did not stop within 180s`);
  };

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit, slot),
    /Slot demo-work-1 stays held: In-flight prepare did not stop within 180s/,
  );
  assert.equal(getRun(run.id)?.status, 'blocked', 'the run is not archived');
  assert.equal(isRunArchiving(run.id), false, 'the fence is ended');
});
