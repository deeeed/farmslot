import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  emptyIncrementalSessionUsageState,
  type IncrementalSessionUsageState,
  runSessionUsage,
  sampleSessionUsageIncremental,
} from './session-usage.js';

function applyClaudeRecord(
  state: IncrementalSessionUsageState,
  record: Record<string, unknown>,
): IncrementalSessionUsageState {
  if (record.type !== 'assistant') return state;
  const message = record.message as Record<string, unknown>;
  const usage = message.usage as Record<string, number>;
  const next = { ...state, turns: state.turns + 1 };
  next.inputTokens += usage.input_tokens ?? 0;
  next.outputTokens += usage.output_tokens ?? 0;
  next.totalTokens = next.inputTokens + next.outputTokens;
  return next;
}

// Each test uses its own isolated temp dir as HOME so fixture files cannot
// bleed across tests. The original process.env.HOME is restored after each.

function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.HOME;
  process.env.HOME = home;
  return fn().finally(() => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  });
}

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'farmslot-su-'));
}

// ─── Claude ──────────────────────────────────────────────────────────────────

test('runSessionUsage extracts Claude usage from a JSONL transcript', async () => {
  const home = makeTmpDir();
  const sessionPath = path.join(home, 'claude.jsonl');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-test',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 4,
        },
      },
    }) + '\n',
  );

  const out = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-1',
      action: 'total',
      forcedPath: sessionPath,
      forcedRunner: 'claude',
    }),
  );

  assert.match(out, /turns=1/);
  assert.match(out, /input_tokens=10/);
  assert.match(out, /cache_creation=20/);
  assert.match(out, /cache_read=30/);
  assert.match(out, /output_tokens=4/);
  // total = input(10) + cache_creation(20) + cache_read(30) + output(4) = 64
  assert.match(out, /total_tokens=64/);
});

test('runSessionUsage total output contains key=value lines parseable by gateway', async () => {
  const home = makeTmpDir();
  const sessionPath = path.join(home, 'session.jsonl');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n',
  );

  const out = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-2',
      action: 'total',
      forcedPath: sessionPath,
      forcedRunner: 'claude',
    }),
  );

  // Header lines
  assert.match(out, /Runner:\s+claude/);
  // key=value lines
  assert.match(out, /model=claude-sonnet-4-6/);
  assert.match(out, /cost_usd=/);
});

// ─── Codex ────────────────────────────────────────────────────────────────────

test('runSessionUsage does not double-count Codex detail fields', async () => {
  const home = makeTmpDir();
  const sessionPath = path.join(home, 'codex.jsonl');
  writeFileSync(
    sessionPath,
    [
      { type: 'session_meta', payload: { cwd: home, model: 'gpt-test' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 70,
              output_tokens: 12,
              reasoning_output_tokens: 5,
              total_tokens: 112,
            },
          },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );

  const out = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-3',
      action: 'total',
      forcedPath: sessionPath,
      forcedRunner: 'codex',
    }),
  );

  assert.match(out, /input_tokens=100/);
  assert.match(out, /cache_read=70/);
  assert.match(out, /reasoning_output_tokens=5/);
  // total_tokens comes from total_token_usage.total_tokens directly
  assert.match(out, /total_tokens=112/);
});

// ─── Grok ─────────────────────────────────────────────────────────────────────

test('runSessionUsage extracts Grok usage by joining summary to unified log', async () => {
  const home = makeTmpDir();
  const sessionDir = path.join(home, '.grok', 'sessions', 'repo', 'session-1');
  const logDir = path.join(home, '.grok', 'logs');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    path.join(sessionDir, 'summary.json'),
    JSON.stringify({ info: { id: 'session-1', cwd: home }, current_model_id: 'grok-test' }),
  );
  writeFileSync(
    path.join(logDir, 'unified.jsonl'),
    JSON.stringify({
      sid: 'session-1',
      msg: 'shell.turn.inference_done',
      ctx: {
        prompt_tokens: 200,
        cached_prompt_tokens: 50,
        completion_tokens: 30,
        reasoning_tokens: 7,
      },
    }) + '\n',
  );

  const out = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-4',
      action: 'total',
      forcedPath: sessionDir,
      forcedRunner: 'grok',
    }),
  );

  assert.match(out, /model=grok-test/);
  assert.match(out, /input_tokens=200/);
  assert.match(out, /output_tokens=30/);
  assert.match(out, /cache_read=50/);
  assert.match(out, /reasoning_output_tokens=7/);
  // Grok detail fields (cached, reasoning) are inside prompt/completion; total = prompt+completion
  assert.match(out, /total_tokens=230/);
});

