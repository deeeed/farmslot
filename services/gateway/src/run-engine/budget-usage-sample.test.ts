import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  captureBudgetUsageBaselinePin,
  emptyBudgetUsageSampleState,
  sampleBudgetUsage,
} from './budget-usage-sample.js';

const localVars = { host: 'localhost', machine: 'local', slotId: 's1' } as never;

function codexTotal(total: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } },
    },
  });
}

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

test('captureBudgetUsageBaselinePin charges the child only for bytes appended after handoff', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-baseline-'));
  const file = path.join(dir, 'session.jsonl');
  // Parent history far larger than one bounded sample window: parsing it to build a
  // totals baseline is exactly what mis-charged the child before this fix.
  const parentLines = Array.from({ length: 4000 }, () => claudeLine(1000, 200)).join('\n');
  await writeFile(file, `${parentLines}\n`, 'utf8');

  const baseline = await captureBudgetUsageBaselinePin({
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

test('a cumulative runner charges only post-pin growth, not the session total', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-cumulative-'));
  const file = path.join(dir, 'session.jsonl');
  // Codex restates the whole session's totals on every record: the parent burned 7.95M.
  await writeFile(file, `${codexTotal(7_950_000)}\n`, 'utf8');

  const baseline = await captureBudgetUsageBaselinePin({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.ok(baseline);

  // The child's first reading establishes the reference (its own work up to that point
  // is not charged); growth from there is counted.
  await appendFile(file, `${codexTotal(8_000_000)}\n${codexTotal(8_050_000)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: baseline,
  });
  // Against an 8M ceiling this must be the child's growth, never the session total.
  assert.equal(sampled.totalTokens, 50_000);
  assert.ok((sampled.totalTokens ?? 0) < 7_950_000, 'parent history must never be charged');
});

test('a cumulative runner still counts a full transcript from byte 0', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-cold-'));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, `${codexTotal(4000)}\n${codexTotal(9000)}\n`, 'utf8');
  // A cold run owns everything in its transcript, so nothing is skipped as a reference.
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(sampled.totalTokens, 9000);
});

test('a per-turn reading is skipped and cannot poison the cumulative reference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-lasttoken-'));
  const file = path.join(dir, 'session.jsonl');
  // A record carrying only `last_token_usage` reports one turn, not the session. Folding
  // it would overwrite the reference with that small number, so the next session total
  // would be charged the whole way back up.
  const perTurn = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 } },
    },
  });
  await writeFile(
    file,
    `${codexTotal(4000)}\n${codexTotal(9000)}\n${perTurn}\n${codexTotal(9500)}\n`,
    'utf8',
  );
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  // 9500 total, not 9500 + 8500 re-charged after a poisoned 1000 reference.
  assert.equal(sampled.totalTokens, 9500);
});

test('captureBudgetUsageBaselinePin pins to a record boundary when the parent was mid-write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-partial-'));
  const file = path.join(dir, 'session.jsonl');
  const partial = claudeLine(999, 999).slice(0, 40);
  // Parent history plus a half-flushed trailing record.
  await writeFile(file, `${claudeLine(1000, 200)}\n${partial}`, 'utf8');

  const baseline = await captureBudgetUsageBaselinePin({
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

test('captureBudgetUsageBaselinePin returns null for a directory transcript', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-baseline-dir-'));
  const baseline = await captureBudgetUsageBaselinePin({
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

  const baseline = await captureBudgetUsageBaselinePin({
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
