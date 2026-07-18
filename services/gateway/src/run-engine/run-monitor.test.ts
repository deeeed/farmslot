import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

import {
  applyHandoffAutoResolution,
  bindSignalToMonitorContext,
  isFreshTerminalHandoffSignal,
  isWorkerSignalFreshForRun,
  type MonitorNudgeRunView,
  resolveMonitorConfig,
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
  // Human-gate skip must win over max-nudge escalation even when nudgeCount is already saturated.
  assert.equal(shouldSkipMonitorNudge(blockedGate, { type: 'waiting' }, 'idle'), true);

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

// ─── Per-flow monitor config (deliverable 1) ───

test('resolveMonitorConfig applies the per-flow total_timeout_min override', () => {
  const cfg = resolveMonitorConfig(
    { total_timeout_min: 90, flows: { 'pr-complete': { total_timeout_min: 180 } } },
    'proj',
    'pr-complete',
  );
  assert.equal(cfg.totalTimeoutMs, 180 * 60_000);
});

test('resolveMonitorConfig applies the per-flow stuck_timeout_min override', () => {
  const cfg = resolveMonitorConfig(
    { stuck_timeout_min: 20, flows: { 'fix-bug': { stuck_timeout_min: 45 } } },
    'proj',
    'fix-bug',
  );
  assert.equal(cfg.stuckTimeoutMs, 45 * 60_000);
});

test('resolveMonitorConfig falls back to the project total for flows without an override', () => {
  const cfg = resolveMonitorConfig(
    { total_timeout_min: 120, flows: { 'pr-complete': { total_timeout_min: 180 } } },
    'proj',
    'dev',
  );
  assert.equal(cfg.totalTimeoutMs, 120 * 60_000);
});

test('resolveMonitorConfig falls back to the default when neither flow nor project value is set', () => {
  const cfg = resolveMonitorConfig(
    { flows: { 'pr-complete': { total_timeout_min: 180 } } },
    'proj',
    'dev',
  );
  assert.equal(cfg.totalTimeoutMs, 90 * 60_000);
  assert.equal(cfg.stuckTimeoutMs, 20 * 60_000);
});

test('resolveMonitorConfig ignores an invalid per-flow override and uses the project value', () => {
  const cfg = resolveMonitorConfig(
    { total_timeout_min: 120, flows: { 'pr-complete': { total_timeout_min: -5 } } },
    'proj',
    'pr-complete',
  );
  assert.equal(cfg.totalTimeoutMs, 120 * 60_000);
});

// ─── Terminal-signal auto-recovery (deliverable 2) ───

const handoffRun = {
  steps: [
    { name: 'monitor' as const, status: 'running' as const, startedAt: '2026-04-25T08:00:00Z' },
  ],
};

test('isFreshTerminalHandoffSignal accepts a fresh terminal signal', () => {
  assert.equal(
    isFreshTerminalHandoffSignal(handoffRun, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T08:30:00Z',
    }),
    true,
  );
});

test('isFreshTerminalHandoffSignal rejects a stale terminal signal predating the worker context', () => {
  assert.equal(
    isFreshTerminalHandoffSignal(handoffRun, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T07:00:00Z',
    }),
    false,
  );
});

test('isFreshTerminalHandoffSignal rejects a non-terminal running signal', () => {
  assert.equal(
    isFreshTerminalHandoffSignal(handoffRun, {
      status: 'running',
      timestamp: '2026-04-25T08:30:00Z',
    }),
    false,
  );
});

test('applyHandoffAutoResolution stamps the decision and resumes for a fresh terminal signal', () => {
  const decision: Pick<RunDecision, 'context'> = { context: { signalFile: 'SIGNAL.json' } };
  const resumed = applyHandoffAutoResolution(
    handoffRun,
    decision,
    { status: 'complete', outcome: 'success', timestamp: '2026-04-25T08:30:00Z' },
    null,
    '2026-04-25T08:30:01Z',
  );
  assert.equal(resumed, true);
  assert.equal(decision.context?.autoResolved, true);
  assert.equal(decision.context?.autoResolvedBy, 'terminal-signal');
  assert.equal(decision.context?.autoResolvedStatus, 'complete');
  assert.equal(decision.context?.autoResolvedAt, '2026-04-25T08:30:01Z');
  // Existing context is preserved, not clobbered.
  assert.equal(decision.context?.signalFile, 'SIGNAL.json');
});

test('applyHandoffAutoResolution leaves the decision untouched for a stale terminal signal', () => {
  const decision: Pick<RunDecision, 'context'> = { context: { signalFile: 'SIGNAL.json' } };
  const resumed = applyHandoffAutoResolution(
    handoffRun,
    decision,
    { status: 'complete', outcome: 'success', timestamp: '2026-04-25T07:00:00Z' },
    null,
    '2026-04-25T08:30:01Z',
  );
  assert.equal(resumed, false);
  assert.equal(decision.context?.autoResolved, undefined);
});

test('applyHandoffAutoResolution never fires for a non-terminal running signal', () => {
  const decision: Pick<RunDecision, 'context'> = { context: {} };
  const resumed = applyHandoffAutoResolution(
    handoffRun,
    decision,
    { status: 'running', timestamp: '2026-04-25T08:30:00Z' },
    null,
    '2026-04-25T08:30:01Z',
  );
  assert.equal(resumed, false);
  assert.equal(decision.context?.autoResolved, undefined);
});