// ─── Grok auto-discovery ──────────────────────────────────────────────────────

test('runSessionUsage auto-discovers the newest Grok session by repo path', async () => {
  const home = makeTmpDir();
  const repoDir = path.join(home, 'repo');
  mkdirSync(repoDir, { recursive: true });

  const encodedRepo = encodeURIComponent(repoDir);
  const oldDir = path.join(home, '.grok', 'sessions', encodedRepo, 'old-session');
  const newDir = path.join(home, '.grok', 'sessions', encodedRepo, 'new-session');
  const logDir = path.join(home, '.grok', 'logs');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  writeFileSync(
    path.join(oldDir, 'summary.json'),
    JSON.stringify({ info: { id: 'old-session', cwd: repoDir }, current_model_id: 'grok-old' }),
  );
  writeFileSync(
    path.join(newDir, 'summary.json'),
    JSON.stringify({ info: { id: 'new-session', cwd: repoDir }, current_model_id: 'grok-new' }),
  );

  const oldTime = new Date('2026-01-01T00:00:00Z');
  const newTime = new Date('2026-01-02T00:00:00Z');
  utimesSync(oldDir, oldTime, oldTime);
  utimesSync(newDir, newTime, newTime);

  writeFileSync(
    path.join(logDir, 'unified.jsonl'),
    [
      {
        sid: 'old-session',
        msg: 'shell.turn.inference_done',
        ctx: { prompt_tokens: 10, completion_tokens: 1 },
      },
      {
        sid: 'new-session',
        msg: 'shell.turn.inference_done',
        ctx: { prompt_tokens: 40, completion_tokens: 2 },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );

  const out = await withHome(home, () =>
    runSessionUsage({ repo: repoDir, slotId: 'slot-5', action: 'total' }),
  );

  assert.match(out, /Session:\s+new-session/);
  assert.match(out, /Runner:\s+grok/);
  assert.match(out, /model=grok-new/);
  assert.match(out, /total_tokens=42/);
});

// ─── Cursor ───────────────────────────────────────────────────────────────────

test('runSessionUsage extracts Cursor usage from headless JSON stdout', async () => {
  const home = makeTmpDir();
  const sessionPath = path.join(home, 'cursor.json');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: 'result',
      usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 12, cacheWriteTokens: 8 },
    }),
  );

  const out = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-6',
      action: 'total',
      forcedPath: sessionPath,
      forcedRunner: 'cursor',
    }),
  );

  assert.match(out, /input_tokens=300/);
  assert.match(out, /output_tokens=40/);
  assert.match(out, /cache_creation=8/);
  assert.match(out, /cache_read=12/);
  assert.match(out, /total_tokens=340/);
});

// ─── Snapshot / report round-trip ─────────────────────────────────────────────

test('runSessionUsage snapshot then report emits delta key=value lines', async () => {
  const home = makeTmpDir();
  const sessionPath = path.join(home, 'session.jsonl');

  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-test', usage: { input_tokens: 5, output_tokens: 2 } },
    }) + '\n',
  );

  // Take a snapshot
  const snapOut = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-7',
      action: 'snapshot',
      forcedPath: sessionPath,
      forcedRunner: 'claude',
    }),
  );
  assert.match(snapOut, /Snapshot saved:/);

  // Append a second turn to simulate more work
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-test', usage: { input_tokens: 5, output_tokens: 2 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-test', usage: { input_tokens: 10, output_tokens: 3 } },
      }),
    ].join('\n') + '\n',
  );

  // Report should show the delta (second turn only)
  const reportOut = await withHome(home, () =>
    runSessionUsage({
      repo: home,
      slotId: 'slot-7',
      action: 'report',
      forcedPath: sessionPath,
      forcedRunner: 'claude',
    }),
  );

  assert.match(reportOut, /Snapshot:/);
  assert.match(reportOut, /turns=1/);
  assert.match(reportOut, /input_tokens=10/);
  assert.match(reportOut, /output_tokens=3/);
});

// ─── Error cases ──────────────────────────────────────────────────────────────

test('runSessionUsage throws when no session exists for repo', async () => {
  const home = makeTmpDir();
  const repoDir = path.join(home, 'empty-repo');
  mkdirSync(repoDir, { recursive: true });

  await assert.rejects(
    () =>
      withHome(home, () => runSessionUsage({ repo: repoDir, slotId: 'slot-8', action: 'total' })),
    /No Claude, Codex, or Grok session found/,
  );
});

