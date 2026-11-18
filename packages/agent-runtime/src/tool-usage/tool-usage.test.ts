// Minimal guards: one record shape per adapter, and the counter's segmentation. Real-transcript
// results are in the PR, not here.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  type ChecklistMark,
  countToolUsage,
  createLiveToolUsage,
  measureToolUsage,
  mergeToolUsage,
} from './index.js';

let dir = '';
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tool-usage-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function jsonl(name: string, records: unknown[]): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

const t = (second: number) => new Date(Date.UTC(2026, 10, 15, 13, 0, second)).toISOString();

test('pi: toolCall blocks, toolResult completion, per-message tokens', async () => {
  const file = await jsonl('pi.jsonl', [
    {
      type: 'message',
      id: 'a',
      timestamp: t(1),
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash' }],
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 },
      },
    },
    {
      type: 'message',
      id: 'b',
      timestamp: t(2),
      message: { role: 'toolResult', toolCallId: 'c1' },
    },
  ]);
  const usage = await measureToolUsage({ runner: 'pi', sessionPath: file });
  assert.deepEqual(usage.toolCallsByName, { bash: 1 });
});

test('claude: tool_use counted once across repeated records', async () => {
  const assistant = {
    type: 'assistant',
    timestamp: t(1),
    message: {
      id: 'm1',
      content: [{ type: 'tool_use', id: 'u1', name: 'Bash' }],
      usage: { input_tokens: 5 },
    },
  };
  const file = await jsonl('claude.jsonl', [assistant, assistant]);
  const usage = await measureToolUsage({ runner: 'claude', sessionPath: file });
  assert.equal(usage.toolCalls, 1);
});

test('codex: executed items win over the code-mode exec wrapper', async () => {
  const file = await jsonl('codex.jsonl', [
    {
      type: 'response_item',
      timestamp: t(1),
      payload: { type: 'custom_tool_call', call_id: 'x', name: 'exec' },
    },
    {
      type: 'event_msg',
      timestamp: t(2),
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'e1' } },
    },
    {
      type: 'event_msg',
      timestamp: t(3),
      payload: { type: 'item_completed', item: { type: 'FileChange', id: 'e2' } },
    },
    {
      type: 'event_msg',
      timestamp: t(3),
      payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'e3' } },
    },
  ]);
  const usage = await measureToolUsage({ runner: 'codex', sessionPath: file });
  assert.deepEqual(usage.toolCallsByName, { commandExecution: 1, fileChange: 1 });
});

test('codex: older rollouts count *_call response items', async () => {
  const file = await jsonl('codex-old.jsonl', [
    {
      type: 'response_item',
      timestamp: t(1),
      payload: { type: 'function_call', call_id: 'x', name: 'shell' },
    },
  ]);
  const usage = await measureToolUsage({ runner: 'codex', sessionPath: file });
  assert.deepEqual(usage.toolCallsByName, { shell: 1 });
});

test('grok: events.jsonl tool_started', async () => {
  await jsonl('grok/s1/events.jsonl', [
    { ts: t(1), type: 'tool_started', tool_name: 'grep' },
    { ts: t(2), type: 'tool_completed', tool_name: 'grep', tool_call_id: 'g1' },
  ]);
  await jsonl('home/.grok/logs/unified.jsonl', []);
  const usage = await measureToolUsage({
    runner: 'grok',
    sessionPath: path.join(dir, 'grok/s1'),
    home: path.join(dir, 'home'),
  });
  assert.deepEqual(usage.toolCallsByName, { grep: 1 });
});

test('cursor: tool_use without times counts as untimed', async () => {
  const file = await jsonl('cursor.jsonl', [
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
  ]);
  const usage = await measureToolUsage({ runner: 'cursor', sessionPath: file });
  assert.equal(usage.untimedToolCalls, 1);
  assert.equal(usage.toolCalls, 1);
  assert.match(usage.stepsUnavailable ?? '', /no call times/);
  const marked = await measureToolUsage({ runner: 'cursor', sessionPath: file, marks });
  assert.deepEqual(marked.steps, []);
  assert.equal(marked.toolCallsBeforeFirstMark, null);
  assert.match(marked.stepsUnavailable ?? '', /no call times/);
  const windowed = countToolUsage(
    { tools: [{ name: 'Read' }], tokens: null, compactions: [] },
    marks,
    {
      startedAt: t(0),
      completedAt: t(5),
    },
  );
  assert.deepEqual(windowed.steps, []);
  assert.equal(windowed.toolCallsBeforeFirstMark, null);
  assert.match(windowed.stepsUnavailable ?? '', /no call times/);
});

