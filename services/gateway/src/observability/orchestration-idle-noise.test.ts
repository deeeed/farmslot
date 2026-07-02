import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, type FleetStatus, PipelineSteps, type SlotStatus } from '@farmslot/protocol';

import {
  __drainAutoRecoveryForTest,
  __resetAutoRecoveryForTest,
  initAutoRecovery,
  routeEventToAutoRecovery,
} from '../auto-recovery/watcher.js';
import {
  cleanupRun,
  makeProject,
  withTempAuditDir,
} from '../auto-recovery/watcher-test-fixtures.js';
import { createRun, updateRun } from '../runs/store.js';

import { detectFleetMonitorViolations } from './fleet-monitor.js';

function slot(overrides: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'macwork-core-1',
    machine: 'macwork',
    platform: 'cli',
    project: 'metamask-core-farm',
    health: { ssh: 'LOCAL', device: '', devserver: 'OFF', cdp: 'OFF', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'busy',
    phase: 'preparing',
    warm: false,
    taskId: 'TAT-3216',
    taskFile: null,
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    currentMode: null,
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    dispatchedAt: null,
    completedAt: null,
    runner: 'cursor',
    model: 'composer-2.5',
    deviceName: '',
    taskPhase: null,
    taskStepProgress: null,
    resourceRollup: 'none',
    ...overrides,
  } as SlotStatus;
}

function fleet(slots: SlotStatus[]): FleetStatus {
  return {
    checkedAt: '2026-07-02T12:34:34.002Z',
    slots,
    summary: {
      total: slots.length,
      ready: 0,
      busy: slots.length,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
    machines: [],
  };
}

test('production repro: orchestration busy+idle does not emit monitor or audit noise', async (t) => {
  withTempAuditDir(t);
  const project = await makeProject(t, {
    auto_recovery: {
      enabled: true,
      allowedSteps: ['monitor'],
      allowedCategories: ['timeout'],
    },
  });
  const run = createRun({
    flowType: 'fix-bug',
    project,
    ticketOrPr: 'TAT-3216',
    slotId: 'macwork-core-1',
  });
  updateRun(run.id, {
    status: 'grading',
    steps: run.steps.map((step) =>
      step.name === PipelineSteps.GRADE
        ? { ...step, status: 'running' as const, startedAt: '2026-07-02T12:34:27.291Z' }
        : step,
    ),
  });

  __resetAutoRecoveryForTest();
  initAutoRecovery(() => undefined);
  t.after(async () => {
    __resetAutoRecoveryForTest();
    await cleanupRun(run.id);
  });

  const violations = detectFleetMonitorViolations(
    fleet([slot({ lifecycle: 'busy', phase: 'preparing', agent: 'idle' })]),
    new Set<string>(),
    () => '2026-07-02T12:34:34.002Z',
  );
  assert.deepEqual(violations, []);

  routeEventToAutoRecovery(Events.MONITOR_VIOLATION, {
    violation: {
      slotId: 'macwork-core-1',
      type: 'idle',
      message: 'legacy message that should never arrive during orchestration',
      nudgeSent: null,
      timestamp: '2026-07-02T12:34:34.002Z',
    },
  });
  await __drainAutoRecoveryForTest();

  const auditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  assert.ok(auditDir);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(auditDir);
  assert.deepEqual(files, []);
});