test('runSessionUsage throws when report is called without a prior snapshot', async () => {
  const home = makeTmpDir();
  const sessionPath = path.join(home, 'session.jsonl');
  writeFileSync(
    sessionPath,
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n',
  );

  await assert.rejects(
    () =>
      withHome(home, () =>
        runSessionUsage({
          repo: home,
          slotId: 'slot-9',
          action: 'report',
          forcedPath: sessionPath,
          forcedRunner: 'claude',
        }),
      ),
    /No snapshot found/,
  );
});

test('sampleSessionUsageIncremental skips oversized record without a newline to keep forward progress', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'incr-oversize-'));
  const file = path.join(dir, 'session.jsonl');
  // One giant line > 1MiB with no newline, then a valid record.
  const giant = `{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1},"pad":"${'x'.repeat(1024 * 1024)}"}}`;
  const good = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 10, output_tokens: 2 } },
  });
  writeFileSync(file, `${giant}\n${good}\n`, 'utf8');
  let state = emptyIncrementalSessionUsageState();
  const first = await sampleSessionUsageIncremental({
    filePath: file,
    prior: state,
    applyRecord: applyClaudeRecord,
  });
  // First window advances while explicitly failing closed; it never invents usage.
  assert.ok(first.nextState.offset > 0, 'offset must advance past oversized window');
  assert.equal(first.availability, 'unavailable');
  assert.match(first.unavailableReason ?? '', /exceeds bounded sample window/);
  assert.equal(first.nextState.turns, 0);
  // Continue until the good record is counted after the oversized record's newline.
  state = first.nextState;
  for (let i = 0; i < 5 && state.turns < 1; i++) {
    const next = await sampleSessionUsageIncremental({
      filePath: file,
      prior: state,
      applyRecord: applyClaudeRecord,
    });
    state = next.nextState;
  }
  assert.equal(state.turns, 1);
  assert.equal(state.totalTokens, 12);
  assert.match(state.integrityFailureReason ?? '', /exceeds bounded sample window/);
});

test('sampleSessionUsageIncremental bounds bytes read per sample', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'incr-bound-'));
  const file = path.join(dir, 'session.jsonl');
  // Many short lines totaling > 1MB so a single sample cannot ingest all bytes.
  const line = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const row = `${line}\n`;
  const target = 1024 * 1024 + 50_000;
  const reps = Math.ceil(target / row.length);
  writeFileSync(file, row.repeat(reps), 'utf8');
  const first = await sampleSessionUsageIncremental({
    filePath: file,
    prior: emptyIncrementalSessionUsageState(),
    applyRecord: applyClaudeRecord,
  });
  assert.ok(first.nextState.offset > 0);
  assert.ok(
    first.nextState.offset <= 1024 * 1024 + row.length,
    `offset ${first.nextState.offset} should be bounded near 1MiB window`,
  );
  assert.ok((first.turns ?? 0) > 0);
  // Second sample continues from offset (more turns accumulate).
  const second = await sampleSessionUsageIncremental({
    filePath: file,
    prior: first.nextState,
    applyRecord: applyClaudeRecord,
  });
  assert.ok((second.turns ?? 0) > (first.turns ?? 0));
});

test('sampleSessionUsageIncremental preserves incomplete trailing JSONL across polls', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'incr-usage-'));
  const file = path.join(dir, 'session.jsonl');
  const line = (a: number, b: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: a, output_tokens: b } },
    });
  const line1 = line(10, 2);
  const line2 = line(5, 1);
  writeFileSync(file, `${line1}\n`, 'utf8');
  const first = await sampleSessionUsageIncremental({
    filePath: file,
    prior: emptyIncrementalSessionUsageState(),
    applyRecord: applyClaudeRecord,
  });
  assert.equal(first.turns, 1);
  const mid = Math.floor(line2.length / 2);
  appendFileSync(file, line2.slice(0, mid), 'utf8');
  const midSample = await sampleSessionUsageIncremental({
    filePath: file,
    prior: first.nextState,
    applyRecord: applyClaudeRecord,
  });
  assert.equal(midSample.turns, 1);
  assert.equal(midSample.nextState.offset, first.nextState.offset);
  appendFileSync(file, `${line2.slice(mid)}\n`, 'utf8');
  const second = await sampleSessionUsageIncremental({
    filePath: file,
    prior: midSample.nextState,
    applyRecord: applyClaudeRecord,
  });
  assert.equal(second.turns, 2);
});
