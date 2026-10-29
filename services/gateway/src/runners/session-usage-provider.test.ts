import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('Pi provider counts per-message usage from a sanitized real session without double-counting caches', () => {
  const provider = getRunnerSessionUsageProvider('pi');
  assert.ok(provider);
  assert.equal(provider.restatesSessionTotals, false);
  let state = emptyIncrementalSessionUsageState();
  const fixture = readFileSync(
    new URL('../../../../packages/slot-config/test/fixtures/pi-session.jsonl', import.meta.url),
    'utf8',
  );
  for (const line of fixture.trim().split('\n'))
    state = provider.applyRecord(state, JSON.parse(line));
  assert.equal(state.turns, 3);
  assert.equal(state.inputTokens, 8);
  assert.equal(state.outputTokens, 742);
  assert.equal(state.cacheRead, 58613);
  assert.equal(state.cacheCreation, 38822);
  assert.equal(state.totalTokens, 98185);
});
