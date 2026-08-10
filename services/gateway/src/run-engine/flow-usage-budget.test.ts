import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildUsageBudgetNudgeMessage,
  evaluateFlowUsageBudget,
  FLOW_USAGE_BUDGET_DEFAULTS,
  formatUsageBudgetMessage,
  hasUsageBudget,
} from './flow-usage-budget.js';

test('hasUsageBudget is false when both ceilings are unset', () => {
  assert.equal(hasUsageBudget({}), false);
  assert.equal(hasUsageBudget({ maxTurns: null, maxTotalTokens: null }), false);
  assert.equal(hasUsageBudget({ maxTurns: 0, maxTotalTokens: -1 }), false);
});

test('hasUsageBudget is true when either ceiling is positive', () => {
  assert.equal(hasUsageBudget({ maxTurns: 10 }), true);
  assert.equal(hasUsageBudget({ maxTotalTokens: 1000 }), true);
});

test('evaluateFlowUsageBudget fails open when usage sample is missing', () => {
  assert.deepEqual(
    evaluateFlowUsageBudget({ turns: null, totalTokens: null }, { maxTurns: 10, maxTotalTokens: 100 }),
    { exceeded: false },
  );
});

test('evaluateFlowUsageBudget detects turn overrun only', () => {
  const result = evaluateFlowUsageBudget(
    { turns: 81, totalTokens: 1000 },
    { maxTurns: 80, maxTotalTokens: 8_000_000 },
  );
  assert.equal(result.exceeded, true);
  if (!result.exceeded) throw new Error('expected exceeded');
  assert.match(result.reasons[0] ?? '', /turns 81 > max_turns 80/);
  assert.equal(result.reasons.length, 1);
});

test('evaluateFlowUsageBudget detects token overrun only', () => {
  const result = evaluateFlowUsageBudget(
    { turns: 10, totalTokens: 9_000_000 },
    { maxTurns: 80, maxTotalTokens: 8_000_000 },
  );
  assert.equal(result.exceeded, true);
  if (!result.exceeded) throw new Error('expected exceeded');
  assert.match(result.reasons[0] ?? '', /total_tokens 9000000 > max_total_tokens 8000000/);
});

test('evaluateFlowUsageBudget reports both dimensions when both overrun', () => {
  const result = evaluateFlowUsageBudget(
    { turns: 500, totalTokens: 117_000_000 },
    FLOW_USAGE_BUDGET_DEFAULTS['update-branch']!,
  );
  assert.equal(result.exceeded, true);
  if (!result.exceeded) throw new Error('expected exceeded');
  assert.equal(result.reasons.length, 2);
});

test('evaluateFlowUsageBudget allows usage at the ceiling (strictly greater)', () => {
  assert.deepEqual(
    evaluateFlowUsageBudget(
      { turns: 80, totalTokens: 8_000_000 },
      { maxTurns: 80, maxTotalTokens: 8_000_000 },
    ),
    { exceeded: false },
  );
});

test('update-branch ships a built-in soft budget', () => {
  const def = FLOW_USAGE_BUDGET_DEFAULTS['update-branch'];
  assert.ok(def);
  assert.equal(def!.maxTurns, 80);
  assert.equal(def!.maxTotalTokens, 8_000_000);
  // No silent default for open-ended feature flows.
  assert.equal(FLOW_USAGE_BUDGET_DEFAULTS.dev, undefined);
});

test('formatUsageBudgetMessage names the flow and reasons', () => {
  const evaluation = evaluateFlowUsageBudget(
    { turns: 100, totalTokens: null },
    { maxTurns: 80 },
  );
  assert.equal(evaluation.exceeded, true);
  if (!evaluation.exceeded) throw new Error('expected exceeded');
  const msg = formatUsageBudgetMessage('update-branch', evaluation);
  assert.match(msg, /update-branch usage budget exceeded/);
  assert.match(msg, /turns 100 > max_turns 80/);
  assert.match(msg, /near-mechanical/);
});

test('buildUsageBudgetNudgeMessage prefixes orchestrator budget warning', () => {
  assert.match(
    buildUsageBudgetNudgeMessage('update-branch usage budget exceeded'),
    /^\[Orchestrator\] USAGE BUDGET WARNING:/,
  );
});
