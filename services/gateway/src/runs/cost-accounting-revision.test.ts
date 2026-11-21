import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, RunnerSessionUsage } from '@farmslot/protocol';

import { upsertSessionUsage } from '../runtime/agent-session-rows.js';

import {
  costAccountingRevision,
  noteCostAccountingWrite,
  readCostAccountingRevision,
} from './cost-accounting-revision.js';

test('accounting revisions survive unrelated progress and change with receipts or handoff', () => {
  const usage: RunnerSessionUsage = {
    runner: 'pi',
    runnerSessionId: 'worker',
    source: 'runner-transcript',
    measuredAt: '2026-11-20T00:00:00Z',
    costUsd: 1,
  };
  const actor: AgentContext = {
    id: 'fix-bug',
    role: 'fix-bug',
    runId: 'r',
    label: 'Worker',
    status: 'working',
    runner: 'pi',
    runnerSessionId: 'worker',
    slotId: 'slot',
    target: null,
  };
  const run = {
    id: 'r',
    flowType: 'fix-bug' as const,
    decisions: [],
    steps: [{ name: 'monitor', status: 'running' as const, outputs: { progress: 1 } }],
    sessionUsage: [usage],
    agentContexts: [actor],
  };
  noteCostAccountingWrite(run);
  const initial = readCostAccountingRevision(run, run);
  assert.ok(initial);
  const progress = {
    ...run,
    steps: [{ ...run.steps[0]!, outputs: { progress: 2 } }],
    agentContexts: [{ ...actor, updatedAt: '2026-11-20T00:01:00Z' }],
  };
  assert.equal(costAccountingRevision(run, progress), initial);
  Object.assign(run, progress, { sessionUsage: [{ ...usage }] });
  noteCostAccountingWrite(run);
  assert.equal(readCostAccountingRevision(run, run), initial);
  assert.equal(readCostAccountingRevision(run, { ...run, sessionUsage: [] }), undefined);
  const repriced = { ...progress, sessionUsage: [{ ...usage, costUsd: 2 }] };
  const receiptRevision = costAccountingRevision(run, repriced);
  assert.notEqual(receiptRevision, initial);
  assert.notEqual(
    costAccountingRevision(run, { ...repriced, engineState: { flags: { nudgeReuse: true } } }),
    receiptRevision,
  );
});

test('a new receipt does not reread fields of historical receipts', () => {
  let historicalReads = 0;
  const old: RunnerSessionUsage = {
    runner: 'pi',
    runnerSessionId: 'old',
    source: 'runner-transcript',
    measuredAt: '2026-11-20T00:00:00Z',
    get costUsd() {
      historicalReads++;
      return 2;
    },
  };
  const run = {
    id: 'r',
    flowType: 'fix-bug' as const,
    steps: [],
    decisions: [],
    sessionUsage: [old],
  };
  const initial = costAccountingRevision(run);
  assert.equal(historicalReads, 1);
  run.sessionUsage = upsertSessionUsage(run.sessionUsage, {
    runner: 'pi',
    runnerSessionId: 'new',
    source: old.source,
    measuredAt: old.measuredAt,
    costUsd: 3,
  });
  assert.notEqual(costAccountingRevision(run), initial);
  assert.equal(historicalReads, 1);
});

test('a pipeline mode correction advances the revision without repricing its receipt', () => {
  const usage = {
    runner: 'pi',
    runnerSessionId: 'reviewer',
    source: 'runner-transcript' as const,
    measuredAt: '2026-11-20T00:00:00Z',
    costUsd: 4,
  };
  const run = {
    id: 'r',
    flowType: 'fix-bug' as const,
    decisions: [],
    engineState: { flags: { warmHandoffSucceeded: true } },
    sessionUsage: [usage],
    steps: [{ name: 'review', status: 'done' as const, outputs: { mode: 'warm', usage } }],
  };
  const before = costAccountingRevision(run);
  run.steps = [{ ...run.steps[0]!, outputs: { mode: 'cold', usage } }];
  assert.notEqual(costAccountingRevision(run), before);
});

test('corrected receipt bounds invalidate a prepared accounting revision', () => {
  const usage: RunnerSessionUsage = {
    runner: 'pi',
    runnerSessionId: 'round',
    source: 'runner-transcript',
    measuredAt: '2026-11-20T00:04:00Z',
    startedAt: '2026-11-20T00:00:00Z',
    completedAt: '2026-11-20T00:02:00Z',
    totalTokens: 100,
    costUsd: 2,
  };
  const run = {
    id: 'r',
    flowType: 'fix-bug' as const,
    decisions: [],
    steps: [],
    sessionUsage: [usage],
  };
  const before = costAccountingRevision(run);
  run.sessionUsage = [{ ...usage, completedAt: '2026-11-20T00:03:00Z' }];
  assert.notEqual(costAccountingRevision(run), before);
});

test('pending lease changes advance the cost revision without changing the price', () => {
  const usage: RunnerSessionUsage = {
    runner: 'codex',
    runnerSessionId: 'reviewer',
    source: 'runner-transcript',
    measuredAt: '2026-11-20T00:00:00Z',
    scope: 'run-delta',
    usageLeaseIds: ['first'],
    nativeSession: { sessionId: 'host', executionNodeId: 'node', ownerPrincipalId: 'owner' },
    costUsd: 1,
  };
  const run = {
    id: 'pending',
    flowType: 'fix-bug' as const,
    decisions: [],
    steps: [],
    sessionUsage: upsertSessionUsage([usage], usage),
  };
  noteCostAccountingWrite(run);
  const before = readCostAccountingRevision(run, run);
  run.sessionUsage = upsertSessionUsage(run.sessionUsage, {
    ...usage,
    pendingUsageLeaseIds: ['retry'],
  });
  noteCostAccountingWrite(run);
  const pending = readCostAccountingRevision(run, run);
  assert.notEqual(pending, before);
  run.sessionUsage = upsertSessionUsage(run.sessionUsage, {
    ...usage,
    pendingUsageLeaseIds: ['retry'],
  });
  noteCostAccountingWrite(run);
  assert.equal(readCostAccountingRevision(run, run), pending);
});
