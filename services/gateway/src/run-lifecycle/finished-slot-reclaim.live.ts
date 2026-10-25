import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { Run, SlotReleaseParams } from '@farmslot/protocol';

const home = await mkdtemp(path.join(os.tmpdir(), 'finished-slot-'));
Object.assign(process.env, {
  FARMSLOT_HOME: home,
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
});
after(() => rm(home, { recursive: true, force: true }));
await mkdir(path.join(home, 'projects', 'finished-proof'), { recursive: true });
await mkdir(path.join(home, 'pool'));
await writeFile(
  path.join(home, 'projects', 'finished-proof', 'project.json'),
  JSON.stringify({ name: 'finished-proof', default_branch: 'main', hooks: {} }),
);
await writeFile(
  path.join(home, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'finished-proof',
    platform: 'cli',
    slots: [{ id: 'finished-slot', repo: path.join(home, 'checkout'), session: 'fixture' }],
  }),
);
await import('../runtime/mock-pty.test-support.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
let row: Record<string, unknown>;
let history: Run[];
let branch: string;
let reads: number;
let refusal: string | undefined;
let skipped: string | undefined;
let duringProbe: (() => void) | undefined;
const releases: Array<{ params: SlotReleaseParams; epoch?: number }> = [];
const incoming = { id: 'new-run', project: 'finished-proof', branch: '' };
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => structuredClone(row),
    execOnSlot: async (_vars: unknown, command: string) => {
      reads += 1;
      duringProbe?.();
      return {
        stdout: command.includes('rev-parse') ? branch : 'primary',
        stderr: '',
        exitCode: 0,
      };
    },
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: { ...store, getAllRunsWithArchived: async () => history },
});
const release = await import('../methods/slot/release.js');
mock.module('../methods/slot/release.js', {
  namedExports: {
    ...release,
    slotRelease: async (
      params: SlotReleaseParams,
      emit: (event: string, payload: unknown) => void,
      opts?: { expectedSlotEpoch?: number },
    ) => {
      releases.push({ params, epoch: opts?.expectedSlotEpoch });
      if (refusal) throw new Error(refusal);
      if (skipped) return { released: false, reason: skipped };
      if (
        (params.expectedRunId && params.expectedRunId !== row.current_run_id) ||
        (opts?.expectedSlotEpoch !== undefined && opts.expectedSlotEpoch !== row.slot_epoch)
      )
        return { released: false, reason: 'owner changed' };
      emit('slot.release.step', { slotId: params.slotId });
      branch = 'main';
      row.current_run_id = null;
      return { released: true };
    },
  },
});
const { reclaimFinishedSlot } = await import('./finished-slot-reclaim.js');
beforeEach(() => {
  row = { slot: 'finished-slot', current_run_id: 'old-run', slot_epoch: 7 };
  history = [
    makeRun({
      id: 'old-run',
      project: incoming.project,
      slotId: 'finished-slot',
      status: 'done',
      branch: 'fix/previous',
    }),
  ];
  branch = 'fix/previous';
  reads = 0;
  releases.length = 0;
  refusal = skipped = undefined;
  duringProbe = undefined;
});

test('a finished branch releases through the owner-bound supported path before reuse', async () => {
  const events: string[] = [];
  await reclaimFinishedSlot('finished-slot', incoming, (event) => events.push(event));
  assert.deepEqual(releases, [
    { params: { slotId: 'finished-slot', expectedRunId: 'old-run' }, epoch: undefined },
  ]);
  assert.equal(branch, 'main');
  assert.deepEqual(events, ['slot.release.step']);
});

test('an unowned archived branch binds release to the sampled slot epoch', async () => {
  row.current_run_id = null;
  await reclaimFinishedSlot('finished-slot', incoming, () => {});
  assert.deepEqual(releases, [{ params: { slotId: 'finished-slot' }, epoch: 7 }]);
});

test('same-target branches, idle branches and unrelated history are preserved', async () => {
  await reclaimFinishedSlot('finished-slot', { ...incoming, branch }, () => {});
  branch = history[0]!.branch = 'main';
  await reclaimFinishedSlot('finished-slot', incoming, () => {});
  branch = 'fix/unrecorded';
  await reclaimFinishedSlot('finished-slot', incoming, () => {});
  assert.deepEqual(releases, []);
});

