import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindSignalToMonitorContext,
  isWorkerSignalFreshForRun,
  type MonitorNudgeRunView,
  runHasOpenHumanGate,
  shouldHoldForInteractivePrComplete,
  shouldHoldForMissingTerminalSignal,
  shouldSkipMonitorNudge,
  signalMatchesMonitorContext,
} from './run-monitor.js';

function devRunView(overrides: Partial<MonitorNudgeRunView> = {}): MonitorNudgeRunView {
  return {
    flowType: 'dev',
    status: 'monitoring',
    steps: [],
    decisions: [],
    ...overrides,
  };
}

test('isWorkerSignalFreshForRun rejects terminal signals from an earlier monitor attempt', () => {
  const run = {
    steps: [{ name: 'monitor', status: 'running' as const, startedAt: '2026-04-25T08:09:45.730Z' }],
  };

  assert.equal(
    isWorkerSignalFreshForRun(run, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T08:05:32Z',
    }),
    false,
  );
});

test('isWorkerSignalFreshForRun accepts terminal signals from the current monitor attempt', () => {
  const run = {
    steps: [{ name: 'monitor', status: 'running' as const, startedAt: '2026-04-25T08:09:45.730Z' }],
  };

  assert.equal(
    isWorkerSignalFreshForRun(run, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T08:09:46Z',
    }),
    true,
  );
});

test('isWorkerSignalFreshForRun accepts recovered signals written after the durable monitor start', () => {
  const run = {
    monitorState: {
      nudgeCount: 0,
      lastPollAt: '2026-04-25T08:20:00Z',
      startedAt: '2026-04-25T08:00:00Z',
    },
    steps: [
      { name: 'dispatch', status: 'done' as const, completedAt: '2026-04-25T08:00:00Z' },
      { name: 'monitor', status: 'running' as const, startedAt: '2026-04-25T08:20:00Z' },
    ],
    agentContexts: [{ id: 'fix-bug', role: 'fix-bug' as const, startedAt: '2026-04-25T08:00:00Z' }],
  };

  assert.equal(
    isWorkerSignalFreshForRun(run, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T08:05:00Z',
      contextId: 'fix-bug',
      role: 'fix-bug',
    }),
    true,
  );
});

test('isWorkerSignalFreshForRun rejects signals older than the current dispatch', () => {
  const run = {
    monitorState: {
      nudgeCount: 0,
      lastPollAt: '2026-04-25T08:20:00Z',
      startedAt: '2026-04-25T07:00:00Z',
    },
    steps: [
      { name: 'dispatch', status: 'done' as const, completedAt: '2026-04-25T08:00:00Z' },
      { name: 'monitor', status: 'running' as const, startedAt: '2026-04-25T08:20:00Z' },
    ],
    agentContexts: [{ id: 'fix-bug', role: 'fix-bug' as const, startedAt: '2026-04-25T08:00:00Z' }],
  };

  assert.equal(
    isWorkerSignalFreshForRun(run, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T07:30:00Z',
      contextId: 'fix-bug',
      role: 'fix-bug',
    }),
    false,
  );
});

test('bindSignalToMonitorContext lets recovery match untagged flow-owned signals', () => {
  const monitorContext = { id: 'fix-bug', role: 'fix-bug' as const };
  const signal = bindSignalToMonitorContext(
    { status: 'failed', outcome: 'failure', timestamp: '2026-04-25T08:09:46Z' },
    monitorContext,
  );

  assert.equal(signal.role, 'fix-bug');
  assert.equal(signal.contextId, 'fix-bug');
  assert.equal(signalMatchesMonitorContext(signal, monitorContext), true);
});

test('bindSignalToMonitorContext preserves explicit mismatched signal tags', () => {
  const monitorContext = { id: 'review', role: 'review' as const };
  const signal = bindSignalToMonitorContext(
    { status: 'blocked', role: 'fix-bug', contextId: 'fix-bug', timestamp: '2026-04-25T08:09:46Z' },
    monitorContext,
  );

  assert.equal(signal.role, 'fix-bug');
  assert.equal(signal.contextId, 'fix-bug');
  assert.equal(signalMatchesMonitorContext(signal, monitorContext), false);
});

test('shouldHoldForMissingTerminalSignal respects contract and interactive pr-complete default', () => {
  assert.equal(
    shouldHoldForMissingTerminalSignal(
      { requireSignal: true } as any,
      {
        flowType: 'dev',
        mode: 'autonomous',
      } as any,
    ),
    true,
  );
  assert.equal(
    shouldHoldForMissingTerminalSignal(
      { requireSignal: false } as any,
      {
        flowType: 'pr-complete',
        mode: 'interactive',
      } as any,
    ),
    false,
  );
  assert.equal(
    shouldHoldForMissingTerminalSignal(null, {
      flowType: 'pr-complete',
      mode: 'interactive',
    } as any),
    false,
  );
  assert.equal(
    shouldHoldForMissingTerminalSignal(null, { flowType: 'dev', mode: 'autonomous' } as any),
    true,
  );
});

test('runHasOpenHumanGate detects active publication gate and unresolved decisions', () => {
  assert.equal(
    runHasOpenHumanGate({
      status: 'blocked',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [],
    }),
    true,
  );
  assert.equal(
    runHasOpenHumanGate({
      status: 'blocked',
      steps: [{ name: 'monitor', status: 'done' }],
      decisions: [{ type: 'engine_human_gate' }],
    }),
    true,
  );
  assert.equal(
    runHasOpenHumanGate({
      status: 'monitoring',
      steps: [{ name: 'monitor', status: 'running' }],
      decisions: [],
    }),
    false,
  );
});

test('shouldSkipMonitorNudge suppresses human-gate and live-worker violations', () => {
  const blockedGate = devRunView({
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [{ type: 'engine_human_gate' }],
  });

  assert.equal(shouldSkipMonitorNudge(blockedGate, { type: 'stuck' }, 'idle'), true);
  assert.equal(shouldSkipMonitorNudge(blockedGate, { type: 'waiting' }, 'working'), true);

  const activeWorker = devRunView();
  assert.equal(shouldSkipMonitorNudge(activeWorker, { type: 'stuck' }, 'working'), false);
  assert.equal(shouldSkipMonitorNudge(activeWorker, { type: 'waiting' }, 'working'), true);
  assert.equal(shouldSkipMonitorNudge(activeWorker, { type: 'stuck' }, 'idle'), false);
});

test('shouldHoldForInteractivePrComplete only gates interactive PR-complete handoff runs', () => {
  assert.equal(
    shouldHoldForInteractivePrComplete({ flowType: 'pr-complete', mode: 'interactive' } as any),
    true,
  );
  assert.equal(
    shouldHoldForInteractivePrComplete({ flowType: 'pr-complete', mode: 'autonomous' } as any),
    false,
  );
  assert.equal(
    shouldHoldForInteractivePrComplete({ flowType: 'dev', mode: 'interactive' } as any),
    false,
  );
});
