import assert from 'node:assert/strict';
import test from 'node:test';

import { accountSignOutConfirmation, confirmAccountSignOut } from '../src/account-session.js';

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

test('the sign-out confirmation names the unsaved edits it deletes', () => {
  assert.equal(accountSignOutConfirmation('Command Center').drafts, '');
  assert.equal(
    accountSignOutConfirmation('Command Center', 1).drafts,
    '1 unsaved edit on this device will be deleted.',
  );
  assert.equal(
    accountSignOutConfirmation('Command Center', 3).drafts,
    '3 unsaved edits on this device will be deleted.',
  );
  assert.equal(
    accountSignOutConfirmation('Command Center', 3).message,
    "You'll need your token to sign back in.",
  );
});
