import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run, RunDecision, WorkerSignal } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';
import {
  artifactContractWaiverArgs,
  artifactContractWorkerInstruction,
  artifactTerminalCommandForSignal,
  terminalContractFailureKind,
} from '../tasks/worker-terminal-contract.js';

import { emptyBudgetUsageSampleState } from './budget-usage-sample.js';
import {
  applyBudgetWarnOnce,
  applyHandoffAutoResolution,
  bindSignalToMonitorContext,
  handoffDecisionStillPending,
  isFreshTerminalHandoffSignal,
  isWorkerSignalFreshForRun,
  MAX_BUDGET_NUDGE_ATTEMPTS,
  type MonitorNudgeRunView,
  pollBudgetGuardStep,
  rearmInteractiveHandoffAutoRecovery,
  resolveMonitorConfig,
  restoreStructuredProgressAtMs,
  runHasOpenHumanGate,
  shouldHoldForInteractivePrComplete,
  shouldHoldForMissingTerminalSignal,
  shouldSkipMonitorNudge,
  signalMatchesMonitorContext,
} from './run-monitor.js';

test('artifact contract revalidation preserves an explicit learnings waiver', () => {
  assert.deepEqual(artifactContractWaiverArgs({ artifactWaivers: { learnings: true } }), [
    '--skip-learnings',
  ]);
  assert.deepEqual(artifactContractWaiverArgs({}), []);
});

test('artifact contract rejection instruction tells the worker how to recover', () => {
  const instruction = artifactContractWorkerInstruction(
    'Terminal SIGNAL.json was rejected.\n\n- artifacts/recipe-decision.json: invalid JSON',
  );
  assert.match(instruction, /artifact contract/);
  assert.match(instruction, /run \.\/mark complete again/);
  assert.match(instruction, /recipe-decision\.json: invalid JSON/);
  assert.ok(!instruction.includes('\n'));
});

test('artifact contract rejection preserves the no-change terminal command', () => {
  const instruction = artifactContractWorkerInstruction(
    'Terminal SIGNAL.json was rejected: recipe decision missing.',
    'no-change',
  );
  assert.match(instruction, /run \.\/mark no-change again/);
  assert.doesNotMatch(instruction, /mark complete/);
});

test('terminal contract failures blame only explicit checker rejections on worker artifacts', () => {
  assert.equal(
    terminalContractFailureKind({
      exitCode: 1,
      stdout: '',
      stderr: 'TASK_ARTIFACT_CONTRACT_FAIL\n- missing report',
    }),
    'artifact',
  );
  for (const exitCode of [1, 2, 124, 127]) {
    assert.equal(
      terminalContractFailureKind({ exitCode, stdout: '', stderr: 'checker failed' }),
      'infrastructure',
    );
  }
  assert.equal(
    terminalContractFailureKind({
      exitCode: 1,
      stdout: '',
      stderr: 'maxBuffer exceeded after 300000 bytes',
    }),
    'infrastructure',
  );
});

test('artifactTerminalCommandForSignal maps successful dispositions to the matching contract', () => {
  assert.equal(
    artifactTerminalCommandForSignal({ status: 'complete', disposition: 'fixed' }),
    'complete',
  );
  assert.equal(
    artifactTerminalCommandForSignal({ status: 'done', disposition: 'already_fixed' }),
    'no-change',
  );
  assert.equal(
    artifactTerminalCommandForSignal({ status: 'complete', disposition: 'not_reproducible' }),
    'no-change',
  );
  assert.equal(
    artifactTerminalCommandForSignal({ status: 'blocked', disposition: 'blocked' }),
    null,
  );
  assert.equal(artifactTerminalCommandForSignal({ status: 'failed', disposition: 'failed' }), null);
});

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

test('resolveMonitorConfig applies built-in update-branch turn/token soft budgets', () => {
  const cfg = resolveMonitorConfig(undefined, 'proj', 'update-branch');
  assert.equal(cfg.maxTurns, 80);
  assert.equal(cfg.maxTotalTokens, 8_000_000);
});

test('resolveMonitorConfig leaves open-ended flows without a usage budget', () => {
  const cfg = resolveMonitorConfig({ total_timeout_min: 90 }, 'proj', 'dev');
  assert.equal(cfg.maxTurns, null);
  assert.equal(cfg.maxTotalTokens, null);
});

