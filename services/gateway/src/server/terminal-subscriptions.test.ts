import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalSubscriptionState } from './client-state.js';
import { terminalUnsubscribeKeysForRequest } from './terminal-subscriptions.js';

function subscriptionState(keys: string[]): TerminalSubscriptionState {
  return {
    terminalHandlers: new Map(keys.map((key) => [key, () => undefined])),
    workerTerminalHandlers: new Map(),
    ptyHandlers: new Map(),
    terminalIdentities: new Map(),
    workerSessionHistoryHandlers: new Map(),
    workerSessionHistorySubscribeSeq: new Map(),
    terminalSubscribeSeq: new Map(),
  };
}

test('terminalUnsubscribeKeysForRequest removes only the exact role key', () => {
  const state = subscriptionState(['runner-browser-1:self-review']);
  assert.deepEqual(
    terminalUnsubscribeKeysForRequest(
      state,
      'runner-browser-1',
      'runner-browser-1:self-review',
      'runner-browser-1:self-review',
    ),
    ['runner-browser-1:self-review'],
  );
});

test('terminalUnsubscribeKeysForRequest does not mass-remove current role keys for stale role unsubscribes', () => {
  const state = subscriptionState(['runner-browser-1:ci-fix']);
  assert.deepEqual(
    terminalUnsubscribeKeysForRequest(
      state,
      'runner-browser-1',
      'runner-browser-1:self-review',
      'runner-browser-1:self-review',
    ),
    [],
  );
});

test('terminalUnsubscribeKeysForRequest preserves legacy slot-key unsubscribe', () => {
  const state = subscriptionState(['runner-browser-1']);
  assert.deepEqual(
    terminalUnsubscribeKeysForRequest(
      state,
      'runner-browser-1',
      'runner-browser-1:review',
      'runner-browser-1',
    ),
    ['runner-browser-1'],
  );
});
