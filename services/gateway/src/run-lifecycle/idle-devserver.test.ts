import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  DEVSERVER_IDLE_LIMIT_MS,
  type IdleDevServerDeps,
  type IdleDevServerPointer,
  IdleDevServerReaper,
} from './idle-devserver.js';

const frame = {
  pid: '101',
  parent: '1',
  group: 101,
  identity: 'Mon Jan 1 00:00:00 2024',
  command: 'fixture-server',
};

function fixture(status: Run['status'] = 'blocked') {
  let now = 1000;
  let progress = 'idle';
  let row: Record<string, unknown> = { current_run_id: 'run-a', slot_epoch: 1 };
  let pointer: IdleDevServerPointer | undefined = {
    pid: 101,
    identity: frame.identity,
    group: frame.group,
  };
  let stopped = 0;
  let booted = 0;
  const run: Run = {
    id: 'run-a',
    familyId: 'family-a',
    lane: 'validation',
    flowType: 'dev',
    project: 'fixture-project',
    ticketOrPr: 'fixture-task',
    slotId: 'slot-a',
    status,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    agentContexts: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };
  const deps: IdleDevServerDeps = {
    now: () => now,
    row: async () => row,
    runs: () => [run],
    progress: async () => progress,
    preparing: () => false,
    resources: async () => [
      {
        id: 'server',
        definition: {
          type: 'dev-server',
          label: 'Fixture server',
          streamable: false,
          controllable: true,
          hooks: { boot: 'fixture-boot', health: 'fixture-health' },
          watch: { type: 'port-listen', port: '9300' },
        },
        status: 'running',
      },
    ],
    pointer: () => pointer,
    census: async () => [frame],
    retained: async () => false,
    write: async (_slot, expected, fields, admit) => {
      if (row.slot_epoch !== expected.slot_epoch || row.current_run_id !== expected.current_run_id)
        return false;
      if (admit && !admit()) return false;
      row = { ...row, ...fields };
      return true;
    },
    stop: async (_slot, rows, roots, stillOwned) => {
      assert.deepEqual(roots, [frame]);
      assert.deepEqual(rows, [frame]);
      if (!(await stillOwned())) return 'ownership changed';
      stopped++;
      pointer = undefined;
      return true;
    },
    ready: async (_slot, resourceId, _runId, assertOwner) => {
      assert.equal(resourceId, 'server');
      await assertOwner();
      booted++;
    },
  };
  const reaper = new IdleDevServerReaper(deps);
  return {
    deps,
    reaper,
    run,
    row: () => row,
    stopped: () => stopped,
    booted: () => booted,
    advance: () => (now += DEVSERVER_IDLE_LIMIT_MS),
    progress: (value: string) => (progress = value),
    replace: () => (pointer = { pid: 202, identity: 'new-process', group: 202 }),
    setRow: (value: Record<string, unknown>) => (row = { ...row, ...value }),
  };
}

for (const status of ['paused', 'blocked', 'done', 'failed', 'cancelled'] as const) {
  test(`idle cap stops the tracked server for ${status} and resume uses existing boot`, async () => {
    const f = fixture(status);
    await f.reaper.sweep('slot-a');
    assert.equal(f.stopped(), 0);
    f.advance();
    await f.reaper.sweep('slot-a');
    assert.equal(f.stopped(), 1);
    assert.deepEqual(f.row().idle_devservers, ['server']);
    await f.reaper.restore('slot-a');
    assert.equal(f.booted(), 1);
    assert.equal(f.row().idle_devservers, null);
  });
}

// macpro-mmt-2/mmt-5: the cap skipped for hours without a trace. Every sweep outcome is now
// reported per slot and dev server so the skip reason is visible.
test('the sweep reports why it skips, how long until it stops, and the stop', async () => {
  const f = fixture();
  const decisions: string[] = [];
  f.deps.decide = (slotId, resourceId, decision) =>
    decisions.push(`${slotId}/${resourceId ?? '-'} ${decision}`);
  f.setRow({ warm: true, current_run_id: null });
  await f.reaper.sweep('slot-a');
  assert.deepEqual(decisions.splice(0), ['slot-a/- skip: warm slot']);
  f.setRow({ warm: false, current_run_id: 'run-a' });
  const pointer = f.deps.pointer;
  f.deps.pointer = () => undefined;
  f.deps.explain = () => 'PID file missing, invalid or older than its process';
  await f.reaper.sweep('slot-a');
  assert.deepEqual(decisions.splice(0), [
    'slot-a/- quiet',
    'slot-a/server skip: no stop authority (PID file missing, invalid or older than its process)',
  ]);
  f.deps.pointer = pointer;
  await f.reaper.sweep('slot-a');
  const idle = decisions.splice(0);
  assert.equal(idle[0], 'slot-a/- quiet');
  assert.match(idle[1] ?? '', /^slot-a\/server idle: pid 101 stops after \d{4}-/);
  f.advance();
  await f.reaper.sweep('slot-a');
  assert.deepEqual(decisions.splice(0), [
    'slot-a/- quiet',
    'slot-a/server stopped pid 101 after the idle limit',
  ]);
});

