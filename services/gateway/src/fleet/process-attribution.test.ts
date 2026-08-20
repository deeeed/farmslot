import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NodeProcessInventory, Run, SlotStatus, TmuxWorkerSummary } from '@farmslot/protocol';

import { attributeProcessInventory } from './process-attribution.js';

const processes: NodeProcessInventory = {
  generation: 'test-generation',
  sampleId: 1,
  collectedAt: '2026-08-20T00:00:00.000Z',
  totalProcesses: 10,
  maxEntries: 256,
  truncated: false,
  health: {
    attempts: 1,
    executions: 1,
    failures: 0,
    skippedBusy: 0,
    skippedCadence: 0,
    lastDurationMs: 2,
  },
  processes: Array.from({ length: 10 }, (_, index) => ({
    pid: index + 10,
    ppid: 1,
    cpuPercent: index + 1,
    rssBytes: 1_000,
    elapsedSeconds: 10,
    executable: `process-${index + 10}`,
  })),
};

function slot(
  id: string,
  lifecycle: SlotStatus['lifecycle'],
  currentRunId: string | null,
  repo?: string,
) {
  return { slot: id, lifecycle, currentRunId, repo } as SlotStatus;
}

function run(id: string, status: Run['status']): Run {
  return { id, status } as Run;
}

function worker(
  pid: number,
  target: string,
  options: Partial<TmuxWorkerSummary> = {},
): TmuxWorkerSummary {
  return {
    ref: { nodeId: 'node', session: target, target },
    pid,
    status: { label: 'tmux', source: 'tmux', confidence: 'medium', state: 'active' },
    ...options,
  };
}

test('process attribution covers all ownership classes and never cleans manual or unknown', () => {
  const result = attributeProcessInventory({
    inventory: processes,
    slots: [
      slot('active-slot', 'busy', 'active-run'),
      slot('retained-slot', 'held', 'done-run'),
      slot('stale-slot', 'ready', 'new-run'),
      slot('manual-slot', 'manual', null),
    ],
    runs: [run('active-run', 'monitoring'), run('done-run', 'done'), run('old-run', 'done')],
    workers: [
      worker(10, 'active', { linkedSlotId: 'active-slot', linkedRunId: 'active-run' }),
      worker(11, 'retained', { linkedSlotId: 'retained-slot', linkedRunId: 'done-run' }),
      worker(12, 'stale', { linkedSlotId: 'stale-slot', linkedRunId: 'old-run' }),
      worker(13, 'manual', { linkedSlotId: 'manual-slot' }),
    ],
    resources: [],
  });
  assert.deepEqual(result.classCounts, {
    active: 1,
    retained: 1,
    stale: 1,
    manual: 1,
    unknown: 6,
  });
  assert.equal(
    result.groups.find((group) => group.classification === 'stale')?.cleanupEligible,
    true,
  );
  assert.ok(
    result.groups
      .filter((group) => group.classification === 'manual' || group.classification === 'unknown')
      .every((group) => !group.cleanupEligible),
  );
});

test('tmux cwd infers active slot ownership when session correlation is unavailable', () => {
  const result = attributeProcessInventory({
    inventory: processes,
    slots: [slot('active-slot', 'busy', 'active-run', '/Users/dev/repo')],
    runs: [run('active-run', 'monitoring')],
    workers: [worker(10, 'unmatched-session', { cwd: '/Users/dev/repo/packages/app' })],
    resources: [],
  });
  const active = result.groups.find((group) => group.rootPid === 10);
  assert.equal(active?.classification, 'active');
  assert.equal(active?.slotId, 'active-slot');
  assert.equal(active?.runId, 'active-run');
});

test('configured resource ownership attributes descendants through process ancestry', () => {
  const inventory = structuredClone(processes);
  inventory.processes[5].ppid = 14;
  const result = attributeProcessInventory({
    inventory,
    slots: [slot('resource-slot', 'busy', 'active-run')],
    runs: [run('active-run', 'monitoring')],
    workers: [],
    resources: [
      {
        pid: 14,
        slotId: 'resource-slot',
        resourceId: 'metro',
        runId: 'active-run',
        status: 'running',
      },
    ],
  });
  const resourceGroup = result.groups.find((group) => group.resourceId === 'metro');
  assert.equal(resourceGroup?.classification, 'active');
  assert.equal(resourceGroup?.processCount, 2);
  assert.equal(resourceGroup?.confidence, 'high');
});

test('an unmapped tmux tree is manual rather than an unknown system process', () => {
  const inventory = structuredClone(processes);
  inventory.processes = [
    { ...inventory.processes[0], pid: 100, ppid: 1, executable: '/opt/homebrew/bin/tmux' },
    { ...inventory.processes[1], pid: 101, ppid: 100, executable: 'git' },
  ];
  const result = attributeProcessInventory({
    inventory,
    slots: [],
    runs: [],
    workers: [],
    resources: [],
  });
  assert.equal(result.groups[0].classification, 'manual');
  assert.equal(result.groups[0].confidence, 'low');
  assert.equal(result.groups[0].cleanupEligible, false);
});
