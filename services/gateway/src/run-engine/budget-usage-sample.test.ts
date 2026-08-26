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
  assert.equal('baselineTotalTokens' in baseline, false, 'no subtraction left to carry');

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

test('a warm pin seeds the reference so the child loses no reading', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-seed-'));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, `${codexTotal(7_950_000)}\n`, 'utf8');
  const baseline = await captureBudgetUsageBaselinePin({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.ok(baseline);
  assert.equal(baseline.lastCumulative?.total, 7_950_000, 'reference comes from the parent');

  // A child whose entire work is ONE reading must still be charged for it.
  await appendFile(file, `${codexTotal(8_000_000)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: baseline,
  });
  assert.equal(sampled.totalTokens, 50_000);
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

  await appendFile(file, `${codexTotal(8_000_000)}\n${codexTotal(8_050_000)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: baseline,
  });
  // Against an 8M ceiling this must be the child's growth, never the session total.
  assert.equal(sampled.totalTokens, 100_000);
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

test('turn.completed usage is added as an increment, not folded as a session total', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-turncomplete-'));
  const file = path.join(dir, 'session.jsonl');
  const turnCompleted = (total: number) =>
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: total, output_tokens: 0 } });
  // `codex exec --json` reports this turn's usage at the top level, not the session's.
  // Folding it would charge a bogus delta and re-seat the reference to a per-turn figure,
  // so the next cumulative reading would charge the whole session again.
  await writeFile(
    file,
    `${codexTotal(9_000_000)}\n${turnCompleted(1000)}\n${codexTotal(9_001_000)}\n`,
    'utf8',
  );
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: emptyBudgetUsageSampleState(),
  });
  // 9,000,000 session + 1,000 turn + 1,000 growth. Not 18,000,000.
  assert.equal(sampled.totalTokens, 9_002_000);
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
  // The parent's half-flushed record completes after the pin; only the child's own
  // record is counted.
  assert.equal(sampled.turns, 1);
  assert.equal(sampled.totalTokens, 7);
});

test('a cumulative parent record in flight at the pin is not charged to the child', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-inflight-'));
  const file = path.join(dir, 'session.jsonl');
  const inflight = codexTotal(6_000_000);
  // Parent history, then a partially flushed parent record worth 2M more.
  await writeFile(file, `${codexTotal(4_000_000)}\n${inflight.slice(0, 30)}`, 'utf8');

  const baseline = await captureBudgetUsageBaselinePin({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.ok(baseline);
  assert.equal(baseline.discardNextRecord, true);

  // The parent finishes its record, then the child does 100k of its own work.
  await appendFile(file, `${inflight.slice(30)}\n${codexTotal(6_100_000)}\n`, 'utf8');
  const sampled = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
    prior: baseline,
  });
  // Charging the parent's in-flight 2M here is the same class of bug as charging its
  // whole history.
  assert.equal(sampled.totalTokens, 100_000);
});

test('one corrupt parent line does not tear down a warm handoff for an additive runner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-corrupt-'));
  const file = path.join(dir, 'session.jsonl');
  // claude needs only the byte offset — there is no reference to recover, so failing the
  // capture here would kill a healthy retained session for no accounting benefit.
  await writeFile(file, `${claudeLine(10, 2)}\n{not json at all\n${claudeLine(5, 1)}\n`, 'utf8');
  const baseline = await captureBudgetUsageBaselinePin({
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: file,
  });
  assert.ok(baseline, 'the pin only needs the offset for a runner that reports increments');
  assert.equal(baseline.offset, baseline.size);
});

test('one corrupt parent line fails the pin closed for a runner that restates totals', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'budget-usage-corrupt-codex-'));
  const file = path.join(dir, 'session.jsonl');
  // Here the corrupt line may be the reading that moved the session forward. Keeping the
  // older one would charge the child the gap.
  await writeFile(file, `${codexTotal(4000)}\n{not json at all\n`, 'utf8');
  const baseline = await captureBudgetUsageBaselinePin({
    vars: localVars,
    runner: 'codex',
    runnerSessionPath: file,
  });
  assert.equal(baseline, null);
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

test('a failed stat never stamps a new transcript identity onto old accounting', async () => {
  const dirA = await mkdtemp(path.join(tmpdir(), 'budget-usage-idA-'));
  const fileA = path.join(dirA, 'a.jsonl');
  await writeFile(fileA, `${claudeLine(1000, 200)}\n`, 'utf8');
  const first = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: fileA,
    prior: emptyBudgetUsageSampleState(),
  });
  assert.equal(first.nextState.path, fileA);

  // Discovery swings to a path that cannot be read yet.
  const missingB = path.join(dirA, 'b.jsonl');
  const blip = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: missingB,
    prior: first.nextState,
  });
  // Recording B's identity beside A's offset would make continuity look intact and the
  // next readable poll would sample B mid-file against A's accounting.
  assert.equal(blip.nextState.path, fileA, 'identity must stay with the counted transcript');
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

test('a lost integrity flag survives a transient unavailable poll', async () => {
  const poisoned = {
    ...emptyBudgetUsageSampleState(),
    path: '/tmp/gone.jsonl',
    integrityFailureReason: 'session transcript changed after budget accounting began',
  };
  const blip = await sampleBudgetUsage({
    slotId: 's1',
    vars: localVars,
    runner: 'claude',
    runnerSessionPath: null,
    prior: poisoned,
  });
  // Reporting a clean unavailable here would let the guard resume as if accounting were
  // merely paused rather than permanently untrustworthy.
  assert.equal(blip.enforcementFailure, true);
  assert.equal(blip.nextState.integrityFailureReason, poisoned.integrityFailureReason);
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
