import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { Run, SlotReleaseParams } from '@farmslot/protocol';

import type { SlotReleaseOptions, SlotReleasePreflight } from '../methods/slot/release.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'published-free-slot-'));
Object.assign(process.env, {
  FARMSLOT_HOME: home,
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
});
after(() => rm(home, { recursive: true, force: true }));
await mkdir(path.join(home, 'projects', 'proof'), { recursive: true });
await mkdir(path.join(home, 'pool'));
await writeFile(
  path.join(home, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main', hooks: {} }),
);
await writeFile(
  path.join(home, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [{ id: 'free-slot', repo: path.join(home, 'checkout'), session: 'fixture' }],
  }),
);
await import('../runtime/mock-pty.test-support.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');
const core = await import('../core/index.js');
const store = await import('../runs/store.js');
let incoming: Run;
let row: Record<string, unknown>;
let history: Run[];
let work: string | undefined;
let duringProbe: (() => void) | undefined;
let probeError: Error | undefined;
const releases: Array<{ params: SlotReleaseParams; epoch?: number }> = [];
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getAllRunsWithArchived: async () => history,
    getAllRuns: () => history,
    getRun: (id: string) => (id === incoming.id ? incoming : history.find((run) => run.id === id)),
  },
});
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => structuredClone(row),
    execOnSlot: async (_vars: unknown, command: string) => ({
      stdout: command.includes('rev-parse') ? 'fix/old-pushed' : 'primary',
      stderr: '',
      exitCode: 0,
    }),
  },
});
const publication = await import('../methods/slot/unmerged-work.js');
let publicationRefusal = false;
mock.module('../methods/slot/unmerged-work.js', {
  namedExports: {
    ...publication,
    assertPrepareCommitsPublished: async () => {
      if (publicationRefusal)
        throw new publication.UnpublishedSlotCommitsError('Local tip not published');
    },
  },
});
const release = await import('../methods/slot/release.js');
mock.module('../methods/slot/release.js', {
  namedExports: {
    ...release,
    slotReleasePreflight: async (): Promise<SlotReleasePreflight> => {
      if (probeError) throw probeError;
      const vars = await core.loadSlotVars('free-slot');
      const projectVars = await core.loadProjectVars('proof');
      duringProbe?.();
      return {
        vars,
        boundOwner: null,
        ownerTerminal: false,
        projectVars,
        projectJson: projectVars.projectJson,
        defaultBranch: 'main',
        unmergedWork: work ? { branch: 'fix/old-pushed', details: work } : null,
      };
    },
    slotRelease: async (
      params: SlotReleaseParams,
      _emit: unknown,
      options?: SlotReleaseOptions,
    ) => {
      releases.push({ params, epoch: options?.expectedSlotEpoch });
      return {
        released:
          options?.expectedSlotEpoch === row.slot_epoch &&
          (!params.expectedRunId || params.expectedRunId === row.current_run_id),
      };
    },
  },
});
const { reclaimPublishedFreeSlot } = await import('./finished-slot-reclaim.js');
beforeEach(() => {
  incoming = makeRun({
    id: 'incoming',
    project: 'proof',
    status: 'slot-finding',
    engineState: { generation: 3 },
  });
  row = { lifecycle: 'ready', phase: null, current_run_id: null, slot_epoch: 7 };
  history = [];
  releases.length = 0;
  work = undefined;
  duringProbe = undefined;
  probeError = undefined;
  publicationRefusal = false;
});
const reclaim = () => reclaimPublishedFreeSlot('free-slot', incoming, 3, () => {});
test('ownerless published work without a historical run uses the sampled epoch', async () => {
  assert.equal(await reclaim(), true);
  assert.deepEqual(releases, [{ params: { slotId: 'free-slot' }, epoch: 7 }]);
});
test('finished owners bind automatic release to both their identity and epoch', async () => {
  row.current_run_id = 'finished';
  history = [makeRun({ id: 'finished', slotId: 'free-slot', status: 'done' })];
  assert.equal(await reclaim(), true);
  assert.deepEqual(releases, [
    { params: { slotId: 'free-slot', expectedRunId: 'finished' }, epoch: 7 },
  ]);
});
test('dirty and unpublished candidates are skipped before any release', async () => {
  for (const detail of ['dirty files', 'unpushed commits']) {
    work = detail;
    assert.equal(await reclaim(), false);
  }
  assert.deepEqual(releases, []);
});
test('manual, held, missing-owner, in-flight release and handoff slots stay untouched', async () => {
  for (const patch of [
    { lifecycle: 'manual' },
    { lifecycle: 'held' },
    { phase: 'releasing' },
    { handoff_run_id: 'other' },
    { current_run_id: 'missing-owner' },
  ]) {
    row = { lifecycle: 'ready', current_run_id: null, slot_epoch: 7, ...patch };
    assert.equal(await reclaim(), false);
  }
  assert.deepEqual(releases, []);
});
test('an active run protects its checkout even after the row lost its owner', async () => {
  history = [makeRun({ id: 'review-owner', slotId: 'free-slot', status: 'reviewing' })];
  assert.equal(await reclaim(), false);
  assert.deepEqual(releases, []);
});
test('a completion refusal remains protected despite a terminal status', async () => {
  history = [
    makeRun({
      id: 'retained',
      slotId: 'free-slot',
      status: 'failed',
      steps: [
        {
          name: 'complete',
          status: 'failed',
          outputs: { gatePrerequisiteRefusal: 'invalid evidence' },
        },
      ],
    }),
  ];
  assert.equal(await reclaim(), false);
  assert.deepEqual(releases, []);
});
test('a rival claim during Git inspection cannot be released using an old epoch', async () => {
  duringProbe = () => Object.assign(row, { current_run_id: 'successor', slot_epoch: 8 });
  assert.equal(await reclaim(), false);
  assert.equal(row.current_run_id, 'successor');
  assert.equal(releases[0]?.epoch, 7);
});
test('cancelled or replayed requests do not release after the publication probe', async () => {
  duringProbe = () => {
    incoming.status = 'cancelled';
  };
  assert.equal(await reclaim(), false);
  incoming.status = 'slot-finding';
  duringProbe = () => {
    incoming.engineState!.generation = 4;
  };
  assert.equal(await reclaim(), false);
  assert.deepEqual(releases, []);
});
test('an unexpected Git or release preflight error remains actionable', async () => {
  probeError = new Error('Git inspection failed');
  await assert.rejects(reclaim, /Git inspection failed/);
  assert.deepEqual(releases, []);
});

test('a deleted upstream does not authorize discarding an unpublished local tip', async () => {
  publicationRefusal = true;
  assert.equal(await reclaim(), false);
  assert.deepEqual(releases, []);
});
