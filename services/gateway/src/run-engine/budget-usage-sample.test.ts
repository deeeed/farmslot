import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  captureBudgetUsageBaselineAtEof,
  emptyBudgetUsageSampleState,
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

test('captureBudgetUsageBaselineAtEof charges the child only for bytes appended after handoff', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-baseline-'));
  const file = path.join(dir, 'session.jsonl');
  // Parent history far larger than one bounded sample window: parsing it to build a
  // totals baseline is exactly what mis-charged the child before this fix.
  const parentLines = Array.from({ length: 4000 }, () => claudeLine(1000, 200)).join('\n');
  await writeFile(file, `${parentLines}\n`, 'utf8');

  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runnerSessionPath: file,
  });
  assert.ok(baseline, 'baseline must be captured for a readable transcript');
  assert.equal(baseline.baselineCaptured, true);
  assert.equal(baseline.offset, baseline.size);
  assert.equal(baseline.turns, 0);
  assert.equal(baseline.totalTokens, 0);

  await appendFile(file, `${claudeLine(3, 4)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: baseline,
  });
  assert.equal(sampled.turns, 1);
  assert.equal(sampled.totalTokens, 7);
});

test('captureBudgetUsageBaselineAtEof returns null for a directory transcript', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-baseline-dir-'));
  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runnerSessionPath: dir,
  });
  assert.equal(baseline, null);
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

test('sampleBudgetUsage skips oversized records and keeps enforcing afterwards', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-oversized-'));
  const file = path.join(dir, 'session.jsonl');
  const oversized = `{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"pad":"${'x'.repeat(1024 * 1024)}"}}`;
  await writeFile(file, `${oversized}\n${claudeLine(5, 2)}\n`, 'utf8');

  const first = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  // The skipped record is uncounted, but accounting stays live for the rest of the run.
  assert.equal(first.enforcementFailure, false);
  assert.equal(first.nextState.turns, 0);
  assert.equal(first.nextState.totalTokens, 0);
  assert.equal(first.nextState.skippedOversizedRecords, 1);
  assert.match(first.nextState.unavailableReason ?? '', /exceeds bounded sample window/);

  const second = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: first.nextState,
  });
  assert.equal(second.enforcementFailure, false);
  assert.equal(second.availability, 'available');
  assert.equal(second.nextState.turns, 1);
  assert.equal(second.nextState.totalTokens, 7);
});

test('sampleBudgetUsage exposes unsupported runner accounting as an enforcement failure', async () => {
  const result = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'grok',
    runnerSessionPath: '/tmp/not-read.jsonl',
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(result.availability, 'unavailable');
  assert.equal(result.enforcementFailure, true);
  assert.match(result.unavailableReason ?? '', /no bounded session-usage provider/);
});

test('sampleBudgetUsage fails closed when a transcript truncates after accounting begins', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-truncate-'));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, `${claudeLine(10, 2)}\n`, 'utf8');
  const first = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  await writeFile(file, '', 'utf8');
  const truncated = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: { ...first.nextState, baselineCaptured: true },
  });
  assert.equal(truncated.availability, 'unavailable');
  assert.equal(truncated.enforcementFailure, true);
  assert.match(truncated.unavailableReason ?? '', /changed after budget accounting began/);
});
