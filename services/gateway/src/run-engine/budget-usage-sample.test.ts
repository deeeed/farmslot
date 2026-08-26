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
    runner: 'claude',
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

test('captureBudgetUsageBaselineAtEof baselines a cumulative runner against the parent total', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-cumulative-'));
  const file = path.join(dir, 'session.jsonl');
  const tokenCount = (total: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } },
      },
    });
  // Codex reports session-cumulative totals: the parent already burned 7.95M.
  await writeFile(file, `${tokenCount(7_950_000)}\n`, 'utf8');

  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.ok(baseline);
  assert.equal(baseline.baselineTotalTokens, 7_950_000);

  // The child adds 100k of its own work; codex restates the whole session total.
  await appendFile(file, `${tokenCount(8_050_000)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: baseline,
  });
  // Charged against an 8M ceiling this must be 100k, not 8.05M.
  assert.equal((sampled.totalTokens ?? 0) - (baseline.baselineTotalTokens ?? 0), 100_000);
});

test('captureBudgetUsageBaselineAtEof ignores a per-turn total trailing the cumulative one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-lasttoken-'));
  const file = path.join(dir, 'session.jsonl');
  const cumulative = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 7_950_000, output_tokens: 0, total_tokens: 7_950_000 },
      },
    },
  });
  // codexApplyRecord falls back to `last_token_usage` when the cumulative field is
  // absent, which would drop a last-wins baseline to this per-turn figure.
  const perTurn = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 } },
    },
  });
  await writeFile(file, `${cumulative}\n${perTurn}\n`, 'utf8');

  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.ok(baseline);
  // A baseline of 1000 here would hand the parent's 7.95M straight back to the child.
  assert.equal(baseline.baselineTotalTokens, 7_950_000);
});

test('captureBudgetUsageBaselineAtEof pins to a record boundary when the parent was mid-write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-partial-'));
  const file = path.join(dir, 'session.jsonl');
  const partial = claudeLine(999, 999).slice(0, 40);
  // Parent history plus a half-flushed trailing record.
  await writeFile(file, `${claudeLine(1000, 200)}\n${partial}`, 'utf8');

  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
  });
  assert.ok(baseline);
  assert.ok(baseline.offset < baseline.size, 'pin must sit before the incomplete record');

  await appendFile(file, `${claudeLine(999, 999).slice(40)}\n`, 'utf8');
  await appendFile(file, `${claudeLine(3, 4)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: baseline,
  });
  // A pin inside the record would make the sampler parse its suffix and fail closed
  // as malformed JSONL for the rest of the run.
  assert.equal(sampled.nextState.integrityFailureReason, undefined);
  assert.equal(sampled.enforcementFailure, false);
  assert.equal(sampled.turns, 2);
});

test('captureBudgetUsageBaselineAtEof fails closed when a cumulative total is unavailable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-no-total-'));
  const file = path.join(dir, 'session.jsonl');
  // Records with no usage at all: the parent's total cannot be recovered.
  await writeFile(file, `${JSON.stringify({ type: 'response_item', payload: {} })}\n`, 'utf8');
  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.equal(baseline, null);
});

test('captureBudgetUsageBaselineAtEof returns null for a directory transcript', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-baseline-dir-'));
  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: dir,
  });
  assert.equal(baseline, null);
});

test('sampleBudgetUsage keeps the pin when the session path blips out for one poll', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-blip-'));
  const file = path.join(dir, 'session.jsonl');
  const parent = Array.from({ length: 60 }, () => claudeLine(1000, 200)).join('\n');
  await writeFile(file, `${parent}\n`, 'utf8');

  const baseline = await captureBudgetUsageBaselineAtEof({
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
  });
  assert.ok(baseline);
  await appendFile(file, `${claudeLine(5, 5)}\n${claudeLine(5, 5)}\n`, 'utf8');

  const healthy = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: baseline,
  });
  assert.equal(healthy.turns, 2);

  // One poll where live session discovery comes back empty.
  const blip = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: null,
    prior: healthy.nextState,
  });
  assert.equal(blip.availability, 'unavailable');
  assert.equal(blip.nextState.path, file, 'a transient blip must not forget the transcript');
  assert.equal(blip.nextState.offset, healthy.nextState.offset, 'nor rewind the pin');

  const recovered = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
    prior: blip.nextState,
  });
  // Rewinding would re-read all 60 parent turns and charge them to this run.
  assert.equal(recovered.turns, 2);
  assert.equal(recovered.totalTokens, 20);
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

test('sampleBudgetUsage widens the read to count a record larger than one window', async () => {
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
  // A >1MiB record can carry the turn that crosses a ceiling, so the read widens once
  // rather than skipping it: both records are counted and nothing is skipped.
  assert.equal(first.enforcementFailure, false);
  assert.equal(first.availability, 'available');
  assert.equal(first.nextState.turns, 2);
  assert.equal(first.nextState.totalTokens, 2 + 7);
  assert.equal(first.nextState.skippedOversizedRecords, undefined);
  assert.equal(first.nextState.integrityFailureReason, undefined);
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
