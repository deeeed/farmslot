import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult } from '../../core/index.js';

import {
  pruneSlotRemoteRefs,
  resetSlotRemotePruneForTest,
  type SlotRemotePruneDeps,
} from './idle-remote-prune.js';

const pruned: ExecResult = {
  exitCode: 0,
  stdout: 'farmslot-git-maintenance: pruned 2 remote refs whose branch is gone\n',
  stderr: '',
};

function harness(results: Record<string, ExecResult | Error> = {}) {
  let clock = 1_000_000;
  const ran: string[] = [];
  const logs: string[] = [];
  const deps: SlotRemotePruneDeps = {
    lastingRefusal: async (id) => {
      if (id === 'disabled-1') return 'slot is disabled';
      if (id === 'operator-1') return 'slot repo is the operator root';
      if (id === 'unreadable-1') throw new Error('slot vars unreadable');
      return null;
    },
    run: async (slotId) => {
      ran.push(slotId);
      const result = results[slotId] ?? pruned;
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => clock,
    log: (line) => logs.push(line),
  };
  return { ran, logs, deps, advance: (ms: number) => (clock += ms) };
}

// Each window is 5 minutes short, so an hourly pass that reaches the slot a little early still runs.
const hours = (n: number) => n * 3_600_000 - 5 * 60_000;

test('a pruned slot is pruned again only after a day', async (t) => {
  t.after(resetSlotRemotePruneForTest);
  const h = harness();
  await pruneSlotRemoteRefs('idle-1', h.deps);
  assert.ok(
    h.logs.includes('[slot] idle-1: git maintenance: pruned 2 remote refs whose branch is gone'),
  );
  h.advance(hours(24) - 1);
  await pruneSlotRemoteRefs('idle-1', h.deps);
  h.advance(1);
  await pruneSlotRemoteRefs('idle-1', h.deps);
  assert.deepEqual(h.ran, ['idle-1', 'idle-1']);
});

test('a failed prune, a timeout, an unreachable node or an unreadable slot is retried after an hour, never thrown', async (t) => {
  t.after(resetSlotRemotePruneForTest);
  const h = harness({
    'failed-1': {
      exitCode: 3,
      stdout: 'farmslot-git-maintenance: remote prune failed: fatal: could not read from remote\n',
      stderr: '',
    },
    'timeout-1': { exitCode: 124, stdout: '', stderr: 'command timed out after 60000ms\n' },
    'offline-1': new Error('node mini is disconnected'),
  });
  const slots = ['failed-1', 'timeout-1', 'offline-1', 'unreadable-1'];
  for (const slot of slots) await pruneSlotRemoteRefs(slot, h.deps);
  assert.ok(
    h.logs.includes(
      '[slot] failed-1: git maintenance: remote prune failed: fatal: could not read from remote',
    ),
  );
  assert.ok(
    h.logs.includes('[slot] timeout-1: remote prune exited 124: command timed out after 60000ms'),
  );
  assert.ok(
    h.logs.includes('[slot] offline-1: remote prune unavailable: node mini is disconnected'),
  );
  assert.ok(h.logs.includes('[slot] unreadable-1: remote prune unavailable: slot vars unreadable'));
  h.advance(hours(1) - 1);
  for (const slot of slots) await pruneSlotRemoteRefs(slot, h.deps);
  assert.equal(h.logs.length, 4, 'inside the backoff nothing is retried');
  h.advance(1);
  for (const slot of slots) await pruneSlotRemoteRefs(slot, h.deps);
  assert.deepEqual(h.ran.slice(3), slots.slice(0, 3));
  assert.equal(h.logs.length, 8, 'the unreadable slot is asked again after the hour');
});

test('a disabled slot or the operator root never runs, and is asked again only after a day', async (t) => {
  t.after(resetSlotRemotePruneForTest);
  const h = harness();
  for (const slot of ['disabled-1', 'operator-1']) await pruneSlotRemoteRefs(slot, h.deps);
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.logs, [
    '[slot] disabled-1: remote prune skipped: slot is disabled',
    '[slot] operator-1: remote prune skipped: slot repo is the operator root',
  ]);
  h.advance(hours(24) - 1);
  for (const slot of ['disabled-1', 'operator-1']) await pruneSlotRemoteRefs(slot, h.deps);
  assert.equal(h.logs.length, 2, 'a lasting refusal is not logged every hour');
  h.advance(1);
  for (const slot of ['disabled-1', 'operator-1']) await pruneSlotRemoteRefs(slot, h.deps);
  assert.equal(h.logs.length, 4, 'and is asked again after a day');
});
