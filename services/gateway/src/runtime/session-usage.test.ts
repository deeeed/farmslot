import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSessionUsageOutput, pickRunSessionTranscript } from './session-usage.js';

function transcriptAt(dir: string, name: string, mtimeMs: number): string {
  const p = path.join(dir, name);
  writeFileSync(p, '{}');
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

test('pickRunSessionTranscript picks the in-window transcript and rejects a prior run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pick-session-'));
  const dispatchedAt = '2026-06-30T10:00:00.000Z';
  const completedAt = '2026-06-30T10:30:00.000Z';
  const dispatchMs = Date.parse(dispatchedAt);
  // Prior run on the same slot, last written 10 minutes before this run dispatched.
  const prior = transcriptAt(dir, 'prior.jsonl', dispatchMs - 10 * 60_000);
  // This run's transcript, last written mid-run.
  const current = transcriptAt(dir, 'current.jsonl', dispatchMs + 15 * 60_000);

  // listRunnerSessionFiles returns newest-first; the prior file is older.
  assert.equal(pickRunSessionTranscript([current, prior], dispatchedAt, completedAt), current);
  // With ONLY the prior run's transcript, nothing in-window → null (never mis-attributed).
  assert.equal(pickRunSessionTranscript([prior], dispatchedAt, completedAt), null);

  // Two transcripts in-window (e.g. a concurrent/manual same-repo session) → null,
  // never a guess.
  const other = transcriptAt(dir, 'other.jsonl', dispatchMs + 20 * 60_000);
  assert.equal(pickRunSessionTranscript([other, current, prior], dispatchedAt, completedAt), null);
});

test('pickRunSessionTranscript returns null for an unparseable dispatch time', () => {
  assert.equal(pickRunSessionTranscript(['/whatever.jsonl'], 'not-a-date'), null);
});

test('parseSessionUsageOutput normalizes runner session cost fields', () => {
  const usage = parseSessionUsageOutput(
    `
Session:  abc123
Runner:   codex
---
turns=4
model=gpt-5.5
input_tokens=1200
output_tokens=345
cache_creation=0
cache_read=50
reasoning_output_tokens=22
total_tokens=1617
cost_usd=0.0123
`,
    {
      runner: 'codex',
      runnerSessionId: 'abc123',
      runnerSessionPath: '/tmp/abc123.jsonl',
    },
  );

  assert.equal(usage.source, 'runner-transcript');
  assert.equal(usage.scope, 'session-total');
  assert.equal(usage.runner, 'codex');
  assert.equal(usage.runnerSessionId, 'abc123');
  assert.equal(usage.actualModel, 'gpt-5.5');
  assert.equal(usage.turns, 4);
  assert.equal(usage.inputTokens, 1200);
  assert.equal(usage.outputTokens, 345);
  assert.equal(usage.cacheRead, 50);
  assert.equal(usage.reasoningOutputTokens, 22);
  assert.equal(usage.totalTokens, 1617);
  assert.equal(usage.costUsd, 0.0123);
  assert.match(usage.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('extractRunnerSessionUsage returns unavailable when runner has no transcript path', async () => {
  const { extractRunnerSessionUsage } = await import('./session-usage.js');
  const usage = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    runner: 'cursor',
    runnerSessionId: null,
    runnerSessionPath: null,
  });

  assert.equal(usage.source, 'unavailable');
  assert.equal(usage.runner, 'cursor');
  assert.match(usage.error ?? '', /did not expose/);
});

test('extractRunnerSessionUsage does not read remote transcript paths locally', async () => {
  const { extractRunnerSessionUsage } = await import('./session-usage.js');
  const usage = await extractRunnerSessionUsage({
    slotId: 'remote-slot',
    vars: { host: 'remote.example', machine: 'remote-machine' } as any,
    runner: 'claude',
    runnerSessionId: 'abc123',
    runnerSessionPath: '/home/runner/.claude/projects/repo/abc123.jsonl',
  });

  assert.equal(usage.source, 'unavailable');
  assert.equal(usage.runnerSessionId, 'abc123');
  assert.match(usage.error ?? '', /remote slots/);
});
