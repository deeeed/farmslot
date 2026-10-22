import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { DEFAULT_PRESSURE_STALE_AFTER_MS, type FleetStatus, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slot-binding-resources-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'status.json');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_HOME = path.join(root, 'home');
await fs.mkdir(process.env.FARMSLOT_POOL_DIR);
await fs.mkdir(process.env.FARMSLOT_RUNS_DIR);
after(() => fs.rm(root, { recursive: true, force: true }));

// Pause a real file read after it captured bytes, without altering the writer.
let holdNextRead: (() => Promise<void>) | undefined;
const readFile = fs.readFile;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await readFile(...args);
      if (args[0] === process.env.FARMSLOT_TEST_STATUS_FILE && holdNextRead) {
        const hold = holdNextRead;
        holdNextRead = undefined;
        await hold();
      }
      return bytes;
    },
  },
});
const state = await import('../core/state.js');
const { getCachedFleet, loadFleetStatus, onStateChange, startFileWatcher } =
  await import('./state.js');
const overlays = await import('./state.js');
const {
  markMachineOnline,
  markMachineOffline,
  updateMachineMetrics,
  getMachinePressureHistoryFreshness,
} = await import('./node-health.js');
const { readWithResourceState, resourceRevisions } = await import('../resources/revisions.js');
await import('../runtime/mock-pty.test-support.js');
const { runSlotHistory } = await import('../methods/run/slot-history.js');
const { runForSlot, runRecipeRunsForSlot } = await import('../methods/run/context.js');
const key = { family: 'runs', scope: 'farm' } as const;
const rows = (owner: string | null) => ({ slots: [{ slot: 'proof', current_run_id: owner }] });

test('overlay writers invalidate current slot facts and cached fleet without changing run bindings', async () => {
  await state.rewriteStatusFile(() => ({
    slots: [{ slot: 'proof', project: 'overlay-project', machine: 'overlay-node', branch: 'base' }],
  }));
  await loadFleetStatus(false, true);
  const detail = { family: 'slot', slotId: 'proof' } as const;
  const collection = { family: 'slots', scope: 'farm' } as const;
  const beforeRuns = resourceRevisions.revision(key);
  const prHealth = {
    pr: 1,
    conflict: false,
    ciPassed: 1,
    ciFailed: 1,
    ciPending: 0,
    ciTotal: 2,
    updatedAt: '2026-10-23T00:00:00Z',
  };
  const cases = [
    {
      set: () => overlays.setTaskProgressOverlay('proof', 'Validate', 2, 5),
      clear: () => overlays.clearTaskProgressOverlay('proof'),
      field: 'taskPhase' as const,
      expected: 'Validate 2/5',
    },
    {
      set: () => overlays.setPrHealthOverlay('proof', prHealth),
      clear: () => overlays.clearPrHealthOverlay('proof'),
      field: 'prHealth' as const,
      expected: prHealth,
    },
    {
      set: () => overlays.setBranchOverlay('proof', 'changed'),
      clear: () => overlays.clearBranchOverlay('proof'),
      field: 'branch' as const,
      expected: 'changed',
    },
  ];
  for (const entry of cases) {
    const before = resourceRevisions.revision(detail);
    const beforeCollection = resourceRevisions.revision(collection);
    const prior = (await loadFleetStatus(false, true)).slots[0][entry.field];
    entry.set();
    assert.equal(resourceRevisions.revision(detail), before + 1);
    assert.equal(resourceRevisions.revision(collection), beforeCollection + 1);
    assert.deepEqual(getCachedFleet()?.slots[0][entry.field], entry.expected);
    assert.deepEqual((await loadFleetStatus(false, true)).slots[0][entry.field], entry.expected);
    entry.set();
    assert.equal(resourceRevisions.revision(detail), before + 1, 'Identical overlay stays quiet');
    entry.clear();
    assert.equal(resourceRevisions.revision(detail), before + 2);
    assert.deepEqual((await loadFleetStatus(false, true)).slots[0][entry.field], prior);
    entry.clear();
    assert.equal(resourceRevisions.revision(detail), before + 2, 'Absent removal stays quiet');
  }
  for (const key of [
    { family: 'slots', scope: 'farm', project: 'overlay-project' },
    { family: 'slots', scope: 'farm', nodeId: 'overlay-node' },
  ] as const)
    assert(resourceRevisions.revision(key) >= 6);
  assert.equal(resourceRevisions.revision(key), beforeRuns);
});

