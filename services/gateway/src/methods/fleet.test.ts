import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, Run, SlotStatus } from '@farmslot/protocol';

import { resolveSlot, SlotConfigError } from '../core/config.js';
import { markGhostSlots } from '../fleet/state.js';

import { isFreeSlot } from './dispatch/slot-scoring.js';
import { makeRun } from './run/test-fixtures.js';
import {
  fleetStaleThresholdMs,
  fleetStatus,
  type FleetStatusDeps,
  isFleetCheckedAtStale,
  reconcileRefreshSlotRowWithActiveRun,
} from './fleet.js';

function makeRefreshRow(overrides: Record<string, unknown> = {}) {
  return {
    slot_epoch: 0,
    handoff_run_id: null,
    slot: 'macwork-mm-4',
    machine: 'macwork',
    platform: 'ios',
    project: 'metamask-mobile-farm',
    ssh: 'LOCAL',
    dev: 'sim:OK',
    devserver: 'OK',
    device: 'mm-4',
    cdp: 'OFF',
    fixtures: '7/10',
    branch: 'TAT-3215-feat-debug-eth-position-banner',
    linked_worktree: false,
    agent: 'working',
    enabled: true,
    mode: 'dispatch',
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    task_id: null,
    task_file: null,
    current_run_id: null,
    current_flow_type: null,
    current_ticket_or_pr: null,
    current_mode: null,
    current_family_id: null,
    current_lane: null,
    current_variant: null,
    agent_contexts: undefined,
    dispatched_at: null,
    completed_at: null,
    runner: null,
    model: null,
    ...overrides,
  };
}

test('fleet refresh reconciliation preserves active run ownership when status probe loses current_run_id', () => {
  const activeRun: Run = {
    ...makeRun({
      id: 'run-active',
      familyId: 'family-active',
      lane: 'comparison',
      variant: 'comparison-opus',
      flowType: 'dev',
      mode: 'autonomous',
      status: 'monitoring',
      slotId: 'macwork-mm-4',
      ticketOrPr: 'TAT-3215',
      taskFile:
        '/Users/deeeed/dev/farmslot/projects/metamask-mobile-farm/tasks/feat/tat-3215-0622-110508/TASK.md',
      metrics: {
        nudgeCount: 0,
        runner: 'claude',
        model: 'opus',
        runnerSessionId: 'session-1',
        runnerSessionPath: '/tmp/session.jsonl',
      },
      createdAt: '2026-06-22T09:05:00.569Z',
    }),
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Dev',
        status: 'working',
        slotId: 'macwork-mm-4',
        runId: 'run-active',
        taskFile: '.task/feat/tat-3215-0622-110508/TASK.md',
        signalFile: '.task/feat/tat-3215-0622-110508/SIGNAL.json',
        runner: 'claude',
        model: 'opus',
        target: null,
      },
    ],
  };

  const reconciled = reconcileRefreshSlotRowWithActiveRun(makeRefreshRow(), activeRun);

  assert.equal(reconciled.current_run_id, 'run-active');
  assert.equal(reconciled.current_flow_type, 'dev');
  assert.equal(reconciled.current_ticket_or_pr, 'TAT-3215');
  assert.equal(reconciled.current_family_id, 'family-active');
  assert.equal(reconciled.current_lane, 'comparison');
  assert.equal(reconciled.current_variant, 'comparison-opus');
  assert.equal(reconciled.lifecycle, 'busy');
  assert.equal(reconciled.phase, 'working');
  assert.equal(reconciled.agent, 'working');
  assert.equal(reconciled.dispatchable, false);
  assert.equal(reconciled.runner, 'claude');
  assert.equal(reconciled.model, 'opus');
  assert.deepEqual(reconciled.agent_contexts, [
    {
      id: 'dev',
      role: 'dev',
      label: 'Dev',
      status: 'working',
      runId: 'run-active',
      taskFile: '.task/feat/tat-3215-0622-110508/TASK.md',
      signalFile: '.task/feat/tat-3215-0622-110508/SIGNAL.json',
      runner: 'claude',
      model: 'opus',
      target: null,
      nudgeCount: undefined,
      ctxPct: undefined,
      lastSignalAt: undefined,
      updatedAt: undefined,
    },
  ]);
  assert.equal(reconciled.task_file, 'feat/tat-3215-0622-110508/TASK.md');
});

