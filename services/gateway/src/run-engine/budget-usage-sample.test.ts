import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  emptyBudgetUsageSampleState,
  remoteSessionUsageScriptArg,
  sampleBudgetUsage,
} from './budget-usage-sample.js';

const localVars = { host: 'localhost', machine: 'local', slotId: 's1' } as never;

function claudeLine(input: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: input, output_tokens: output } },
  });
}

test('sampleBudgetUsage counts complete local JSONL and caches unchanged files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-'));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, `${claudeLine(10, 2)}\n`, 'utf8');

  const first = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(first.availability, 'available');
  assert.equal(first.turns, 1);
  assert.equal(first.totalTokens, 12);

  const cached = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: first.nextState,
  });
  assert.equal(cached.availability, 'cached');
  assert.equal(cached.turns, 1);
});

test('sampleBudgetUsage preserves incomplete trailing JSONL until the record completes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-split-'));
  const file = path.join(dir, 'session.jsonl');
  const line1 = claudeLine(10, 2);
  const line2 = claudeLine(5, 1);
  await writeFile(file, `${line1}\n`, 'utf8');

  const first = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(first.turns, 1);

  // Split-write: first half of line2 without a trailing newline.
  const mid = Math.floor(line2.length / 2);
  await appendFile(file, line2.slice(0, mid), 'utf8');

  const midSample = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: first.nextState,
  });
  // Incomplete record must not advance counts or durable offset past it.
  assert.equal(midSample.turns, 1);
  assert.equal(midSample.nextState.offset, first.nextState.offset);

  // Complete the record.
  await appendFile(file, `${line2.slice(mid)}\n`, 'utf8');

  const second = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: midSample.nextState,
  });
  assert.equal(second.turns, 2);
  assert.equal(second.totalTokens, 18);
});

test('sampleBudgetUsage is unavailable without a transcript path', async () => {
  const result = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: null,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.turns, null);
});

test('remoteSessionUsageScriptArg expands tilde via $HOME without single-quoting it away', () => {
  const arg = remoteSessionUsageScriptArg('~/farmslot-node/scripts/session-usage.sh');
  assert.match(arg, /\$HOME\//);
  assert.equal(arg.includes("'$HOME"), false);
  assert.match(remoteSessionUsageScriptArg('/abs/path/session-usage.sh'), /^'/);
});
