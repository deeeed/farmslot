import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  advanceClaudeUsageLine,
  advanceCodexUsageLine,
  emptyBudgetUsageSampleState,
  sampleBudgetUsage,
} from './budget-usage-sample.js';

test('advanceClaudeUsageLine counts assistant usage rows', () => {
  let state = emptyBudgetUsageSampleState();
  state = advanceClaudeUsageLine(state, {
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 10,
      },
    },
  });
  assert.equal(state.turns, 1);
  assert.equal(state.totalTokens, 135);
  state = advanceClaudeUsageLine(state, {
    type: 'assistant',
    message: { usage: { input_tokens: 50, output_tokens: 10 } },
  });
  assert.equal(state.turns, 2);
  assert.equal(state.totalTokens, 195);
});

test('advanceCodexUsageLine tracks turns and latest total_tokens', () => {
  let state = emptyBudgetUsageSampleState();
  state = advanceCodexUsageLine(state, {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant' },
  });
  assert.equal(state.turns, 1);
  state = advanceCodexUsageLine(state, {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 } },
    },
  });
  assert.equal(state.totalTokens, 240);
});

test('sampleBudgetUsage incrementally streams only new local JSONL bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-'));
  const file = path.join(dir, 'session.jsonl');
  const line1 = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 10, output_tokens: 2 } },
  });
  await writeFile(file, `${line1}\n`, 'utf8');

  const vars = { host: 'localhost', machine: 'local', slotId: 's1' } as never;
  const first = await sampleBudgetUsage({
    slotId: 's1',
    vars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(first.availability, 'available');
  assert.equal(first.turns, 1);
  assert.equal(first.totalTokens, 12);

  // Unchanged file → cached, no re-parse needed.
  const cached = await sampleBudgetUsage({
    slotId: 's1',
    vars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: first.nextState,
  });
  assert.equal(cached.availability, 'cached');
  assert.equal(cached.turns, 1);

  const line2 = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 5, output_tokens: 1 } },
  });
  await writeFile(file, `${line1}\n${line2}\n`, 'utf8');

  const second = await sampleBudgetUsage({
    slotId: 's1',
    vars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: first.nextState,
  });
  assert.equal(second.availability, 'available');
  assert.equal(second.turns, 2);
  assert.equal(second.totalTokens, 18);
});

test('sampleBudgetUsage is unavailable without a transcript path', async () => {
  const vars = { host: 'localhost', machine: 'local', slotId: 's1' } as never;
  const result = await sampleBudgetUsage({
    slotId: 's1',
    vars,
    runner: 'claude',
    runnerSessionPath: null,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.turns, null);
});