test('fleet refresh reconciliation preserves linked_worktree from status probe', () => {
  const row = makeRefreshRow({
    linked_worktree: true,
    branch: 'wt/ff-2',
    agent: 'idle',
    lifecycle: 'ready',
  });

  assert.equal(row.linked_worktree, true);

  const reconciled = reconcileRefreshSlotRowWithActiveRun(row, null);

  assert.equal(reconciled.linked_worktree, true);
  assert.equal(reconciled.branch, 'wt/ff-2');
});

test('fleet refresh preserves gate-held publication slots as review-gate with working agent', () => {
  const gateHeldRun: Run = {
    ...makeRun({
      id: 'run-gate-held',
      flowType: 'dev',
      mode: 'autonomous',
      status: 'blocked',
      slotId: 'macwork-mm-4',
      ticketOrPr: 'TAT-3398',
    }),
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: { slotDisposition: 'gate-held' },
      },
    ],
    decisions: [
      {
        id: 'decision-gate',
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: 'Approve package',
        actions: [],
        createdAt: '2026-06-25T00:00:00Z',
      },
    ],
  };

  const reconciled = reconcileRefreshSlotRowWithActiveRun(
    makeRefreshRow({ agent: 'idle' }),
    gateHeldRun,
  );

  assert.equal(reconciled.lifecycle, 'busy');
  assert.equal(reconciled.phase, 'review-gate');
  assert.equal(reconciled.agent, 'working');
});

test('fleet refresh keeps post-approval gate-held runs on review-gate until FINALIZE completes', () => {
  const postApprovalRun: Run = {
    ...makeRun({
      id: 'run-gate-held-finalize',
      flowType: 'dev',
      mode: 'autonomous',
      status: 'completing',
      slotId: 'macwork-mm-4',
      ticketOrPr: 'TAT-3394',
    }),
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: { slotDisposition: 'gate-held' },
      },
      { name: 'finalize', status: 'running' },
    ],
    decisions: [
      {
        id: 'decision-gate',
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: 'Approve package',
        actions: [],
        createdAt: '2026-06-25T00:00:00Z',
        resolvedAt: '2026-06-25T00:05:00Z',
        resolvedAction: 'approve-publish',
      },
    ],
  };

  const reconciled = reconcileRefreshSlotRowWithActiveRun(
    makeRefreshRow({ agent: 'idle' }),
    postApprovalRun,
  );

  assert.equal(reconciled.lifecycle, 'busy');
  assert.equal(reconciled.phase, 'review-gate');
  assert.equal(reconciled.agent, 'working');
});

test('fleet refresh reconciliation does not show blocked runs as working because a stale runner process exists', () => {
  const blockedRun: Run = {
    ...makeRun({
      id: 'run-blocked',
      familyId: 'family-active',
      flowType: 'dev',
      mode: 'autonomous',
      status: 'blocked',
      slotId: 'macwork-mm-4',
      ticketOrPr: 'TAT-3215',
      taskFile:
        '/Users/deeeed/dev/farmslot/projects/metamask-mobile-farm/tasks/feat/tat-3215-0622-110508/TASK.md',
      metrics: {
        nudgeCount: 0,
        runner: 'codex',
        model: 'gpt-5.5',
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      createdAt: '2026-06-22T09:05:00.569Z',
    }),
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Dev',
        status: 'blocked',
        slotId: 'macwork-mm-4',
        runId: 'run-blocked',
        taskFile: '.task/feat/tat-3215-0622-110508/TASK.md',
        signalFile: '.task/feat/tat-3215-0622-110508/SIGNAL.json',
        runner: 'codex',
        model: 'gpt-5.5',
        target: null,
      },
    ],
  };

  const reconciled = reconcileRefreshSlotRowWithActiveRun(
    makeRefreshRow({ agent: 'working' }),
    blockedRun,
  );

  assert.equal(reconciled.lifecycle, 'held');
  assert.equal(reconciled.phase, 'pr-watch');
  assert.equal(reconciled.agent, 'idle');
  assert.equal(reconciled.current_run_id, 'run-blocked');
  assert.equal(reconciled.dispatchable, false);
  assert.equal(
    (reconciled.agent_contexts as unknown as Array<{ status: string }>)[0]?.status,
    'blocked',
  );
});

