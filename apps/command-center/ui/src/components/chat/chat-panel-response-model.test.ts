import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '@farmslot/protocol';

import {
  applyChatPanelResponse,
  type ChatPanelResponseState,
} from './chat-panel-response-model.js';

function state(overrides: Partial<ChatPanelResponseState> = {}): ChatPanelResponseState {
  return {
    messages: [],
    streamingText: '',
    streamingStatus: '',
    streamingError: '',
    sending: true,
    sessionCost: 0,
    usageOpen: false,
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'Done',
    timestamp: '2026-05-14T00:00:00.000Z',
    ...overrides,
  } as ChatMessage;
}

test('applyChatPanelResponse ignores stale session payloads without side effects', () => {
  const current = state({ streamingText: 'current' });
  const next = applyChatPanelResponse(
    current,
    { sessionId: 'other', state: 'delta', text: ' stale' },
    'active',
  );

  assert.equal(next.ignored, true);
  assert.equal(next.streamingText, 'current');
  assert.equal(next.shouldScrollToBottom, false);
});

test('applyChatPanelResponse appends delta text and preserves explicit status precedence', () => {
  const workingText = applyChatPanelResponse(
    state({ streamingStatus: 'Working…', streamingText: 'Hel' }),
    { sessionId: 'active', state: 'delta', text: 'lo' },
    'active',
  );
  assert.equal(workingText.streamingStatus, 'Streaming answer...');
  assert.equal(workingText.streamingText, 'Hello');

  const statusWithText = applyChatPanelResponse(
    state({ streamingStatus: 'Working…', streamingText: 'Hel' }),
    { sessionId: 'active', state: 'delta', statusText: 'Reading files…', text: 'lo' },
    'active',
  );
  assert.equal(statusWithText.streamingStatus, 'Reading files…');
  assert.equal(statusWithText.streamingText, 'Hello');

  const statusOnly = applyChatPanelResponse(
    state({ streamingStatus: 'Searching…', streamingText: 'Hel' }),
    { sessionId: 'active', state: 'delta', statusText: 'Reading files…' },
    'active',
  );
  assert.equal(statusOnly.streamingStatus, 'Reading files…');
  assert.equal(statusOnly.streamingText, 'Hel');
});

test('applyChatPanelResponse final payload appends message, cost, and follow-up effects', () => {
  const message = assistantMessage({ usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.25 } });
  const next = applyChatPanelResponse(
    state({ messages: [assistantMessage({ id: 'old' })], sessionCost: 0.5, usageOpen: true }),
    { sessionId: 'active', state: 'final', message },
    'active',
  );

  assert.equal(next.sending, false);
  assert.equal(next.streamingText, '');
  assert.equal(next.messages.length, 2);
  assert.equal(next.sessionCost, 0.75);
  assert.equal(next.shouldLoadUsageContext, true);
  assert.equal(next.shouldLoadSessions, true);
  assert.equal(next.shouldScrollToBottom, true);
});

test('applyChatPanelResponse final payload without message only clears streaming state', () => {
  const messages = [assistantMessage({ id: 'old' })];
  const next = applyChatPanelResponse(
    state({ messages, streamingText: 'partial', streamingStatus: 'Streaming answer...' }),
    { sessionId: 'active', state: 'final' },
    'active',
  );

  assert.equal(next.sending, false);
  assert.equal(next.streamingText, '');
  assert.equal(next.streamingStatus, '');
  assert.equal(next.streamingError, '');
  assert.equal(next.messages, messages);
  assert.equal(next.shouldLoadUsageContext, false);
  assert.equal(next.shouldLoadSessions, false);
  assert.equal(next.shouldScrollToBottom, true);
});

test('applyChatPanelResponse handles aborted and error terminal states', () => {
  const aborted = applyChatPanelResponse(
    state({ streamingText: 'partial', streamingStatus: 'Working…' }),
    { sessionId: 'active', state: 'aborted' },
    'active',
  );
  assert.equal(aborted.sending, false);
  assert.equal(aborted.streamingText, '');
  assert.equal(aborted.streamingStatus, '');

  const errored = applyChatPanelResponse(
    state({ streamingText: 'partial' }),
    { sessionId: 'active', state: 'error', errorMessage: 'boom' },
    'active',
  );
  assert.equal(errored.sending, false);
  assert.equal(errored.streamingStatus, 'Error.');
  assert.equal(errored.streamingError, 'boom');
});
