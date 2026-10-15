import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_SESSION_POLICY,
  accountSessionCaption,
  confirmAccountSignOut,
  RememberedAccountSession,
} from '../src/account-session.js';

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

test('successful use starts 30 days, survives reload and only slides in the final 7 days', async () => {
  let now = 1_800_000_000_000;
  let saved: number | null = null;
  let writes = 0;
  const save = (value: number | null) => {
    saved = value;
    writes++;
  };
  const session = new RememberedAccountSession(null, save, () => now);
  await session.recordSuccessfulUse();
  const first = now + ACCOUNT_SESSION_POLICY.durationMs;
  assert.equal(saved, first);
  assert.match(accountSessionCaption(saved, now), /^Signed in until /);
  now += 86_400_000;
  const reloaded = new RememberedAccountSession(saved, save, () => now);
  reloaded.assertCurrent();
  await reloaded.recordSuccessfulUse();
  assert.equal(writes, 1);
  now = first - ACCOUNT_SESSION_POLICY.renewWithinMs;
  await reloaded.recordSuccessfulUse();
  assert.equal(saved, now + ACCOUNT_SESSION_POLICY.durationMs);
  assert.equal(writes, 2);
});

test('expiry demands a new login and cannot be renewed by reconnect or another successful reply', async () => {
  const expires = 1_800_000_000_000;
  let writes = 0;
  const session = new RememberedAccountSession(
    expires,
    () => {
      writes++;
    },
    () => expires,
  );
  assert.throws(() => session.assertCurrent(), /expired/);
  await assert.rejects(session.recordSuccessfulUse(), /expired/);
  assert.equal(writes, 0);
});

test('confirmed sign-out waits for a pending renewal and clears its persisted expiry last', async () => {
  let finish!: () => void;
  const saved: Array<number | null> = [];
  const session = new RememberedAccountSession(null, async (expiry) => {
    if (expiry !== null)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    saved.push(expiry);
  });
  const use = session.recordSuccessfulUse();
  const clear = session.clear();
  finish();
  await Promise.all([use, clear]);
  assert.equal(saved.at(-1), null);
  assert.throws(() => session.assertCurrent(), /expired/);
});