test('a stop refused by the ownership recheck reports the check that failed', async () => {
  const f = fixture();
  const decisions: string[] = [];
  f.deps.decide = (slotId, resourceId, decision) =>
    decisions.push(`${slotId}/${resourceId ?? '-'} ${decision}`);
  await f.reaper.sweep('slot-a');
  f.advance();
  f.deps.stop = async (_slot, _rows, _roots, stillOwned) => {
    f.setRow({ phase: 'releasing' });
    return (await stillOwned()) || 'ownership changed';
  };
  await f.reaper.sweep('slot-a');
  assert.equal(decisions.at(-1), 'slot-a/server skip at stop: slot releasing');
});

test('idle lifetime covers an ownerless slot', async () => {
  const f = fixture();
  f.setRow({ current_run_id: null });
  f.deps.runs = () => [];
  await f.reaper.sweep('slot-a');
  f.advance();
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 1);
});

for (const kind of ['making-progress', 'unproven']) {
  test(`${kind} worker resets the idle cap, including a blocked run`, async () => {
    const f = fixture();
    await f.reaper.sweep('slot-a');
    f.advance();
    f.progress(kind);
    await f.reaper.sweep('slot-a');
    assert.equal(f.stopped(), 0);
    f.progress('idle');
    await f.reaper.sweep('slot-a');
    assert.equal(f.stopped(), 0);
  });
}

test('explicit keep-warm, prepare, manual use and retained capability owners stay intact', async () => {
  for (const mode of ['warm', 'prepare', 'manual', 'lease']) {
    const f = fixture();
    if (mode === 'warm') f.setRow({ warm: true, current_run_id: null });
    if (mode === 'manual') f.setRow({ lifecycle: 'manual' });
    if (mode === 'prepare') f.deps.preparing = () => true;
    if (mode === 'lease') f.deps.retained = async () => true;
    await f.reaper.sweep('slot-a');
    f.advance();
    await f.reaper.sweep('slot-a');
    assert.equal(f.stopped(), 0);
  }
});

test('a new tracked pid or changed owner cannot inherit an expired timer', async () => {
  const f = fixture();
  await f.reaper.sweep('slot-a');
  f.advance();
  f.replace();
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0);
  f.advance();
  f.setRow({ current_run_id: 'run-b', slot_epoch: 2 });
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0);
});

test('ownership change before signals refuses cleanup and preserves durable restart marker', async () => {
  const f = fixture();
  await f.reaper.sweep('slot-a');
  f.advance();
  f.deps.stop = async (_slot, _rows, _roots, stillOwned) => {
    f.setRow({ current_run_id: 'run-b', slot_epoch: 2 });
    assert.equal(await stillOwned(), false);
    return 'ownership changed';
  };
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0);
});

test('failed readiness keeps marker for retry; confirmed readiness clears it', async () => {
  const f = fixture();
  await f.reaper.sweep('slot-a');
  f.advance();
  await f.reaper.sweep('slot-a');
  f.deps.ready = async () => {
    throw new Error('fixture failure');
  };
  await assert.rejects(f.reaper.restore('slot-a'), /fixture failure/);
  assert.deepEqual(f.row().idle_devservers, ['server']);
  f.deps.ready = async () => {};
  await f.reaper.restore('slot-a');
  assert.equal(f.booted(), 0);
});

for (const change of [
  { current_run_id: 'run-b', slot_epoch: 2 },
  { phase: 'releasing' },
  { handoff_run_id: 'rival' },
]) {
  test(`resume refuses ownership or release changes during its health probe: ${JSON.stringify(change)}`, async () => {
    const f = fixture();
    await f.reaper.sweep('slot-a');
    f.advance();
    await f.reaper.sweep('slot-a');
    f.deps.ready = async (_slot, _resource, _owner, assertOwner) => {
      f.setRow(change);
      await assertOwner();
    };
    await assert.rejects(f.reaper.restore('slot-a', 'run-a'), /owner changed|releasing/);
    assert.equal(f.booted(), 0);
  });
}

test('closed tmux history never vetoes the current idle owner', async () => {
  const f = fixture();
  const history: Run = { ...f.run, id: 'old-run', status: 'done' };
  f.deps.runs = () => [history, f.run];
  f.deps.progress = async (run) => (run.id === history.id ? 'unproven' : 'idle');
  await f.reaper.sweep('slot-a');
  f.advance();
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 1);
});