test('native: tool.started paired by nativeId', async () => {
  const file = await jsonl('native.journal', [
    { event: { type: 'tool.started', at: t(1), nativeId: 'n1', tool: { name: 'Bash' } } },
    { event: { type: 'tool.started', at: t(1), nativeId: 'n1', tool: { name: 'Bash' } } },
    { event: { type: 'tool.completed', at: t(2), nativeId: 'n1', tool: { name: 'Claude tool' } } },
  ]);
  const usage = await measureToolUsage({ runner: 'native', sessionPath: file });
  assert.deepEqual(usage.toolCallsByName, { Bash: 1 });
});

const marks: ChecklistMark[] = [
  { stepNumber: 1, label: '1. Read', checkedAt: t(10) },
  { stepNumber: 2, label: '2. Fix', checkedAt: t(20) },
];

test('counter: segments by issue time, the mark call in its own step', () => {
  const usage = countToolUsage(
    {
      tools: [
        { name: 'bash', issuedAt: t(1) },
        { name: 'bash', issuedAt: t(9) },
        { name: 'edit', issuedAt: t(15) },
        { name: 'bash', issuedAt: t(25) },
      ],
      tokens: [
        { at: t(1), tokens: 100 },
        { at: t(15), tokens: 50 },
      ],
      compactions: [{ at: t(12) }, { at: t(22), tokensBefore: 900 }],
    },
    marks,
  );
  assert.equal(usage.toolCallsBeforeFirstMark, 2);
  assert.equal(usage.compactions, 2);
  assert.deepEqual(
    usage.steps.map((s) => [
      s.segment,
      s.stepNumber,
      s.toolCalls,
      s.totalTokens,
      s.wallMs,
      s.compactions,
    ]),
    [
      ['before-first-mark', 1, 2, 100, 9000, 0],
      ['step', 2, 1, 50, 10000, 1],
      ['after-last-mark', undefined, 1, 0, 5000, 1],
    ],
  );
});

test('counter: a runner that records no compactions reports null with its reason', () => {
  const usage = countToolUsage(
    {
      tools: [{ name: 'bash', issuedAt: t(1) }],
      tokens: [],
      compactions: null,
      compactionsUnavailable: 'Cursor transcripts record no compaction events',
    },
    marks,
  );
  assert.equal(usage.compactions, null);
  assert.equal(usage.compactionsUnavailable, 'Cursor transcripts record no compaction events');
  assert.equal(usage.steps[0].compactions, null);
  const merged = mergeToolUsage([
    usage,
    countToolUsage({ tools: [], tokens: [], compactions: [{ at: t(5) }] }, marks),
  ]);
  assert.equal(merged?.compactions, null, 'one unknown session makes the run total unknown');
});

test('counter: no marks means no segments; tokenless runners report null', () => {
  const none = countToolUsage(
    { tools: [{ name: 'bash', issuedAt: t(1) }], tokens: [], compactions: [] },
    [],
  );
  assert.equal(none.toolCallsBeforeFirstMark, null);
  assert.deepEqual(none.steps, []);
  const tokenless = countToolUsage(
    { tools: [{ name: 'bash', issuedAt: t(1) }], tokens: null, compactions: [] },
    marks,
  );
  assert.equal(tokenless.steps[0].totalTokens, null);
});

