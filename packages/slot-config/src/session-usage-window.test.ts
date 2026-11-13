import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runSessionUsage } from './session-usage.js';

const usageWindow = { startedAt: '2026-01-02T00:00:00Z', completedAt: '2026-01-02T01:00:00Z' };

async function fixture(t: test.TestContext, runner: string, records: object[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const write = (rows: object[]) =>
    writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await write(records);
  const measure = () =>
    runSessionUsage({
      repo: '',
      slotId: 'fixture',
      action: 'total',
      forcedRunner: runner,
      forcedPath: file,
      usageWindow,
    });
  return { measure, write, file };
}

test('Pi resumed usage retains request costs but excludes prior and later messages and replayed ids', async (t) => {
  const assistant = (id: string, timestamp: string, input: number, cost: number) => ({
    type: 'message',
    id,
    timestamp,
    message: {
      role: 'assistant',
      model: 'fixture',
      usage: {
        input,
        output: input * 2,
        cacheRead: input * 3,
        cacheWrite: input * 4,
        cost: { total: cost },
      },
    },
  });
  const prior = assistant('prior', '2026-01-01T00:01:00Z', 100, 1);
  const warm = assistant('warm', '2026-01-02T00:01:00Z', 10, 0.1);
  const f = await fixture(t, 'pi', [
    prior,
    { ...prior, timestamp: warm.timestamp },
    warm,
    warm,
    assistant('later', '2026-01-03T00:01:00Z', 300, 3),
  ]);
  const output = await f.measure();
  assert.match(output, /turns=1\n/);
  assert.match(output, /input_tokens=10\noutput_tokens=20\ncache_creation=40\ncache_read=30\n/);
  assert.match(output, /cost_usd=0.1000000000/);
  assert.equal(await f.measure(), output, 'Repeated capture is idempotent');
});

test('Codex resumed usage subtracts the pre-run cumulative reading for tokens, cache and cost', async (t) => {
  const reading = (timestamp: string, input: number, output: number) => ({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: input / 2,
          reasoning_output_tokens: output / 2,
          total_tokens: input + output,
        },
      },
    },
  });
  const prior = reading('2026-01-01T00:01:00Z', 100, 200);
  const warm = reading('2026-01-02T00:01:00Z', 120, 240);
  const f = await fixture(t, 'codex', [
    { type: 'session_meta', payload: { model: 'gpt-6-sol' } },
    prior,
    prior,
    warm,
    warm,
    reading('2026-01-03T00:01:00Z', 500, 700),
  ]);
  const output = await f.measure();
  assert.match(
    output,
    /input_tokens=20\noutput_tokens=40\ncache_creation=0\ncache_read=10\nreasoning_output_tokens=20\ntotal_tokens=60\n/,
  );
  assert.match(output, /cost_usd=0.0004400000/);
  await f.write([prior, reading('2026-01-02T00:01:00Z', 10, 20), warm]);
  await assert.rejects(f.measure, /cumulative usage reset/);
});

test('Claude compaction records and replays preserve the run window without subtracting missing history', async (t) => {
  const prior = {
    type: 'assistant',
    timestamp: '2026-01-01T00:01:00Z',
    message: {
      id: 'prior',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 100, output_tokens: 200 },
    },
  };
  const warm = {
    type: 'assistant',
    timestamp: '2026-01-02T00:01:00Z',
    message: {
      id: 'warm',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 20, output_tokens: 30 },
    },
  };
  const compact = { type: 'system', subtype: 'compact_boundary', timestamp: warm.timestamp };
  const f = await fixture(t, 'claude', [prior, compact, warm, warm]);
  const output = await f.measure();
  assert.match(output, /input_tokens=20\noutput_tokens=30\n/);
  // Removing pre-run history cannot turn a cumulative subtraction negative.
  await f.write([compact, warm, warm]);
  const compacted = await f.measure();
  assert.equal(compacted.split('---')[1], output.split('---')[1]);
  await f.write([{ ...warm, timestamp: undefined }]);
  await assert.rejects(f.measure, /requires timestamped/);
  await f.write([{ ...warm, message: { ...warm.message, id: undefined } }]);
  await assert.rejects(f.measure, /requires assistant message ids/);
});
