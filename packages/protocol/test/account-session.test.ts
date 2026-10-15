import assert from 'node:assert/strict';
import test from 'node:test';

import { signOutAccount } from '../src/surfaces/account-session.js';

test('sign-out closes the session only after durable forgetting succeeds', async () => {
  const events: string[] = [];
  let persist!: () => void;
  const done = signOutAccount({
    forgetLogin: () =>
      new Promise<void>((resolve) => {
        persist = resolve;
      }),
    closeSession: () => {
      events.push('closed');
    },
  });
  assert.deepEqual(events, []);
  persist();
  await done;
  assert.deepEqual(events, ['closed']);
  await assert.rejects(
    signOutAccount({
      forgetLogin: async () => {
        throw new Error('Secure storage unavailable');
      },
      closeSession: () => {
        events.push('unexpected');
      },
    }),
    /Secure storage unavailable/,
  );
  assert.deepEqual(events, ['closed']);
});