test('merge: a session that ends between marks keeps its tail in that step', () => {
  const first = countToolUsage(
    {
      tools: [
        { name: 'a', issuedAt: t(5) },
        { name: 'a', issuedAt: t(11) },
      ],
      tokens: [],
      compactions: [],
    },
    marks,
    { startedAt: t(0), completedAt: t(12) },
  );
  assert.deepEqual(
    first.steps.map((s) => [s.segment, s.stepNumber, s.toolCalls, s.endedAt]),
    [
      ['before-first-mark', 1, 1, t(10)],
      ['step', 2, 1, t(12)],
    ],
  );
  const second = countToolUsage(
    { tools: [{ name: 'b', issuedAt: t(15) }], tokens: [], compactions: [] },
    marks,
    {
      startedAt: t(12),
      completedAt: t(30),
    },
  );
  const merged = mergeToolUsage([first, second]);
  assert.equal(merged?.toolCalls, 3);
  assert.equal(merged?.toolCallsBeforeFirstMark, 1);
  assert.deepEqual(
    merged?.steps.map((s) => [s.segment, s.stepNumber, s.toolCalls, s.startedAt, s.endedAt]),
    [
      ['before-first-mark', 1, 1, t(5), t(10)],
      ['step', 2, 2, t(10), t(20)],
      ['after-last-mark', undefined, 0, t(20), t(30)],
    ],
  );
});

test('codex: an item starts at its recorded start time', async () => {
  const file = await jsonl('codex-start.jsonl', [
    {
      type: 'event_msg',
      timestamp: t(30),
      payload: {
        type: 'item_completed',
        started_at_ms: Date.parse(t(2)),
        item: { type: 'Extension', id: 'x1' },
      },
    },
  ]);
  const usage = await measureToolUsage({
    runner: 'codex',
    sessionPath: file,
    marks: [{ stepNumber: 1, label: '1. Read', checkedAt: t(10) }],
  });
  assert.equal(usage.toolCallsBeforeFirstMark, 1);
});

test('merge: a later session starts mid-run', () => {
  const first = countToolUsage(
    { tools: [{ name: 'a', issuedAt: t(5) }], tokens: [], compactions: [] },
    marks,
    {
      startedAt: t(0),
      completedAt: t(12),
    },
  );
  const second = countToolUsage(
    { tools: [{ name: 'b', issuedAt: t(15) }], tokens: [], compactions: [] },
    marks,
    {
      startedAt: t(12),
      completedAt: t(30),
    },
  );
  const merged = mergeToolUsage([first, second]);
  assert.equal(merged?.toolCalls, 2);
  assert.equal(merged?.toolCallsBeforeFirstMark, 1);
  assert.deepEqual(
    merged?.steps.map((s) => [s.segment, s.stepNumber]),
    [
      ['before-first-mark', 1],
      ['step', 2],
      ['after-last-mark', undefined],
    ],
  );
});

test('live: any chunking of a transcript gives the full read, and closed steps are frozen', async () => {
  const lines = [1, 5, 12, 15, 22, 25].map((second) =>
    JSON.stringify({
      type: 'message',
      id: `m${second}`,
      timestamp: t(second),
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: `c${second}`, name: 'bash' }],
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
      },
    }),
  );
  lines.splice(3, 0, JSON.stringify({ type: 'compaction', timestamp: t(14), tokensBefore: 900 }));
  const text = `${lines.join('\n')}\n`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-usage-'));
  const file = path.join(dir, 'pi.jsonl');
  await writeFile(file, text);
  const full = await measureToolUsage({ runner: 'pi', sessionPath: file, marks });
  await rm(dir, { recursive: true, force: true });
  for (const size of [1, 7, 64, text.length]) {
    const live = createLiveToolUsage('pi')!;
    let summary;
    for (let at = 0; at < text.length; at += size) {
      live.append(Buffer.from(text.slice(at, at + size)));
      summary = live.summary(marks);
    }
    assert.equal(summary!.toolCalls, full.toolCalls, `chunk ${size}`);
    assert.equal(summary!.compactions, 1);
    assert.equal(summary!.costUsd, 3);
    assert.deepEqual(
      summary!.steps.map((step) => [step.stepNumber ?? 'end', step.toolCalls, step.compactions]),
      full.steps.map((step) => [step.stepNumber ?? 'end', step.toolCalls, step.compactions]),
    );
  }
  assert.equal(createLiveToolUsage('cursor'), undefined, 'cursor has no appendable transcript');
});

const codexLine = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const codexItem = (completed: number, started: number, id: string) =>
  codexLine({
    timestamp: t(completed),
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      started_at_ms: Date.parse(t(started)),
      item: { type: 'CommandExecution', id },
    },
  });