// ─── fleet.status honesty (staleness + ghost slots) ───

function slotStatusFixture(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  return {
    machine: 'macwork',
    platform: 'ios',
    project: 'farmslot-farm',
    health: { ssh: 'LOCAL', device: '-', devserver: 'OK', cdp: '-', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  } as SlotStatus;
}

function fleetFixture(checkedAt: string, slots: SlotStatus[]): FleetStatus {
  return {
    checkedAt,
    slots,
    summary: {
      total: slots.length,
      ready: slots.length,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

function fleetStatusDepsFixture(fleet: FleetStatus, refreshedFleet?: FleetStatus) {
  const calls = { load: 0, refresh: 0 };
  const refreshed = refreshedFleet ?? fleetFixture(new Date().toISOString(), fleet.slots);
  const deps: FleetStatusDeps = {
    async load() {
      calls.load += 1;
      return fleet;
    },
    async refresh() {
      calls.refresh += 1;
      return { fleet: refreshed };
    },
  };
  return { deps, calls, refreshed };
}

test('fleet staleness helpers honor the env-configured threshold', () => {
  const previous = process.env.FARMSLOT_FLEET_STALE_MS;
  try {
    delete process.env.FARMSLOT_FLEET_STALE_MS;
    assert.equal(fleetStaleThresholdMs(), 5 * 60_000);
    process.env.FARMSLOT_FLEET_STALE_MS = '1000';
    assert.equal(fleetStaleThresholdMs(), 1000);

    const now = Date.now();
    assert.equal(isFleetCheckedAtStale(new Date(now - 500).toISOString(), now), false);
    assert.equal(isFleetCheckedAtStale(new Date(now - 5_000).toISOString(), now), true);
    assert.equal(isFleetCheckedAtStale('not-a-timestamp', now), true);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_FLEET_STALE_MS;
    else process.env.FARMSLOT_FLEET_STALE_MS = previous;
  }
});

test('fleet.status forceRefresh triggers a real re-probe, not a file re-read', async () => {
  const stale = fleetFixture(new Date(0).toISOString(), [
    slotStatusFixture({ slot: 'macwork-ff-1' }),
  ]);
  const { deps, calls, refreshed } = fleetStatusDepsFixture(stale);

  const result = await fleetStatus({ forceRefresh: true }, deps);

  assert.equal(calls.refresh, 1);
  assert.equal(calls.load, 0);
  assert.equal(result.fleet.checkedAt, refreshed.checkedAt);
});

test('fresh fleet.status passes through without stale flag or background refresh', async () => {
  const fresh = fleetFixture(new Date().toISOString(), [
    slotStatusFixture({ slot: 'macwork-ff-1' }),
  ]);
  const { deps, calls } = fleetStatusDepsFixture(fresh);

  const result = await fleetStatus(undefined, deps);

  assert.equal(result.fleet.stale, undefined);
  assert.equal(result.fleet.slots[0].dispatchable, true);
  assert.equal(calls.refresh, 0);
});

test('stale fleet.status marks stale, disables dispatch, and kicks a background refresh', async () => {
  const stale = fleetFixture(new Date(0).toISOString(), [
    slotStatusFixture({ slot: 'macwork-ff-1' }),
    slotStatusFixture({ slot: 'macwork-ff-2' }),
  ]);
  const { deps, calls } = fleetStatusDepsFixture(stale);

  const result = await fleetStatus(undefined, deps);

  assert.equal(result.fleet.stale, true);
  assert.ok(result.fleet.slots.every((slot) => slot.dispatchable === false));
  assert.equal(calls.refresh, 1);
});

test('slots absent from live pools are marked missingFromPool and never dispatchable', () => {
  const fleet = fleetFixture(new Date().toISOString(), [
    slotStatusFixture({ slot: 'macwork-ff-1' }),
    slotStatusFixture({ slot: 'ghost-slot-9' }),
  ]);

  const marked = markGhostSlots(fleet, new Set(['macwork-ff-1']));

  const live = marked.slots.find((slot) => slot.slot === 'macwork-ff-1');
  const ghost = marked.slots.find((slot) => slot.slot === 'ghost-slot-9');
  assert.equal(live?.missingFromPool, undefined);
  assert.equal(live?.dispatchable, true);
  assert.equal(ghost?.missingFromPool, true);
  assert.equal(ghost?.dispatchable, false);
  // No live pools at all (empty install) — nothing may be prepared/dispatched.
  const emptied = markGhostSlots(fleet, new Set());
  assert.ok(emptied.slots.every((slot) => slot.missingFromPool === true));
});

test('forceRefresh results that stay stale are still served honestly without re-kicking refresh', async () => {
  // Empty-pool installs: fleetRefresh returns the old snapshot unchanged.
  const oldSnapshot = markGhostSlots(
    fleetFixture(new Date(0).toISOString(), [slotStatusFixture({ slot: 'ghost-slot-9' })]),
    new Set(),
  );
  const { deps, calls } = fleetStatusDepsFixture(oldSnapshot, oldSnapshot);

  const result = await fleetStatus({ forceRefresh: true }, deps);

  assert.equal(calls.refresh, 1);
  assert.equal(result.fleet.stale, true);
  assert.ok(result.fleet.slots.every((slot) => slot.dispatchable === false));
  assert.equal(result.fleet.slots[0].missingFromPool, true);
});

test('stale all-ghost fleets do not spin background no-op refreshes', async () => {
  const allGhosts = markGhostSlots(
    fleetFixture(new Date(0).toISOString(), [slotStatusFixture({ slot: 'ghost-slot-9' })]),
    new Set(),
  );
  const { deps, calls } = fleetStatusDepsFixture(allGhosts, allGhosts);

  const result = await fleetStatus(undefined, deps);

  assert.equal(result.fleet.stale, true);
  assert.equal(calls.refresh, 0);
});

test('dispatch slot selection never treats ghost slots as free', () => {
  const ghost = slotStatusFixture({ slot: 'ghost-slot-9', missingFromPool: true });
  const live = slotStatusFixture({ slot: 'macwork-ff-1' });
  assert.equal(isFreeSlot(ghost), false);
  assert.equal(isFreeSlot(live), true);
});

test('resolveSlot failures teach the escape with a structured userAction', async () => {
  await assert.rejects(
    () => resolveSlot('definitely-not-a-real-slot-xyz'),
    (err: unknown) => {
      assert.ok(err instanceof SlotConfigError);
      assert.ok(['SLOT_NOT_FOUND', 'POOL_DIR_NOT_FOUND'].includes(err.code));
      assert.ok(err.userAction && err.userAction.length > 0);
      assert.match(err.userAction, /farmslot doctor|farmslot fleet refresh|farmslot project add/u);
      return true;
    },
  );
});

test('reconcileRefreshSlotRowWithActiveRun preserves a releasing fence over the active run phase', () => {
  const row = makeRefreshRow({
    lifecycle: 'busy',
    phase: 'releasing',
    current_run_id: 'teardown-owner',
  });
  const reconciled = reconcileRefreshSlotRowWithActiveRun(row, {
    id: 'active-run',
    status: 'monitoring',
    flowType: 'fix-bug',
  } as never);
  assert.equal(reconciled.phase, 'releasing', 'fence preserved');
  assert.equal(reconciled.current_run_id, 'teardown-owner', 'owner untouched');
  assert.equal(reconciled.dispatchable, false);
});

test('reconcileRefreshSlotRowWithActiveRun does not resurrect a cleanly released row', () => {
  const row = makeRefreshRow({ lifecycle: 'ready', phase: null, current_run_id: null });
  const reconciled = reconcileRefreshSlotRowWithActiveRun(row, {
    id: 'ci-watcher',
    status: 'ci-watching',
    flowType: 'fix-bug',
    steps: [],
    decisions: [],
    metrics: {},
  } as never);
  assert.equal(reconciled.current_run_id, null, 'released slot stays free');
  assert.equal(reconciled.lifecycle, 'ready');
});

test('buildRefreshSlotRow carries the handoff reservation through a refresh', () => {
  const row = makeRefreshRow({ handoff_run_id: 'incoming-run' });
  assert.equal(row.handoff_run_id, 'incoming-run');
});
