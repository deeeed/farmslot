import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSessionUsageOutput, runnerUsageMetrics } from './session-usage-result.js';

const toolUsage = {
  attribution: 'issuedAt',
  toolCalls: 3,
  toolCallsByName: { bash: 3 },
  toolCallsBeforeFirstMark: 2,
  untimedToolCalls: 0,
  steps: [],
};

test('the receipt and metrics carry the tool_usage line', () => {
  const usage = parseSessionUsageOutput(
    `turns=2\ntotal_tokens=10\ntool_usage=${JSON.stringify(toolUsage)}\n`,
  );
  assert.deepEqual(usage.toolUsage, toolUsage);
  const metrics = runnerUsageMetrics(usage);
  assert.equal(metrics.sessionToolCalls, 3);
  assert.equal(metrics.sessionToolCallsBeforeFirstMark, 2);
});

test('a tool-count failure is named without losing the token totals', () => {
  const usage = parseSessionUsageOutput('total_tokens=10\ntool_usage_error=no transcript\n');
  assert.equal(usage.totalTokens, 10);
  assert.equal(usage.toolUsageError, 'no transcript');
  assert.equal(usage.toolUsage, undefined);
});

test('an older accounting module reports no tool usage', () => {
  const usage = parseSessionUsageOutput('total_tokens=10\n');
  assert.equal(usage.toolUsage, undefined);
  assert.equal(runnerUsageMetrics(usage).sessionToolCalls, undefined);
});