test('PR overlay comparisons retain scalar facts when the caller reuses its object', async () => {
  await state.rewriteStatusFile(() => rows(null));
  const health = {
    pr: 1,
    conflict: false,
    ciPassed: 1,
    ciFailed: 0,
    ciPending: 0,
    ciTotal: 1,
    updatedAt: '2026-10-23T00:00:00Z',
  };
  overlays.setPrHealthOverlay('proof', health);
  const before = resourceRevisions.revision({ family: 'slot', slotId: 'proof' });
  health.ciFailed = 1;
  assert.equal((await loadFleetStatus(false, true)).slots[0].prHealth?.ciFailed, 0);
  overlays.setPrHealthOverlay('proof', health);
  assert.equal(resourceRevisions.revision({ family: 'slot', slotId: 'proof' }), before + 1);
  assert.equal((await loadFleetStatus(false, true)).slots[0].prHealth?.ciFailed, 1);
  overlays.setPrHealthOverlay('proof', undefined);
});

test('an overlay write fences an older in-flight status-file observation', async () => {
  await state.rewriteStatusFile(() => ({ slots: [{ slot: 'proof', branch: 'disk' }] }));
  await loadFleetStatus(false, true);
  let captured!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdNextRead = () => {
    captured();
    return gate;
  };
  const slow = loadFleetStatus(true, true);
  await ready;
  try {
    overlays.setBranchOverlay('proof', 'overlay');
    assert.equal(getCachedFleet()?.slots[0].branch, 'overlay');
    await fs.writeFile(
      state.statusFile,
      JSON.stringify({ slots: [{ slot: 'proof', branch: 'new-disk' }] }),
    );
    await loadFleetStatus(true, true);
    release();
    await slow;
    overlays.clearBranchOverlay('proof');
    assert.equal(getCachedFleet()?.slots[0].branch, 'new-disk');
  } finally {
    release();
    overlays.clearBranchOverlay('proof');
  }
});

test('node observations invalidate scoped fleet facts after writes and refresh cached host load', async () => {
  const machine = 'resource-health-node';
  await state.rewriteStatusFile(() => ({
    slots: [{ slot: 'proof', machine, project: 'health-project' }],
  }));
  await loadFleetStatus(false, true);
  const node = { family: 'node', nodeId: machine } as const;
  const pressure = { family: 'pressure', nodeId: machine } as const;
  const slot = { family: 'slot', slotId: 'proof' } as const;
  const beforeRuns = resourceRevisions.revision(key);
  markMachineOnline(machine);
  assert.equal(resourceRevisions.revision(node), 1);
  const beforeSlot = resourceRevisions.revision(slot);
  markMachineOnline(machine);
  assert.equal(resourceRevisions.revision(node), 1, 'Identical connection stays quiet');
  const metrics = {
    cpuPercent: 20,
    memoryPercent: 30,
    memoryUsedGb: 3,
    memoryTotalGb: 10,
    diskPercent: 40,
    loadAvg1: 1,
    loadAvg5: 1,
    collectedAt: new Date().toISOString(),
  };
  updateMachineMetrics(machine, metrics);
  assert.equal(resourceRevisions.revision(node), 2);
  assert.equal(resourceRevisions.revision(slot), beforeSlot + 1);
  assert.equal(getCachedFleet()?.slots[0].hostLoad?.cpuPercent, 20);
  assert.equal((await loadFleetStatus(false, true)).slots[0].hostLoad?.memoryPercent, 30);
  const beforePressure = resourceRevisions.revision(pressure);
  updateMachineMetrics(machine, { ...metrics });
  assert.equal(resourceRevisions.revision(node), 2, 'An identical sample stays quiet');
  assert.equal(resourceRevisions.revision(pressure), beforePressure);
  markMachineOffline(machine);
  assert.equal(resourceRevisions.revision(node), 3);
  assert.equal(getCachedFleet()?.slots[0].hostLoad?.headroom, 'red');
  markMachineOffline(machine);
  assert.equal(resourceRevisions.revision(node), 3, 'An identical disconnect stays quiet');
  for (const key of [
    { family: 'slots', scope: 'farm' },
    { family: 'slots', scope: 'farm', nodeId: machine },
    { family: 'slots', scope: 'farm', project: 'health-project' },
  ] as const)
    assert(resourceRevisions.revision(key) > 0);
  assert.equal(resourceRevisions.revision(key), beforeRuns);
});

