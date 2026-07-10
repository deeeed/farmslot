import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from './run/test-fixtures.js';
import { reconcileRefreshSlotRowWithActiveRun } from './fleet.js';

function makeRefreshRow(overrides: Record<string, unknown> = {}) {
  return {
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