test('another live run still vetoes cleanup while working', async () => {
  const f = fixture();
  const live: Run = { ...f.run, id: 'live-run', status: 'monitoring' };
  f.deps.runs = () => [live, f.run];
  f.deps.progress = async (run) => (run.id === live.id ? 'making-progress' : 'idle');
  await f.reaper.sweep('slot-a');
  f.advance();
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0);
});

test('restoration refuses a reservation replaced during readiness and keeps its marker', async () => {
  const f = fixture();
  await f.reaper.sweep('slot-a');
  f.advance();
  await f.reaper.sweep('slot-a');
  f.setRow({ handoff_run_id: 'authorized-follow-up' });
  f.deps.ready = async (_slot, _resource, _owner, assertOwner) => {
    f.setRow({ handoff_run_id: 'rival' });
    await assertOwner();
  };
  await assert.rejects(f.reaper.restore('slot-a', 'run-a'), /owner changed|releasing/);
  assert.deepEqual(f.row().idle_devservers, ['server']);
});

test('a slot without a running dev server skips the quiet checks and loses its idle window', async () => {
  const f = fixture();
  await f.reaper.sweep('slot-a');
  const resources = f.deps.resources;
  const live = await resources('slot-a');
  f.deps.resources = async () => live.map((resource) => ({ ...resource, status: 'unknown' }));
  f.deps.row = async () => assert.fail('an ineligible slot reads no slot row');
  f.advance();
  await f.reaper.sweep('slot-a');
  f.deps.resources = resources;
  f.deps.row = async () => ({ current_run_id: 'run-a', slot_epoch: 1 });
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0, 'the idle window restarts once the server is observed again');
});

test('an observation loss between sweeps, or a removed resource, restarts the idle window', async () => {
  const f = fixture();
  let losses = 0;
  f.deps.observed = () => losses;
  await f.reaper.sweep('slot-a');
  f.advance();
  losses++; // unknown, then running again, before this sweep
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0, 'a lost observation keeps no deadline');
  const resources = f.deps.resources;
  f.advance();
  f.deps.resources = async () => [];
  await f.reaper.sweep('slot-a');
  f.deps.resources = resources;
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0, 'a resource removed for a sweep keeps no deadline');
  f.advance();
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 1);
});

test('a dev server without a watch is not eligible', async () => {
  const f = fixture();
  const decisions: string[] = [];
  f.deps.decide = (slotId, resourceId, decision) =>
    decisions.push(`${slotId}/${resourceId ?? '-'} ${decision}`);
  const live = await f.deps.resources('slot-a');
  f.deps.resources = async () =>
    live.map((resource) => ({
      ...resource,
      definition: { ...resource.definition, watch: undefined },
    }));
  await f.reaper.sweep('slot-a');
  assert.deepEqual(decisions, ['slot-a/server skip: no watch']);
});

test('an observation lost during the expiring sweep refuses the stop', async () => {
  const f = fixture();
  let losses = 0;
  f.deps.observed = () => losses;
  await f.reaper.sweep('slot-a');
  f.advance();
  const census = f.deps.census;
  f.deps.census = async (slotId) => {
    losses++; // unknown, then running again, while the census runs
    return census(slotId);
  };
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0);
  f.deps.census = census;
  const pointer = f.deps.pointer;
  f.advance();
  await f.reaper.sweep('slot-a');
  f.advance();
  f.deps.pointer = (slotId, resourceId, refresh) => {
    if (refresh) losses++; // lost during the stop's ownership recheck
    return pointer(slotId, resourceId, refresh);
  };
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0, 'the final stop guard rechecks observation');
});

test('an observation lost during an awaited quiet check writes no marker and stops nothing', async () => {
  const f = fixture();
  let losses = 0;
  let calls = 0;
  let loseAt = 0; // which lease check of the sweep sees the loss
  f.deps.observed = () => losses;
  f.deps.retained = async () => {
    if (++calls === loseAt) losses++;
    return false;
  };
  await f.reaper.sweep('slot-a');
  f.advance();
  // Lease checks in an expiring sweep: the loop, the pre-marker quiet check, the stop recheck.
  calls = 0;
  loseAt = 2;
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0);
  assert.equal((await f.deps.row('slot-a'))?.idle_devservers, undefined, 'no restart marker');
  calls = 0;
  loseAt = 0;
  await f.reaper.sweep('slot-a');
  f.advance();
  calls = 0;
  loseAt = 3;
  await f.reaper.sweep('slot-a');
  assert.equal(f.stopped(), 0, 'a loss during the final quiet check refuses the stop');
});