test('pressure readers invalidate when the last sample becomes stale without another node write', (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const machine = 'pressure-deadline-node';
  updateMachineMetrics(machine, {
    cpuPercent: 20,
    memoryPercent: 30,
    memoryUsedGb: 3,
    memoryTotalGb: 10,
    diskPercent: 40,
    loadAvg1: 1,
    loadAvg5: 1,
    collectedAt: new Date(now).toISOString(),
  });
  const key = { family: 'pressure', nodeId: machine } as const;
  const before = resourceRevisions.revision(key);
  t.mock.timers.tick(DEFAULT_PRESSURE_STALE_AFTER_MS);
  assert.equal(getMachinePressureHistoryFreshness(machine).stale, false);
  assert.equal(resourceRevisions.revision(key), before);
  t.mock.timers.tick(1);
  assert.equal(getMachinePressureHistoryFreshness(machine).stale, true);
  assert.equal(resourceRevisions.revision(key), before + 1);
});

test('every serialized binding writer publishes only after the committed file is readable', async () => {
  await state.rewriteStatusFile(() => rows(null));
  markMachineOnline('proof-machine');
  let lastCommit: unknown;
  state.onStatusCommit((snapshot) => {
    assert.deepEqual(JSON.parse(readFileSync(state.statusFile, 'utf8')), snapshot);
    lastCommit = snapshot;
  });
  const writers: Array<[() => Promise<unknown>, string | null]> = [
    [() => state.updateSlotStatus('proof', { current_run_id: 'direct' }), 'direct'],
    [() => state.updateSlotStatusIf('proof', () => true, { current_run_id: 'cas' }), 'cas'],
    [() => state.claimSlotStatusIf('proof', () => true, { current_run_id: 'claim' }), 'claim'],
    [() => state.markSlotStatusIf('proof', () => true, { current_run_id: 'mark' }), 'mark'],
    [
      () =>
        state.transitionSlotStatus('proof', () => ({ fields: { current_run_id: 'transition' } })),
      'transition',
    ],
    [() => state.resetSlotIf('proof', () => true), null],
    [() => state.updateSlotStatus('proof', { current_run_id: 'reset' }), 'reset'],
    [() => state.resetSlot('proof'), null],
    [() => state.rewriteStatusFile(() => rows('rewrite')), 'rewrite'],
  ];
  for (const [write, expected] of writers) {
    await loadFleetStatus();
    const revision = resourceRevisions.revision(key);
    await write();
    assert.equal(resourceRevisions.revision(key), revision + 1);
    assert.equal(getCachedFleet(), null, 'A new revision cannot return the old cached pointer');
    assert.deepEqual(lastCommit && Reflect.get(lastCommit, 'slots')?.[0]?.current_run_id, expected);
    const fleet = await loadFleetStatus();
    assert.equal(fleet.slots[0].currentRunId, expected);
    assert(fleet.machines?.some((machine) => machine.machine === 'proof-machine'));
    assert.equal(resourceRevisions.revision(key), revision + 1, 'Read-back must not publish twice');
  }
});

test('refused, missing, identical and unrelated writes do not invalidate run readers', async () => {
  await state.rewriteStatusFile(() => rows('unchanged'));
  const revision = resourceRevisions.revision(key);
  await state.updateSlotStatus('missing', { current_run_id: 'other' });
  assert.equal(
    await state.updateSlotStatusIf('proof', () => false, { current_run_id: 'other' }),
    false,
  );
  assert.equal((await state.claimSlotStatusIf('proof', () => false, {})).claimed, false);
  assert.equal((await state.markSlotStatusIf('proof', () => false, {})).applied, false);
  assert.equal((await state.transitionSlotStatus('proof', () => null)).applied, false);
  await state.updateSlotStatus('proof', { current_run_id: 'unchanged', lifecycle: 'busy' });
  await state.rewriteStatusFile(() => rows('unchanged'));
  await loadFleetStatus(true, true);
  assert.equal(resourceRevisions.revision(key), revision);
});

