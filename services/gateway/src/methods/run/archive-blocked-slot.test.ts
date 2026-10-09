// @farmslot:serial — snapshots, overwrites, and restores the shared root `.farm-status.json`.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { PipelineSteps, type Run, type SlotReleaseParams } from '@farmslot/protocol';

import { restoreTmuxWorker } from '../../agents/runtime-recovery.js';
import { readSlotField, updateSlotStatus } from '../../core/index.js';
import { statusFile } from '../../core/state.js';
import {
  beginRunArchive,
  endRunArchive,
  isRunArchiving,
} from '../../run-lifecycle/archive-fence.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { createRun, deleteRun, getRun, getRunWithArchived, updateRun } from '../../runs/store.js';
import type { SlotReleasePreflight } from '../slot/release.js';
import { detachRunsForReleasedSlot } from '../slot/release-run-ownership.js';

import { type ArchiveSlotRelease, runArchive } from './admin.js';
import { runAdopt } from './adopt.js';
import { runReplayStep } from './replay-step.js';

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
      detachRunsForReleasedSlot(params.slotId, noopEmit);
      return { released: true };
    },
  };
  return { calls, slot };
}

test('archiving a settled blocked run that holds its slot releases the slot first', async (t) => {
  const run = blockedRun(t, 'archive-release', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  const { calls, slot } = recordingSlot();

  const result = await runArchive({ runId: run.id }, noopEmit, slot);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.releases, [{ slotId, expectedRunId: run.id }]);
  assert.equal(await readSlotField(slotId, 'current_run_id'), null);
  assert.equal(getRun(run.id), undefined, 'the blocked run is archived');
  const archived = await getRunWithArchived(run.id);
  assert.equal(archived?.status, 'blocked', 'archiving keeps the blocked outcome');
  assert.equal(archived?.slotId, null, 'the release detached the run from its slot');
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
  slot.preflight = async () => {
    // The archive passed its first checks; let the resume land before its lock.
    finishResume();
    return clean;
  };

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit, slot),
    /no longer a settled blocked run \(status=monitoring\)/,
  );
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
