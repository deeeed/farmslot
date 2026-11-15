// Minimal guards: one record shape per adapter, and the counter's segmentation. Real-transcript
// results are in the PR, not here.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { type ChecklistMark, countToolUsage, measureToolUsage, mergeToolUsage } from './index.js';

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
    },
    marks,
  );
  assert.equal(usage.toolCallsBeforeFirstMark, 2);
  assert.deepEqual(
    usage.steps.map((s) => [s.segment, s.stepNumber, s.toolCalls, s.totalTokens, s.wallMs]),
    [
      ['before-first-mark', 1, 2, 100, 9000],
      ['step', 2, 1, 50, 10000],
      ['after-last-mark', undefined, 1, 0, 5000],
    ],
  );
});

test('counter: no marks means no segments; tokenless runners report null', () => {
  const none = countToolUsage({ tools: [{ name: 'bash', issuedAt: t(1) }], tokens: [] }, []);
  assert.equal(none.toolCallsBeforeFirstMark, null);
  assert.deepEqual(none.steps, []);
  const tokenless = countToolUsage(
    { tools: [{ name: 'bash', issuedAt: t(1) }], tokens: null },
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
  const second = countToolUsage({ tools: [{ name: 'b', issuedAt: t(15) }], tokens: [] }, marks, {
    startedAt: t(12),
    completedAt: t(30),
  });
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
  const first = countToolUsage({ tools: [{ name: 'a', issuedAt: t(5) }], tokens: [] }, marks, {
    startedAt: t(0),
    completedAt: t(12),
  });
  const second = countToolUsage({ tools: [{ name: 'b', issuedAt: t(15) }], tokens: [] }, marks, {
    startedAt: t(12),
    completedAt: t(30),
  });
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
