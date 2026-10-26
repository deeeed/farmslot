import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigGitHubAccountsResult } from '@farmslot/protocol';

import {
  GITHUB_ACCOUNTS_LEGACY_INTEREST_MS,
  GITHUB_ACCOUNTS_TTL_MS,
  GitHubAccountObservation,
} from './github-account-observation.js';

const good = (): ConfigGitHubAccountsResult => ({
  accounts: [{ host: 'github.com', login: 'reader', active: true }],
  checkedAt: 'adapter-start-time-is-not-source-success',
});
const managed = { legacyInterest: false };

test('account readers share a source completion and warm reads never renew it', async () => {
  let now = 1000;
  let complete!: (result: ConfigGitHubAccountsResult) => void;
  let calls = 0;
  const owner = new GitHubAccountObservation({
    now: () => now,
    sample: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    hasInterest: () => true,
    changed: () => {},
  });
  const first = owner.read(false, managed);
  const second = owner.read(false, managed);
  assert.equal(calls, 1);
  now = 2000;
  complete(good());
  assert.deepEqual(await first, await second);
  assert.equal(owner.snapshot().checkedAt, new Date(2000).toISOString());
  now += GITHUB_ACCOUNTS_TTL_MS;
  await owner.read(false, managed);
  assert.equal(calls, 1);
  assert.deepEqual(owner.observation, { status: 'stale', observedAt: 2000 });
});

test('source failure retains identities and their success time through the five-minute cadence', async () => {
  let now = 1000;
  let fail = false;
  let calls = 0;
  const notices: ConfigGitHubAccountsResult[] = [];
  const owner = new GitHubAccountObservation({
    now: () => now,
    sample: async () => {
      calls++;
      return fail
        ? { accounts: [], checkedAt: 'failed', error: 'Cannot verify accounts.' }
        : good();
    },
    hasInterest: () => true,
    changed: () => {
      notices.push(owner.snapshot());
    },
  });
  const first = await owner.read(false, managed);
  fail = true;
  now += GITHUB_ACCOUNTS_TTL_MS - 1;
  await owner.tick();
  assert.equal(calls, 1);
  now++;
  await owner.tick();
  assert.equal(calls, 2);
  const failed = owner.snapshot();
  assert.deepEqual(failed.accounts, first.accounts);
  assert.equal(failed.checkedAt, first.checkedAt);
  assert.equal(failed.observation?.observedAt, 1000);
  assert.equal(failed.observation?.status, 'stale');
  assert.equal(failed.error, 'Cannot verify accounts.');
  now += GITHUB_ACCOUNTS_TTL_MS - 1;
  await owner.tick();
  assert.equal(calls, 2);
  fail = false;
  now++;
  await owner.tick();
  assert.equal(calls, 3);
  assert.equal(owner.snapshot().observation?.observedAt, now);
  assert.equal(owner.snapshot().observation?.status, 'ready');
  assert(notices.some((notice) => notice.error));
});

test('a cold failure has no success time; an observed empty inventory does', async () => {
  let fail = true;
  const owner = new GitHubAccountObservation({
    now: () => 1000,
    sample: async () => ({
      accounts: [],
      checkedAt: 'sample',
      ...(fail ? { error: 'Unavailable' } : {}),
    }),
    hasInterest: () => false,
    changed: () => {},
  });
  await owner.read(false, managed);
  assert.equal(owner.observation.status, 'error');
  assert.equal(owner.observation.observedAt, undefined);
  fail = false;
  await owner.read(true, managed);
  assert.deepEqual(owner.snapshot().accounts, []);
  assert.deepEqual(owner.observation, { status: 'ready', observedAt: 1000 });
});

test('one explicit verification queues behind a pending failure and duplicates join it', async () => {
  const completions: Array<(result: ConfigGitHubAccountsResult) => void> = [];
  let calls = 0;
  const owner = new GitHubAccountObservation({
    now: () => 1000,
    sample: () => {
      calls++;
      return new Promise((resolve) => {
        completions.push(resolve);
      });
    },
    hasInterest: () => false,
    changed: () => {},
  });
  const first = owner.read(false, managed);
  const refresh = owner.read(true, managed);
  const duplicate = owner.read(true, managed);
  completions[0]({ accounts: [], checkedAt: 'failed', error: 'Unavailable' });
  await first;
  assert.equal(calls, 2);
  completions[1](good());
  assert.deepEqual((await refresh).accounts, good().accounts);
  assert.deepEqual(await refresh, await duplicate);
  assert.equal(calls, 2);
});

test('legacy demand is withdrawn on adoption/disconnect and expires without new reads', async () => {
  let now = 1000;
  let calls = 0;
  const owner = new GitHubAccountObservation({
    now: () => now,
    sample: async () => {
      calls++;
      return good();
    },
    hasInterest: () => false,
    changed: () => {},
  });
  await owner.tick();
  assert.equal(calls, 0);
  await owner.read(false, { legacyClientId: 'one' });
  await owner.read(false, { legacyClientId: 'one', legacyInterest: false });
  now += GITHUB_ACCOUNTS_TTL_MS;
  await owner.tick();
  assert.equal(calls, 1);
  await owner.read(false, { legacyClientId: 'two' });
  owner.forget('two');
  now += GITHUB_ACCOUNTS_TTL_MS;
  await owner.tick();
  assert.equal(calls, 2);
  await owner.read(false, { legacyClientId: 'three' });
  now += GITHUB_ACCOUNTS_LEGACY_INTEREST_MS;
  await owner.tick();
  assert.equal(calls, 3);
});

test('stop drains pending work, cancels queued verification and prevents late notices', async () => {
  let complete!: (result: ConfigGitHubAccountsResult) => void;
  let calls = 0;
  let notices = 0;
  const owner = new GitHubAccountObservation({
    now: () => 1000,
    sample: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    hasInterest: () => true,
    changed: () => {
      notices++;
    },
  });
  const first = owner.read(false, managed);
  const queued = owner.read(true, managed);
  let drained = false;
  const stopping = owner.stop().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  complete(good());
  await Promise.all([first, queued, stopping]);
  await owner.tick();
  await owner.read(true, managed);
  assert.equal(calls, 1);
  assert.equal(notices, 0);
});