test('resolveMonitorConfig honors project max_turns / max_total_tokens overrides', () => {
  const cfg = resolveMonitorConfig(
    {
      flows: {
        'update-branch': { max_turns: 40, max_total_tokens: 2_000_000 },
      },
    },
    'proj',
    'update-branch',
  );
  assert.equal(cfg.maxTurns, 40);
  assert.equal(cfg.maxTotalTokens, 2_000_000);
});

test('resolveMonitorConfig ignores invalid usage budget overrides and keeps defaults', () => {
  const cfg = resolveMonitorConfig(
    {
      flows: {
        'update-branch': { max_turns: -3, max_total_tokens: 0 },
      },
    },
    'proj',
    'update-branch',
  );
  assert.equal(cfg.maxTurns, 80);
  assert.equal(cfg.maxTotalTokens, 8_000_000);
});

test('resolveMonitorConfig rejects fractional budget ceilings instead of flooring to zero', () => {
  const cfg = resolveMonitorConfig(
    {
      flows: {
        'update-branch': { max_turns: 0.5, max_total_tokens: 0.5 },
      },
    },
    'proj',
    'update-branch',
  );
  assert.equal(cfg.maxTurns, 80);
  assert.equal(cfg.maxTotalTokens, 8_000_000);
});

test('resolveMonitorConfig(undefined) still applies update-branch budget defaults', () => {
  // Mirrors the project-config load failure path — must not drop built-in budgets.
  const cfg = resolveMonitorConfig(undefined, 'missing-project', 'update-branch');
  assert.equal(cfg.maxTurns, 80);
  assert.equal(cfg.maxTotalTokens, 8_000_000);
});

test('applyBudgetWarnOnce emits once then stays quiet (warn-once)', () => {
  const first = applyBudgetWarnOnce({
    turns: 100,
    totalTokens: 1_000,
    maxTurns: 80,
    maxTotalTokens: 8_000_000,
    budgetWarned: false,
    flowType: 'update-branch',
  });
  assert.equal(first.emit, true);
  if (!first.emit) throw new Error('expected emit');
  assert.match(first.message, /update-branch usage budget exceeded/);

  const second = applyBudgetWarnOnce({
    turns: 200,
    totalTokens: 2_000,
    maxTurns: 80,
    maxTotalTokens: 8_000_000,
    budgetWarned: true,
    flowType: 'update-branch',
  });
  assert.equal(second.emit, false);
  assert.equal(second.budgetWarned, true);
});

test('restoreStructuredProgressAtMs keeps the persisted idle clock across restart', () => {
  assert.equal(
    restoreStructuredProgressAtMs({
      lastStructuredProgressAt: '2026-08-24T03:00:00.000Z',
      lastPollAt: '2026-08-24T03:20:00.000Z',
    }),
    Date.parse('2026-08-24T03:00:00.000Z'),
  );
  assert.equal(
    restoreStructuredProgressAtMs({ lastPollAt: '2026-08-24T03:20:00.000Z' }),
    Date.parse('2026-08-24T03:20:00.000Z'),
  );
});

test('pollBudgetGuardStep emits a fail-closed violation for unsupported accounting', async () => {
  const tick = await pollBudgetGuardStep({
    runId: 'missing-run-is-okay-for-send-false',
    slotId: 'slot-1',
    flowType: 'update-branch',
    runner: 'grok',
    runnerSessionPath: '/tmp/unread.jsonl',
    maxTurns: 80,
    maxTotalTokens: 8_000_000,
    budgetWarned: false,
    budgetNudgeSent: false,
    budgetUsage: {
      path: null,
      size: 0,
      mtimeMs: 0,
      offset: 0,
      turns: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
    },
    agentStatus: 'working',
    sendNudge: false,
    localVarsStub: { host: 'localhost', machine: 'local', slotId: 'slot-1' },
  });
  assert.equal(tick.budgetWarned, true);
  assert.equal(tick.violation?.type, 'budget');
  // A runner with no usage provider is a capability gap, not worker misbehavior.
  assert.equal(tick.unsupportedRunner, true);
  assert.match(tick.violation?.message ?? '', /enforcement unsupported/);
  assert.doesNotMatch(tick.violation?.message ?? '', /Stop expanding scope/);
});