test('committed slot facts advance detail and collection reads while retaining the same run binding', async () => {
  await state.rewriteStatusFile(() => ({
    slots: [
      {
        slot: 'proof',
        current_run_id: 'same-run',
        lifecycle: 'ready',
        branch: 'before',
        project: 'before-project',
        machine: 'before-node',
      },
    ],
  }));
  const slots = { family: 'slots', scope: 'farm' } as const;
  const detail = { family: 'slot', slotId: 'proof' } as const;
  const before = resourceRevisions.revision(slots);
  const beforeDetail = resourceRevisions.revision(detail);
  const beforeRun = resourceRevisions.revision(key);
  await state.updateSlotStatus('proof', { lifecycle: 'held', branch: 'after' });
  assert.equal(resourceRevisions.revision(slots), before + 1);
  assert.equal(resourceRevisions.revision(detail), beforeDetail + 1);
  assert.equal(resourceRevisions.revision(key), beforeRun);
  const current = await loadFleetStatus(false, true);
  assert.equal(current.slots[0].branch, 'after');
  assert.equal(current.slots[0].currentRunId, 'same-run');
  await state.updateSlotStatus('proof', { lifecycle: 'held', branch: 'after' });
  assert.equal(resourceRevisions.revision(slots), before + 1);
  await state.updateSlotStatusIf('proof', () => true, {
    project: 'after-project',
    machine: 'after-node',
  });
  for (const project of ['before-project', 'after-project'])
    assert(resourceRevisions.revision({ family: 'slots', scope: 'farm', project }) > 0);
  for (const nodeId of ['before-node', 'after-node'])
    assert(resourceRevisions.revision({ family: 'slots', scope: 'farm', nodeId }) > 0);
  assert.equal(resourceRevisions.revision(key), beforeRun);
});

test('a slow pre-commit read cannot restore an old cached binding or advance it again', async () => {
  await state.rewriteStatusFile(() => rows('before'));
  let captured!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdNextRead = () => {
    captured();
    return gate;
  };
  const slow = readWithResourceState(
    resourceQuery(Methods.RUN_SLOT_HISTORY, { slotId: 'proof' }).dependencies,
    () => loadFleetStatus(true, true),
  );
  await ready;
  try {
    await state.updateSlotStatus('proof', { current_run_id: 'after' });
    const current = await loadFleetStatus(true, true);
    const revision = resourceRevisions.revision(key);
    release();
    const old = await slow;
    assert.equal(old.payload.slots[0].currentRunId, 'before');
    assert(
      old.resourceState.dependencies.find(({ key }) => key.family === 'runs')!.revision < revision,
    );
    assert.equal(getCachedFleet()?.slots[0].currentRunId, 'after');
    assert.equal(current.slots[0].currentRunId, 'after');
    assert.equal(resourceRevisions.revision(key), revision);
  } finally {
    release();
  }
});

test('strict run projections expose corrupt and absent status, then recover without a run write', async () => {
  await state.rewriteStatusFile(() => rows('retained'));
  const revision = resourceRevisions.revision(key);
  await fs.writeFile(state.statusFile, '{corrupt');
  for (const read of [
    () => runSlotHistory({ slotId: 'proof' }),
    () => runForSlot({ slotId: 'proof' }),
    () => runRecipeRunsForSlot({ slotId: 'proof' }),
  ])
    await assert.rejects(read, SyntaxError);
  assert.equal(resourceRevisions.revision(key), revision + 1);
  assert.equal(getCachedFleet(), null);
  await fs.unlink(state.statusFile);
  await assert.rejects(() => runSlotHistory({ slotId: 'proof' }), { code: 'ENOENT' });
  assert.equal(resourceRevisions.revision(key), revision + 1);
  await state.rewriteStatusFile(() => rows('retained'));
  assert.equal(resourceRevisions.revision(key), revision + 2);
  assert.equal((await runSlotHistory({ slotId: 'proof' })).slotExists, true);
});

test(
  'filesystem observations cover external pointer writes, removal and recreation',
  { timeout: 5000 },
  async (t) => {
    await state.rewriteStatusFile(() => rows('watch-before'));
    await loadFleetStatus(true, true);
    const watcher = startFileWatcher();
    t.after(() => watcher.close());
    await watcher.ready;
    t.diagnostic('Both filesystem watchers are ready');
    let receiver: ((fleet: FleetStatus) => void) | undefined;
    onStateChange((fleet) => receiver?.(fleet));
    const observe = async (write: () => Promise<void>, expected: string | null) => {
      const seen = new Promise<void>((resolve) => {
        receiver = (fleet) => {
          if ((fleet.slots[0]?.currentRunId ?? null) === expected) resolve();
        };
      });
      const revision = resourceRevisions.revision(key);
      await write();
      await seen;
      t.diagnostic(`Observed external binding ${expected}`);
      assert.equal(resourceRevisions.revision(key), revision + 1);
      receiver = undefined;
    };
    await observe(
      () => fs.writeFile(state.statusFile, JSON.stringify(rows('watch-after'))),
      'watch-after',
    );
    await observe(() => fs.unlink(state.statusFile), null);
    await observe(
      () => fs.writeFile(state.statusFile, JSON.stringify(rows('watch-after'))),
      'watch-after',
    );
    const before = resourceRevisions.revision(key);
    await loadFleetStatus(true, true);
    assert.equal(resourceRevisions.revision(key), before);
  },
);
