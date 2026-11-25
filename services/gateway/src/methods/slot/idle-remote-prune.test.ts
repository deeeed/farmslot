import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult } from '../../core/index.js';

import {
  type IdlePruneCandidate,
  type IdleRemotePruneDeps,
  pruneIdleSlotRemoteRefs,
  resetIdleRemotePruneForTest,
} from './idle-remote-prune.js';

type Row = Record<string, unknown>;

const idle = (slot: string): IdlePruneCandidate => ({ slot, lifecycle: 'ready', phase: null });
const idleRow: Row = { lifecycle: 'ready', phase: null, current_run_id: null };
const pruned: ExecResult = {
  exitCode: 0,
  stdout: 'farmslot-git-maintenance: pruned 2 remote refs whose branch is gone\n',
  stderr: '',
};

function harness(
  rows: Record<string, Row>,
  run?: (slotId: string) => Promise<ExecResult> | ExecResult,
) {
  let clock = 1_000_000;
  const ran: string[] = [];
  const logs: string[] = [];
  const guards = new Set<string>();
  const deps: IdleRemotePruneDeps = {
    readRow: async (id) => rows[id] ?? null,
    assertPrunable: async (id) => {
      if (id.startsWith('operator')) throw new Error('slot repo is the operator root');
    },
    run: async (slotId) => {
      ran.push(slotId);
      return run ? run(slotId) : pruned;
    },
    guards,
    now: () => clock,
    log: (line) => logs.push(line),
  };
  return { ran, logs, guards, deps, advance: (ms: number) => (clock += ms) };
}

test('one released idle slot per pass; busy, held, active and guarded slots are left alone', async (t) => {
  t.after(resetIdleRemotePruneForTest);
  const slots: IdlePruneCandidate[] = [
    { slot: 'busy-1', lifecycle: 'busy', phase: 'working', currentRunId: 'run-1' },
    { slot: 'held-1', lifecycle: 'held', phase: 'ci-watch' },
    idle('pinned-1'),
    idle('preparing-1'),
    idle('handoff-1'),
    idle('idle-1'),
    idle('idle-2'),
  ];
  const rows: Record<string, Row> = {
    'handoff-1': { ...idleRow, handoff_run_id: 'run-2' },
    'idle-1': idleRow,
    'idle-2': idleRow,
  };
  const h = harness(rows);
  h.guards.add('preparing-1');
  await pruneIdleSlotRemoteRefs(slots, new Set(['pinned-1']), h.deps);
  assert.deepEqual(h.ran, [], 'the status row of handoff-1 is not idle');
  await pruneIdleSlotRemoteRefs(slots, new Set(['pinned-1']), h.deps);
  assert.deepEqual(h.ran, ['idle-1']);
  assert.ok(h.logs.some((line) => line.includes('idle-1: git maintenance: pruned 2 remote refs')));
  await pruneIdleSlotRemoteRefs(slots, new Set(['pinned-1']), h.deps);
  assert.deepEqual(h.ran, ['idle-1', 'idle-2'], 'a pruned slot waits for its window');
});

test("a prune holds the slot's prepare guard, so a prepare cannot overlap it", async (t) => {
  t.after(resetIdleRemotePruneForTest);
  let release = (_value: ExecResult) => {};
  const h = harness(
    { 'idle-1': idleRow, 'idle-2': idleRow },
    () => new Promise<ExecResult>((resolve) => (release = resolve)),
  );
  const pass = pruneIdleSlotRemoteRefs([idle('idle-1')], new Set(), h.deps);
  await new Promise((resolve) => setImmediate(resolve));
  // slotPrepare refuses a slot in this set ('already preparing'); find-slot waits for it.
  assert.ok(h.guards.has('idle-1'));
  await pruneIdleSlotRemoteRefs([idle('idle-1'), idle('idle-2')], new Set(), h.deps);
  assert.deepEqual(h.ran, ['idle-1'], 'a pass already running makes the next a no-op');
  release(pruned);
  await pass;
  assert.equal(h.guards.has('idle-1'), false);
});

test('a failed prune, a timeout or an unreachable node backs off one hour, never throws', async (t) => {
  t.after(resetIdleRemotePruneForTest);
  const results: Record<string, ExecResult | Error> = {
    'failed-1': {
      exitCode: 3,
      stdout: 'farmslot-git-maintenance: remote prune failed: fatal: could not read from remote\n',
      stderr: '',
    },
    'timeout-1': { exitCode: 124, stdout: '', stderr: 'command timed out after 60000ms\n' },
    'offline-1': new Error('node mini is disconnected'),
  };
  const h = harness(
    { 'failed-1': idleRow, 'timeout-1': idleRow, 'offline-1': idleRow, 'operator-1': idleRow },
    (id) => {
      const result = results[id]!;
      if (result instanceof Error) throw result;
      return result;
    },
  );
  const slots = ['failed-1', 'timeout-1', 'offline-1', 'operator-1'].map(idle);
  for (let pass = 0; pass < 4; pass++) await pruneIdleSlotRemoteRefs(slots, new Set(), h.deps);
  assert.deepEqual(h.ran, ['failed-1', 'timeout-1', 'offline-1'], 'the operator root never runs');
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
  assert.ok(
    h.logs.includes('[slot] operator-1: remote prune unavailable: slot repo is the operator root'),
  );
  h.advance(59 * 60_000);
  await pruneIdleSlotRemoteRefs(slots, new Set(), h.deps);
  assert.equal(h.ran.length, 3, 'inside the one-hour backoff nothing is retried');
  h.advance(2 * 60_000);
  await pruneIdleSlotRemoteRefs(slots, new Set(), h.deps);
  assert.deepEqual(
    h.ran.slice(3),
    ['failed-1'],
    'after the backoff the failed slot is tried first',
  );
});
