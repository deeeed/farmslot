import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Methods, type PRStatus } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import {
  forgetPRListClientInterest,
  PR_LIST_CLIENT_INTEREST_MS,
  PR_LIST_STALE_MS,
  resetPRListCacheForTests,
  servePRList,
  startPRListRefresher,
} from '../methods/pr/list-cache.js';

import { GatewayUpstreamObservers, type ResourceObserverAuthority } from './upstream-observers.js';

function actor() {
  let active = true;
  let allowed = true;
  const refusals: unknown[] = [];
  const authority: ResourceObserverAuthority = {
    isActive: () => active,
    assertRead: () => {
      if (!allowed) throw new GatewayMethodError('AUTH_FORBIDDEN', 'Read permission revoked');
    },
    refuse: (error) => refusals.push(error),
  };
  return {
    client: {},
    authority,
    refusals,
    pause: () => {
      active = false;
    },
    revoke: () => {
      allowed = false;
    },
  };
}

const replacement = (sequence: number, queries: unknown[] = [{ method: Methods.PR_LIST }]) => ({
  version: 1,
  sequence,
  queries,
});

test('adopting gateway updates does not retire legacy PR readers and hidden methods stay adopted', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  observers
    .prepareReplacement(
      one.client,
      replacement(1, [{ method: Methods.GATEWAY_STATUS }]),
      one.authority,
    )
    .commit();
  assert.equal(observers.manages(one.client, Methods.GATEWAY_STATUS), true);
  assert.equal(observers.manages(one.client, Methods.PR_LIST), false);
  observers.prepareReplacement(one.client, replacement(2), one.authority).commit();
  assert.equal(observers.manages(one.client, Methods.PR_LIST), true);
  observers.prepareReplacement(one.client, replacement(3, []), one.authority).commit();
  assert.equal(observers.manages(one.client, Methods.PR_LIST), true);
  assert.equal(observers.manages(one.client, Methods.GATEWAY_STATUS), true);
  assert.equal(observers.hasInterest(Methods.PR_LIST), false);
  assert.equal(observers.hasInterest(Methods.GATEWAY_STATUS), false);
  observers.disconnect(one.client);
  assert.equal(observers.manages(one.client, Methods.PR_LIST), false);
});

test('first/last membership and socket cleanup do not require interest renewals', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  const two = actor();
  for (const current of [one, two]) {
    const admission = observers.prepareReplacement(
      current.client,
      replacement(1),
      current.authority,
    );
    assert.equal(admission.commit().applied, true);
  }
  assert.equal(observers.hasInterest(Methods.PR_LIST), true);
  observers.prepareReplacement(one.client, replacement(2, []), one.authority).commit();
  assert.equal(
    observers.manages(one.client),
    true,
    'Empty foreground state still identifies a migrated client',
  );
  assert.equal(observers.hasInterest(Methods.PR_LIST), true);
  observers.disconnect(two.client);
  assert.equal(observers.hasInterest(Methods.PR_LIST), false);
});

test('a late add cannot undo a newer removal or a disconnect', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  const old = observers.prepareReplacement(one.client, replacement(1), one.authority);
  observers.prepareReplacement(one.client, replacement(2, []), one.authority).commit();
  assert.equal(old.commit().applied, false);
  assert.equal(observers.hasInterest(Methods.PR_LIST), false);
  const disconnected = observers.prepareReplacement(one.client, replacement(3), one.authority);
  observers.disconnect(one.client);
  assert.equal(disconnected.commit().applied, false);
});

test('a delayed removal cannot undo a newer add, including re-entrant admission', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  const remove = observers.prepareReplacement(one.client, replacement(1, []), one.authority);
  observers.prepareReplacement(one.client, replacement(2), one.authority).commit();
  assert.equal(remove.commit().applied, false);
  assert.equal(observers.hasInterest(Methods.PR_LIST), true);
  const authority = {
    ...one.authority,
    assertRead: () => {
      observers.prepareReplacement(one.client, replacement(4, []), one.authority).commit();
    },
  };
  const reentrant = observers.prepareReplacement(one.client, replacement(3), authority);
  assert.equal(reentrant.commit().applied, false);
  assert.equal(observers.hasInterest(Methods.PR_LIST), false);
});

test('collector admission rechecks authority and closes only a revoked observer', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  const two = actor();
  for (const current of [one, two])
    observers.prepareReplacement(current.client, replacement(1), current.authority).commit();
  one.revoke();
  assert.equal(observers.hasInterest(Methods.PR_LIST), true);
  assert.equal(one.refusals.length, 1);
  assert.equal(two.refusals.length, 0);
  two.pause();
  assert.equal(observers.hasInterest(Methods.PR_LIST), false);
});

test('replacements reject unregistered selectors and bound their per-connection size', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  for (const value of [
    replacement(1, [{ method: 'pr.addComment' }]),
    replacement(1, [{ method: Methods.PR_LIST, ownerId: 'foreign' }]),
    replacement(
      1,
      Array.from({ length: 129 }, () => ({ method: Methods.PR_LIST })),
    ),
    { ...replacement(1), ownerId: 'foreign' },
  ])
    assert.throws(() => observers.prepareReplacement(one.client, value, one.authority));
  observers.prepareReplacement(one.client, replacement(1), one.authority).commit();
  assert.throws(
    () => observers.prepareReplacement(one.client, replacement(1), one.authority),
    (error: unknown) =>
      error instanceof GatewayMethodError && error.code === 'STALE_OBSERVER_REPLACEMENT',
  );
});

