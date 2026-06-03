import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, ChatSuggestedAction } from '@farmslot/protocol';

import { collectChatActionIds, pruneStaleChatActions } from './chat-panel-action-model.js';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'Ready.',
    createdAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  } as ChatMessage;
}

function action(overrides: Partial<ChatSuggestedAction> = {}): ChatSuggestedAction {
  return {
    type: 'test.action',
    label: 'Action',
    params: {},
    ...overrides,
  };
}

test('collectChatActionIds returns only rendered action ids', () => {
  const ids = collectChatActionIds([
    message({
      suggestedActions: [
        action({ actionId: 'live-1', label: 'Live one' }),
        action({ label: 'Legacy no id' }),
        action({ actionId: 'live-2', label: 'Live two' }),
      ],
    }),
    message({ id: 'plain' }),
  ]);

  assert.deepEqual([...ids], ['live-1', 'live-2']);
});

test('pruneStaleChatActions removes stale ids while preserving legacy and live cards', () => {
  const plain = message({ id: 'plain' });
  const actionable = message({
    id: 'actions',
    suggestedActions: [
      action({ actionId: 'live', label: 'Live' }),
      action({ actionId: 'stale', label: 'Stale' }),
      action({ label: 'Legacy no id' }),
    ],
  });

  const result = pruneStaleChatActions([plain, actionable], new Set(['live']));

  assert.equal(result.pruned, 1);
  assert.equal(result.messages[0], plain);
  assert.deepEqual(
    result.messages[1]?.suggestedActions?.map((action) => action.actionId ?? 'legacy'),
    ['live', 'legacy'],
  );
});

test('pruneStaleChatActions keeps message references when nothing changed', () => {
  const actionable = message({
    suggestedActions: [action({ actionId: 'live', label: 'Live' })],
  });

  const result = pruneStaleChatActions([actionable], new Set(['live']));

  assert.equal(result.pruned, 0);
  assert.equal(result.messages[0], actionable);
});