test('incoming replay, active foreign owners and cancelled holders are not reclaimed here', async () => {
  for (const owner of [incoming.id, 'foreign']) {
    row.current_run_id = owner;
    await reclaimFinishedSlot('finished-slot', incoming, () => {});
  }
  row.current_run_id = 'old-run';
  history[0]!.status = 'cancelled';
  await reclaimFinishedSlot('finished-slot', incoming, () => {});
  assert.equal(reads, 0);
  assert.deepEqual(releases, []);
});

test('unpublished work and guarded release refusals stop selection', async () => {
  refusal = 'UNMERGED_WORK:fix/previous:unpushed commit';
  await assert.rejects(
    reclaimFinishedSlot('finished-slot', incoming, () => {}),
    /UNMERGED_WORK/,
  );
  refusal = undefined;
  skipped = 'pending foreign handoff';
  await assert.rejects(
    reclaimFinishedSlot('finished-slot', incoming, () => {}),
    /cleanup refused: pending foreign handoff/,
  );
});

test('owner and epoch changes during Git reads leave the successor untouched', async () => {
  for (const owned of [true, false]) {
    row = { current_run_id: owned ? 'old-run' : null, slot_epoch: 7 };
    duringProbe = () => Object.assign(row, { current_run_id: 'successor', slot_epoch: 8 });
    await assert.rejects(
      reclaimFinishedSlot('finished-slot', incoming, () => {}),
      /owner changed/,
    );
    assert.equal(row.current_run_id, 'successor');
    assert.equal(branch, 'fix/previous');
  }
});

test('an ownerless checkout with an active historical run is not released', async () => {
  row.current_run_id = null;
  history.push(makeRun({ id: 'live-review', slotId: 'finished-slot', status: 'reviewing' }));
  await assert.rejects(
    reclaimFinishedSlot('finished-slot', incoming, () => {}),
    /retained by run live-review/,
  );
  assert.deepEqual(releases, []);
});

test('a refused completion keeps its workspace even beside older finished history', async () => {
  row.current_run_id = null;
  history.push(
    makeRun({
      id: 'completion-refused',
      slotId: 'finished-slot',
      status: 'failed',
      branch,
      steps: [
        {
          name: 'complete',
          status: 'failed',
          outputs: { gatePrerequisiteRefusal: 'invalid evidence' },
        },
      ],
    }),
  );
  await assert.rejects(
    reclaimFinishedSlot('finished-slot', incoming, () => {}),
    /retained by run completion-refused/,
  );
  assert.deepEqual(releases, []);
});

test('a parked run that freed the slot keeps its record while the successor is released', async () => {
  const parked = makeRun({
    id: 'parked-A',
    slotId: 'finished-slot',
    status: 'human-gating',
    branch: 'fix/parked-A',
  });
  parked.park = {
    version: 1,
    operationId: 'park-A',
    previewId: 'preview-A',
    runId: parked.id,
    generation: 1,
    machine: 'local',
    slotId: 'finished-slot',
    mode: 'release',
    phase: 'parked',
    slotDisposition: 'freed',
    slotFreedAt: '2026-09-04T00:00:10.000Z',
    prePauseStatus: 'human-gating',
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-09-04T00:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:10.000Z',
  };
  history.push(parked);
  const before = structuredClone(parked);
  await reclaimFinishedSlot('finished-slot', incoming, () => {});
  assert.equal(releases.length, 1);
  assert.equal(releases[0]?.params.expectedRunId, 'old-run');
  assert.deepEqual(parked, before);
});

test('an unclaimed pending request does not block releasing the finished checkout', async () => {
  const pending = makeRun({
    id: 'pending-A',
    slotId: 'finished-slot',
    status: 'slot-finding',
    steps: [{ name: 'find-slot', status: 'pending' }],
  });
  history.push(pending);
  const before = structuredClone(pending);
  await reclaimFinishedSlot('finished-slot', incoming, () => {});
  assert.equal(releases.length, 1);
  assert.deepEqual(pending, before);
});