test('pollBudgetGuardStep never nudges a worker whose runner exposes no usage', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: `BUDGET-UNSUPPORTED-${Date.now()}`,
    slotId: 'slot-1',
    runner: 'cursor',
    branch: 'budget-unsupported-test',
  });
  updateRun(run.id, { status: 'monitoring' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  let attempts = 0;
  const tick = await pollBudgetGuardStep({
    runId: run.id,
    slotId: 'slot-1',
    flowType: 'update-branch',
    runner: 'cursor',
    runnerSessionPath: '/tmp/unread.jsonl',
    maxTurns: 80,
    maxTotalTokens: 8_000_000,
    budgetWarned: false,
    budgetNudgeSent: false,
    budgetUsage: emptyBudgetUsageSampleState(),
    agentStatus: 'idle',
    sendNudge: true,
    localVarsStub: { host: 'localhost', machine: 'local', slotId: 'slot-1' },
    deliverNudge: async () => {
      attempts += 1;
      return 'confirmed' as const;
    },
  });
  assert.equal(tick.unsupportedRunner, true);
  assert.equal(tick.nudgeSent, false);
  assert.equal(tick.budgetNudgeAttempts, 0);
  assert.equal(attempts, 0);
});

/** One counted claude turn (12 tokens) — enough to breach a ceiling of 1. */
async function breachingTranscript(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(
    file,
    `${JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 2 } },
    })}\n`,
    'utf8',
  );
  return file;
}

test('pollBudgetGuardStep retries an unconfirmed nudge without re-emitting the violation', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: `BUDGET-RETRY-${Date.now()}`,
    slotId: 'slot-1',
    runner: 'claude',
    branch: 'budget-retry-test',
  });
  updateRun(run.id, { status: 'monitoring' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  let attempts = 0;
  const deliverNudge = async () => {
    attempts += 1;
    return attempts > 1 ? ('confirmed' as const) : ('attempted' as const);
  };
  const common = {
    runId: run.id,
    slotId: 'slot-1',
    flowType: 'update-branch' as const,
    runner: 'claude',
    runnerSessionPath: await breachingTranscript('run-monitor-budget-retry-'),
    maxTurns: 1,
    maxTotalTokens: 1,
    agentStatus: 'idle' as const,
    sendNudge: true,
    localVarsStub: { host: 'localhost', machine: 'local', slotId: 'slot-1' },
    deliverNudge,
  };
  const first = await pollBudgetGuardStep({
    ...common,
    budgetWarned: false,
    budgetNudgeSent: false,
    budgetUsage: emptyBudgetUsageSampleState(),
  });
  assert.equal(first.violation?.type, 'budget');
  assert.equal(first.nudgeSent, false);

  const second = await pollBudgetGuardStep({
    ...common,
    budgetWarned: first.budgetWarned,
    budgetNudgeSent: false,
    budgetUsage: first.budgetUsage,
  });
  assert.equal(second.violation, null);
  assert.equal(second.nudgeSent, true);
  assert.equal(attempts, 2);
});

test('pollBudgetGuardStep does not spend attempts when the pane is never touched', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: `BUDGET-HOLD-${Date.now()}`,
    slotId: 'slot-1',
    runner: 'claude',
    branch: 'budget-hold-test',
  });
  updateRun(run.id, { status: 'monitoring' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  // Transient holds that bail before the composer must stay free, or a real breach
  // would go unreported after three of them.
  let calls = 0;
  const common = {
    runId: run.id,
    slotId: 'slot-1',
    flowType: 'update-branch' as const,
    runner: 'claude',
    runnerSessionPath: await breachingTranscript('run-monitor-budget-hold-'),
    maxTurns: 1,
    maxTotalTokens: 1,
    agentStatus: 'idle' as const,
    sendNudge: true,
    localVarsStub: { host: 'localhost', machine: 'local', slotId: 'slot-1' },
    deliverNudge: async () => {
      calls += 1;
      return calls <= 3 ? ('not-attempted' as const) : ('confirmed' as const);
    },
  };
  let budgetWarned = false;
  let budgetNudgeAttempts = 0;
  let budgetUsage = emptyBudgetUsageSampleState();
  let nudgeSent = false;
  for (let poll = 0; poll < 4; poll++) {
    const tick = await pollBudgetGuardStep({
      ...common,
      budgetWarned,
      budgetNudgeSent: false,
      budgetNudgeAttempts,
      budgetUsage,
    });
    budgetWarned = tick.budgetWarned;
    budgetNudgeAttempts = tick.budgetNudgeAttempts;
    budgetUsage = tick.budgetUsage;
    nudgeSent = tick.nudgeSent;
  }
  assert.equal(calls, 4);
  assert.equal(nudgeSent, true, 'the warning still lands after three untouched holds');
  assert.equal(budgetNudgeAttempts, 1, 'only the delivery that reached the pane counts');
});