test('live: codex bills cached input at the cached rate', () => {
  const live = createLiveToolUsage('codex')!;
  const usage = (input: number, cached: number, output: number) =>
    codexLine({
      type: 'event_msg',
      timestamp: t(2),
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            total_tokens: input + output,
          },
        },
      },
    });
  live.append(
    Buffer.from(
      codexLine({ type: 'turn_context', timestamp: t(1), payload: { model: 'gpt-6.1-sol' } }) +
        usage(1_000_000, 900_000, 10_000) +
        usage(2_000_000, 1_800_000, 20_000),
    ),
  );
  // Each of the two samples: 100k uncached at $2, 900k cached at $0.10, 10k output at $10 per 1M.
  assert.equal(live.summary([])!.costUsd?.toFixed(4), '0.7800');
});

test('live: a record timed inside a frozen step is added to that step, not lost', () => {
  const live = createLiveToolUsage('codex')!;
  live.append(Buffer.from(codexItem(5, 4, 'a') + codexItem(12, 11, 'b')));
  let summary = live.summary(marks);
  assert.deepEqual(
    summary.steps.map((step) => [step.stepNumber ?? 'end', step.toolCalls]),
    [
      [1, 1],
      [2, 1],
      ['end', 0],
    ],
  );
  // A long command that started before mark 1 (second 10) completes now.
  live.append(Buffer.from(codexItem(14, 9, 'c')));
  summary = live.summary(marks);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.steps[0].toolCalls, 2, 'the back-dated call belongs to step 1');
  // Freezing step 2 later keeps the total.
  live.append(Buffer.from(codexItem(25, 24, 'd')));
  assert.equal(live.summary(marks).toolCalls, 4);
});

test('live: a late record in a step the first read saw nothing of gets that step', () => {
  const live = createLiveToolUsage('codex')!;
  // Marks at 10 and 20; nothing yet in step 1, calls at 12 and 25.
  live.append(Buffer.from(codexItem(13, 12, 'a') + codexItem(26, 25, 'b')));
  live.summary(marks);
  // A long command that started at second 9 completes now: it belongs to step 1.
  live.append(Buffer.from(codexItem(27, 9, 'late')));
  const summary = live.summary(marks);
  assert.deepEqual(
    summary.steps.map((step) => [step.stepNumber ?? 'end', step.toolCalls, step.toolCallsByName]),
    [
      [1, 1, { commandExecution: 1 }],
      [2, 1, { commandExecution: 1 }],
      ['end', 1, { commandExecution: 1 }],
    ],
  );
  assert.equal(summary.toolCalls, 3);
});

test('live: a late priced record keeps an unknown step cost unknown', () => {
  const live = createLiveToolUsage('pi')!;
  const msg = (second: number, cost: unknown) =>
    `${JSON.stringify({ type: 'message', id: `p${second}`, timestamp: t(second), message: { role: 'assistant', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, ...(cost === undefined ? {} : { cost: { total: cost } }) } } })}\n`;
  live.append(Buffer.from(msg(5, undefined) + msg(12, 1)));
  live.summary(marks);
  live.append(Buffer.from(msg(6, 2)));
  const summary = live.summary(marks);
  assert.equal(summary.steps[0].costUsd, null);
  assert.equal(summary.costUsd, null);
});

test('codex: native items stay the calls after old ones are dropped', () => {
  const live = createLiveToolUsage('codex')!;
  live.append(
    Buffer.from(
      codexItem(5, 4, 'a') +
        codexLine({
          timestamp: t(12),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { total_tokens: 100, input_tokens: 90, output_tokens: 10 } },
          },
        }) +
        codexLine({
          timestamp: t(12),
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'w', name: 'exec' },
        }),
    ),
  );
  // The token record freezes step 1 and drops item `a`; the wrapper must not then count as a call.
  assert.equal(live.summary(marks).toolCalls, 1, 'the exec wrapper is not a second call');
});

test('counter: a compaction outside the call and token span still counts', () => {
  const usage = countToolUsage(
    {
      tools: [{ name: 'bash', issuedAt: t(5) }],
      tokens: [],
      compactions: [{ at: t(1) }, { at: t(30) }],
    },
    [],
  );
  assert.equal(usage.compactions, 2);
});