test('the existing collector survives legacy expiry with observers and stops after their removal', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'upstream-observer-interest-'));
  const previous = process.env.FARMSLOT_DIR;
  process.env.FARMSLOT_DIR = directory;
  resetPRListCacheForTests();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  let observed = false;
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { prs: [{ repo: 'owner/repo', pr: 1 } as PRStatus], truncated: false };
  };
  let stop: (() => void) | undefined;
  try {
    await servePRList(fetch, { now: Date.now() - PR_LIST_CLIENT_INTEREST_MS - 1 });
    stop = startPRListRefresher(fetch, {
      broadcast: () => {},
      hasClients: () => true,
      hasObservers: () => observed,
      initialDelayMs: 1,
    });
    t.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'Legacy interest expired');
    observed = true;
    t.mock.timers.tick(PR_LIST_STALE_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'Observer lifetime does not expire without panel reads');
    observed = false;
    t.mock.timers.tick(PR_LIST_CLIENT_INTEREST_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'No observers and no legacy interest means no passive collection');
  } finally {
    stop?.();
    resetPRListCacheForTests();
    if (previous === undefined) delete process.env.FARMSLOT_DIR;
    else process.env.FARMSLOT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrated reads and removed legacy clients cannot keep passive collection alive', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'upstream-observer-legacy-'));
  const previous = process.env.FARMSLOT_DIR;
  process.env.FARMSLOT_DIR = directory;
  resetPRListCacheForTests();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { prs: [] as PRStatus[], truncated: false };
  };
  let stop: (() => void) | undefined;
  try {
    await servePRList(fetch, { legacyClientId: 'adopting-client' });
    forgetPRListClientInterest('adopting-client');
    await servePRList(fetch, { legacyInterest: false });
    stop = startPRListRefresher(fetch, {
      broadcast: () => {},
      hasClients: () => true,
      hasObservers: () => false,
    });
    t.mock.timers.tick(PR_LIST_STALE_MS * 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'The migrated client did not accidentally renew legacy interest');
  } finally {
    stop?.();
    resetPRListCacheForTests();
    if (previous === undefined) delete process.env.FARMSLOT_DIR;
    else process.env.FARMSLOT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed passive reads respect sixty seconds while explicit force retains its bypass', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'upstream-observer-cooldown-'));
  const previous = process.env.FARMSLOT_DIR;
  process.env.FARMSLOT_DIR = directory;
  resetPRListCacheForTests();
  let calls = 0;
  let failed = true;
  const fetch = async () => {
    calls++;
    if (failed) throw new Error('Expected upstream outage');
    return { prs: [] as PRStatus[], truncated: false };
  };
  try {
    await assert.rejects(servePRList(fetch, { now: 1_000 }), /Expected upstream outage/);
    await assert.rejects(servePRList(fetch, { now: 1_001 }), /Expected upstream outage/);
    assert.equal(calls, 1, 'Another passive reader cannot accelerate the failed collector');
    failed = false;
    const forced = await servePRList(fetch, { now: 1_002, force: true });
    assert.equal(calls, 2, 'Explicit force still reaches the shared fetcher immediately');
    assert.deepEqual(forced.prs, []);
  } finally {
    resetPRListCacheForTests();
    if (previous === undefined) delete process.env.FARMSLOT_DIR;
    else process.env.FARMSLOT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('query-specific membership wakes existing collector owners only when the committed set changes', () => {
  const observers = new GatewayUpstreamObservers();
  const one = actor();
  let notices = 0;
  const stop = observers.subscribe(() => {
    notices++;
  });
  observers
    .prepareReplacement(
      one.client,
      replacement(1, [{ method: Methods.PR_LIST, params: { project: 'a' } }]),
      one.authority,
    )
    .commit();
  assert.equal(notices, 1);
  assert.equal(observers.hasInterest(Methods.PR_LIST, { project: 'a' }), true);
  assert.equal(observers.hasInterest(Methods.PR_LIST, { project: 'b' }), false);
  assert.equal(
    observers.hasInterest(Methods.PR_LIST, {}),
    false,
    'A project viewer does not admit the farm collector',
  );
  observers
    .prepareReplacement(
      one.client,
      replacement(2, [{ method: Methods.PR_LIST, params: { force: false, project: 'a' } }]),
      one.authority,
    )
    .commit();
  assert.equal(notices, 1, 'Equivalent normalized selectors need no extra wake');
  const late = observers.prepareReplacement(one.client, replacement(3, []), one.authority);
  observers
    .prepareReplacement(
      one.client,
      replacement(4, [{ method: Methods.PR_LIST, params: { project: 'b' } }]),
      one.authority,
    )
    .commit();
  assert.equal(notices, 2);
  assert.equal(late.commit().applied, false);
  assert.equal(notices, 2, 'A fenced replacement cannot wake a collector for obsolete membership');
  one.revoke();
  assert.equal(observers.hasInterest(Methods.PR_LIST), false);
  assert.equal(notices, 3, 'Revocation releases the last query membership');
  stop();
  observers.disconnect(one.client);
  assert.equal(notices, 3);
});