test('pollBudgetGuardStep waits for an idle runner before typing the warning', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: `BUDGET-BUSY-${Date.now()}`,
    slotId: 'slot-1',
    runner: 'claude',
    branch: 'budget-busy-test',
  });
  updateRun(run.id, { status: 'monitoring' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  let attempts = 0;
  const common = {
    runId: run.id,
    slotId: 'slot-1',
    flowType: 'update-branch' as const,
    runner: 'claude',
    runnerSessionPath: await breachingTranscript('run-monitor-budget-busy-'),
    maxTurns: 1,
    maxTotalTokens: 1,
    sendNudge: true,
    localVarsStub: { host: 'localhost', machine: 'local', slotId: 'slot-1' },
    deliverNudge: async () => {
      attempts += 1;
      return 'confirmed' as const;
    },
  };

  // A busy composer never submits what is typed at it, so nothing is sent and no
  // attempt is spent — otherwise the cap would be exhausted before the worker could
  // ever receive the warning.
  let tick = await pollBudgetGuardStep({
    ...common,
    agentStatus: 'working',
    budgetWarned: false,
    budgetNudgeSent: false,
    budgetUsage: emptyBudgetUsageSampleState(),
  });
  assert.equal(tick.violation?.type, 'budget', 'the breach is still recorded');
  assert.equal(tick.nudgeSent, false);
  assert.equal(tick.budgetNudgeAttempts, 0);
  assert.equal(attempts, 0);

  // The turn ends; the warning lands on the next poll.
  tick = await pollBudgetGuardStep({
    ...common,
    agentStatus: 'idle',
    budgetWarned: tick.budgetWarned,
    budgetNudgeSent: false,
    budgetNudgeAttempts: tick.budgetNudgeAttempts,
    budgetUsage: tick.budgetUsage,
  });
  assert.equal(tick.nudgeSent, true);
  assert.equal(attempts, 1);
});

