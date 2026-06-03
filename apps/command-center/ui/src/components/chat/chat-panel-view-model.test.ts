import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatSessionSummary } from '@farmslot/protocol';

import { SHARED_SESSION_ID } from './chat-panel-model.js';
import { chatPanelViewModel } from './chat-panel-view-model.js';

function session(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: 'manual-1',
    title: 'Manual chat',
    scope: 'manual',
    pinned: true,
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:01:00.000Z',
    messageCount: 2,
    ...overrides,
  } as ChatSessionSummary;
}

test('chatPanelViewModel derives streaming and active pin state like the component render path', () => {
  const pinned = session({ id: 'manual-pinned', pinned: true });
  const ephemeral = session({ id: 'manual-ephemeral', pinned: false });

  assert.deepEqual(
    chatPanelViewModel({
      sending: true,
      streamingText: '',
      streamingError: '',
      activeSessionId: ephemeral.id,
      sessionSummaries: [session({ id: SHARED_SESSION_ID }), pinned, ephemeral],
    }),
    {
      isStreaming: true,
      activeSummary: ephemeral,
      activePinned: false,
      canPin: true,
      historySessions: [pinned, ephemeral],
      historyCount: 2,
    },
  );
});

test('chatPanelViewModel keeps shared chat pinned when no summary is loaded', () => {
  const model = chatPanelViewModel({
    sending: false,
    streamingText: '',
    streamingError: 'failed',
    activeSessionId: SHARED_SESSION_ID,
    sessionSummaries: [],
  });

  assert.equal(model.isStreaming, true);
  assert.equal(model.activeSummary, undefined);
  assert.equal(model.activePinned, true);
  assert.equal(model.canPin, false);
  assert.deepEqual(model.historySessions, []);
  assert.equal(model.historyCount, 0);
});
