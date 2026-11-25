import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { pruneIdleSlotRemoteRefs, resetIdleRemotePruneForTest } from './idle-remote-prune.js';

type Row = Record<string, unknown>;

function slot(id: string, machine: string, overrides: Partial<SlotStatus> = {}): SlotStatus {
  const base: Partial<SlotStatus> = {
    slot: id,
    machine,
    lifecycle: 'ready',
    phase: null,
    currentRunId: null,
  };
  return { ...base, ...overrides } as SlotStatus;
}

function harness(slots: SlotStatus[], rows: Record<string, Row>, run?: (slotId: string) => unknown) {
  let clock = 1_000_000;
  const ran: string[] = [];
  const logs: string[] = [];
  return {
    ran,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    deps: {
      listSlots: async () => slots,
      readRow: async (id: string) => rows[id] ?? null,
      run: async (slotId: string) => {
        ran.push(slotId);
        const result = run?.(slotId);
        if (result instanceof Error) throw result;
        return (
          (result as { exitCode: number; stdout: string; stderr: string } | undefined) ?? {
            exitCode: 0,
            stdout: 'farmslot-git-maintenance: pruned 2 remote refs whose branch is gone\n',
            stderr: '',
          }
        );
      },
      now: () => clock,
      log: (line: string) => logs.push(line),
    },
  };
}

const idleRow: Row = { lifecycle: 'ready', phase: null, current_run_id: null };

test('only a released idle slot is pruned, one per machine per pass', async (t) => {
  t.after(resetIdleRemotePruneForTest);
  const slots = [
    slot('busy-1', 'm1', { lifecycle: 'busy', phase: 'working', currentRunId: 'run-1' }),
    slot('held-1', 'm1', { lifecycle: 'held', phase: 'ci-watch' }),
    slot('manual-1', 'm1', { lifecycle: 'manual' }),
    slot('handoff-1', 'm1'),
    slot('idle-1', 'm1'),
    slot('idle-2', 'm1'),
    slot('idle-3', 'm2'),
  ];
  const rows: Record<string, Row> = {
    'handoff-1': { ...idleRow, handoff_run_id: 'run-2' },
    'idle-1': idleRow,
    'idle-2': idleRow,
    'idle-3': idleRow,
  };
  const h = harness(slots, rows);
  await pruneIdleSlotRemoteRefs(h.deps);
  assert.deepEqual(h.ran, ['idle-1', 'idle-3']);
  assert.ok(h.logs.some((line) => line.includes('idle-1: git maintenance: pruned 2 remote refs')));
  await pruneIdleSlotRemoteRefs(h.deps);
  assert.deepEqual(h.ran, ['idle-1', 'idle-3', 'idle-2'], 'a pruned slot waits for its window');
});

test('a timed-out or unreachable prune is logged, never thrown, and retried after the backoff', async (t) => {
  t.after(resetIdleRemotePruneForTest);
  const slots = [slot('timeout-1', 'm1'), slot('offline-1', 'm2')];
  const rows = { 'timeout-1': idleRow, 'offline-1': idleRow };
  const h = harness(slots, rows, (id) =>
    id === 'timeout-1'
      ? { exitCode: 124, stdout: '', stderr: 'command timed out after 60000ms\n' }
      : new Error('node mini is disconnected'),
  );
  await pruneIdleSlotRemoteRefs(h.deps);
  assert.deepEqual(h.ran, ['timeout-1', 'offline-1']);
  assert.ok(h.logs.includes('[slot] timeout-1: remote prune exited 124: command timed out after 60000ms'));
  assert.ok(h.logs.includes('[slot] offline-1: remote prune unavailable: node mini is disconnected'));
  h.advance(30 * 60_000);
  await pruneIdleSlotRemoteRefs(h.deps);
  assert.equal(h.ran.length, 2, 'inside the one-hour backoff nothing is retried');
  h.advance(31 * 60_000);
  await pruneIdleSlotRemoteRefs(h.deps);
  assert.deepEqual(h.ran.slice(2), ['timeout-1', 'offline-1']);
});