test('pollBudgetGuardStep stops retrying an unconfirmable nudge at the attempt cap', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: `BUDGET-CAP-${Date.now()}`,
    slotId: 'slot-1',
    runner: 'claude',
    branch: 'budget-cap-test',
  });
  updateRun(run.id, { status: 'monitoring' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  // A busy pane never confirms: every attempt leaves the warning in the composer.
  let attempts = 0;
  const deliverNudge = async () => {
    attempts += 1;
    return 'attempted' as const;
  };
  const common = {
    runId: run.id,
    slotId: 'slot-1',
    flowType: 'update-branch' as const,
    runner: 'claude',
    runnerSessionPath: await breachingTranscript('run-monitor-budget-cap-'),
    maxTurns: 1,
    maxTotalTokens: 1,
    agentStatus: 'idle' as const,
    sendNudge: true,
    localVarsStub: { host: 'localhost', machine: 'local', slotId: 'slot-1' },
    deliverNudge,
  };
  let budgetWarned = false;
  let budgetNudgeAttempts = 0;
  let budgetUsage = emptyBudgetUsageSampleState();
  for (let poll = 0; poll < MAX_BUDGET_NUDGE_ATTEMPTS + 3; poll++) {
    const tick = await pollBudgetGuardStep({
      ...common,
      budgetWarned,
      budgetNudgeSent: false,
      budgetNudgeAttempts,
      budgetUsage,
    });
    budgetWarned = tick.budgetWarned;
    budgetNudgeAttempts = tick.budgetNudgeAttempts;
    budgetUsage = tick.budgetUsage;
    assert.equal(tick.nudgeSent, false);
  }
  assert.equal(attempts, MAX_BUDGET_NUDGE_ATTEMPTS);
  assert.equal(budgetNudgeAttempts, MAX_BUDGET_NUDGE_ATTEMPTS);
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

test('isFreshTerminalHandoffSignal rejects a terminal signal with no timestamp', () => {
  // The type requires timestamp, but a hand-written SIGNAL.json can omit it —
  // model that file shape directly.
  const timestampless = { status: 'complete', outcome: 'success' } as WorkerSignal;
  assert.equal(isFreshTerminalHandoffSignal(handoffRun, timestampless), false);
});

test('isFreshTerminalHandoffSignal rejects a terminal signal with an unparseable timestamp', () => {
  assert.equal(
    isFreshTerminalHandoffSignal(handoffRun, {
      status: 'complete',
      outcome: 'success',
      timestamp: 'not-a-date',
    }),
    false,
  );
});

test('isFreshTerminalHandoffSignal rejects a timestamp with trailing junk that Date.parse tolerates', () => {
  assert.equal(
    isFreshTerminalHandoffSignal(handoffRun, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25junk',
    }),
    false,
  );
});

test('isFreshTerminalHandoffSignal accepts a fresh strictly-shaped timestamp with a UTC offset', () => {
  assert.equal(
    isFreshTerminalHandoffSignal(handoffRun, {
      status: 'complete',
      outcome: 'success',
      timestamp: '2026-04-25T10:30:00+02:00',
    }),
    true,
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

// ─── restart re-arm ───

function handoffBlockedRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'a0466ede-9c65-4a55-8f2e-3b1f8f6f0001',
    slotId: 'macwork-ff-2',
    decisions: [
      {
        id: 'decision-handoff',
        type: 'monitor_interactive_handoff',
        title: 'Interactive handoff',
        description: 'Waiting for SIGNAL.json',
        actions: [{ id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' }],
        createdAt: '2026-04-25T08:10:00Z',
      },
    ],
    ...overrides,
  } as Run;
}

test('rearmInteractiveHandoffAutoRecovery arms a watcher for an unresolved handoff and returns a disarm', () => {
  const disarm = rearmInteractiveHandoffAutoRecovery(handoffBlockedRun(), async () => {});
  assert.equal(typeof disarm, 'function');
  disarm?.();
});

test('rearmInteractiveHandoffAutoRecovery declines without a slot', () => {
  assert.equal(
    rearmInteractiveHandoffAutoRecovery(handoffBlockedRun({ slotId: null }), async () => {}),
    undefined,
  );
});

test('rearmInteractiveHandoffAutoRecovery declines when the handoff is already resolved', () => {
  const run = handoffBlockedRun();
  run.decisions[0].resolvedAt = '2026-04-25T08:20:00Z';
  assert.equal(
    rearmInteractiveHandoffAutoRecovery(run, async () => {}),
    undefined,
  );
});

test('handoffDecisionStillPending tracks manual resolution so a signal-less watcher can disarm', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `WATCHER-LIVENESS-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise watcher liveness predicate',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const decision: RunDecision = {
    id: 'handoff-live',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Waiting for SIGNAL.json',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' as const },
    ],
    createdAt: '2026-04-25T08:10:00Z',
  };
  updateRun(run.id, { decisions: [decision] });
  assert.equal(handoffDecisionStillPending(run.id, decision.id), true);

  // Operator resolves manually while no terminal signal ever arrives: the
  // predicate must flip so the armed watcher's next tick disarms it.
  updateRun(run.id, {
    decisions: [{ ...decision, resolvedAt: '2026-04-25T08:20:00Z', resolvedAction: 'abort' }],
  });
  assert.equal(handoffDecisionStillPending(run.id, decision.id), false);
  assert.equal(handoffDecisionStillPending(run.id, 'missing-decision'), false);
  assert.equal(handoffDecisionStillPending('missing-run', decision.id), false);
});

test('rearmInteractiveHandoffAutoRecovery declines when only non-handoff decisions are pending', () => {
  const run = handoffBlockedRun();
  run.decisions[0].type = 'engine_human_gate';
  assert.equal(
    rearmInteractiveHandoffAutoRecovery(run, async () => {}),
    undefined,
  );
});
