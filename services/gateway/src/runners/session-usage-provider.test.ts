import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyIncrementalSessionUsageState } from '@farmslot/slot-config';

import { getRunnerSessionUsageProvider } from './registry.js';

test('Claude provider accumulates assistant usage records', () => {
  const provider = getRunnerSessionUsageProvider('claude');
  assert.ok(provider);
  const state = provider.applyRecord(emptyIncrementalSessionUsageState(), {
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
      },
    },
  });
  assert.equal(state.turns, 1);
  assert.equal(state.totalTokens, 10);
});

test('Codex provider uses cumulative token events and assistant turns', () => {
  const provider = getRunnerSessionUsageProvider('codex');
  assert.ok(provider);
  let state = provider.applyRecord(emptyIncrementalSessionUsageState(), {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant' },
  });
  state = provider.applyRecord(state, {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } },
    },
  });
  assert.equal(state.turns, 1);
  assert.equal(state.totalTokens, 13);
});

test('unsupported runners have no session-usage provider', () => {
  assert.equal(getRunnerSessionUsageProvider('grok'), null);
  assert.equal(getRunnerSessionUsageProvider('scripted'), null);
});
