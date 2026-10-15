import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmAccountSignOut } from '../src/account-session.js';

test('only a confirmed sign-out forgets the login', async () => {
  let cleared = 0;
  await confirmAccountSignOut(
    async () => false,
    async () => {
      cleared++;
    },
  );
  assert.equal(cleared, 0);
  await confirmAccountSignOut(
    async () => true,
    async () => {
      cleared++;
    },
  );
  assert.equal(cleared, 1);
});
