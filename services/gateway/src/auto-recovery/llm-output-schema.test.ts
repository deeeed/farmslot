import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLlmRecoveryOutput } from './llm-output-schema.js';
test('LLM schema accepts allowlisted fixture refresh proposals', () => {
  assert.equal(
    parseLlmRecoveryOutput({
      category: 'env-drift',
      confidence: 'high',
      proposedAction: { type: 'slot.fixtureRefresh' },
    }).proposedAction?.type,
    'slot.fixtureRefresh',
  );
});
test('LLM schema rejects shell proposals before execution and demotes confidence', () => {
  const verdict = parseLlmRecoveryOutput({
    category: 'infra',
    confidence: 'high',
    proposedAction: { type: 'shell.exec' },
  });
  assert.equal(verdict.confidence, 'low');
  assert.match(verdict.warning ?? '', /not allowed/);
});
