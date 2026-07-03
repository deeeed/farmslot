import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunnerSessionHistoryProvider } from './worker-session-history.js';

test('projects Claude JSONL into chat messages with collapsed tool chips', () => {
  const provider = getRunnerSessionHistoryProvider('claude');
  assert.ok(provider);

  const projection = provider.project([
    JSON.stringify({
      type: 'system',
      content: '<system-reminder>noise</system-reminder>',
    }),
    JSON.stringify({
      uuid: 'u1',
      type: 'user',
      message: { content: [{ type: 'text', text: 'Please inspect the file.' }] },
      timestamp: '2026-07-03T10:00:00Z',
    }),
    JSON.stringify({
      uuid: 'a1',
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'x.ts' } },
        ],
      },
    }),
    '{"type":"assistant"',
  ]);

  assert.equal(projection.skippedMalformedLines, 1);
  assert.deepEqual(
    projection.messages.map((message) => ({
      role: message.role,
      text: message.text,
      tools: message.tools?.map((tool) => tool.name) ?? [],
    })),
    [
      { role: 'user', text: 'Please inspect the file.', tools: [] },
      { role: 'assistant', text: 'I will inspect it.', tools: ['Read'] },
    ],
  );
});

test('projects Codex response items and filters system/developer noise', () => {
  const provider = getRunnerSessionHistoryProvider('codex');
  assert.ok(provider);

  const projection = provider.project([
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix the test.' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The test is fixed.' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
      },
    }),
  ]);

  assert.equal(projection.skippedMalformedLines, 0);
  assert.deepEqual(
    projection.messages.map((message) => ({
      role: message.role,
      text: message.text,
      tools: message.tools?.map((tool) => tool.name) ?? [],
    })),
    [
      { role: 'user', text: 'Fix the test.', tools: [] },
      { role: 'assistant', text: 'The test is fixed.', tools: [] },
      { role: 'assistant', text: '', tools: ['shell'] },
    ],
  );
});

test('projects Grok chat history and reports missing providers honestly', () => {
  const provider = getRunnerSessionHistoryProvider('grok');
  assert.ok(provider);
  assert.equal(getRunnerSessionHistoryProvider('cursor'), null);

  const projection = provider.project([
    JSON.stringify({ role: 'system', content: 'hidden' }),
    JSON.stringify({ role: 'user', content: 'Summarize status.' }),
    JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Status is green.' },
        { type: 'tool_use', id: 'grok_tool_1', name: 'search' },
      ],
    }),
  ]);

  assert.deepEqual(
    projection.messages.map((message) => ({
      role: message.role,
      text: message.text,
      tools: message.tools?.map((tool) => tool.name) ?? [],
    })),
    [
      { role: 'user', text: 'Summarize status.', tools: [] },
      { role: 'assistant', text: 'Status is green.', tools: ['search'] },
    ],
  );
});
