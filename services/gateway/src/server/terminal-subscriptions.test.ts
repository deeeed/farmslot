import assert from 'node:assert/strict';
import test from 'node:test';

import type { TerminalSubscriptionState } from './client-state.js';
import {
  adoptWorkerTerminalSubscription,
  terminalUnsubscribeKeysForRequest,
} from './terminal-subscriptions.js';

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
  const state = subscriptionState(['runner-browser-1:review']);
  assert.deepEqual(
    terminalUnsubscribeKeysForRequest(
      state,
      'runner-browser-1',
      'runner-browser-1:review',
      'runner-browser-1:review',
    ),
    ['runner-browser-1:review'],
  );
});

test('terminalUnsubscribeKeysForRequest does not mass-remove current role keys for stale role unsubscribes', () => {
  const state = subscriptionState(['runner-browser-1:ci-fix']);
  assert.deepEqual(
    terminalUnsubscribeKeysForRequest(
      state,
      'runner-browser-1',
      'runner-browser-1:review',
      'runner-browser-1:review',
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

test('late node PTY attachment cannot recreate an unsubscribed or disconnected worker subscription', async () => {
  const state = subscriptionState([]);
  const key = 'fixture:%1';
  const registration = `worker:${key}`;
  state.terminalSubscribeSeq.set(registration, 1);
  let finish!: (handler: (data: string) => void) => void;
  const attaching = new Promise<(data: string) => void>((resolve) => {
    finish = resolve;
  });
  const complete = attaching.then((handler) =>
    adoptWorkerTerminalSubscription(state, key, 1, handler, true),
  );
  // Unsubscribe arrives before the node confirms its attachment.
  state.terminalSubscribeSeq.set(registration, 2);
  finish(() => undefined);
  assert.equal(await complete, false);
  assert.equal(state.workerTerminalHandlers.size, 0);
  assert.equal(
    adoptWorkerTerminalSubscription(state, key, 2, () => undefined, false),
    false,
  );
  assert.equal(state.workerTerminalHandlers.size, 0);
  const current = () => undefined;
  assert.equal(adoptWorkerTerminalSubscription(state, key, 2, current, true), true);
  assert.equal(state.workerTerminalHandlers.get(key), current);
});
