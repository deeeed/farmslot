/**
 * Tests for per-PR entity key advancement in list-cache.ts (ADR-071 Amendment 3).
 * Verifies that runRefresh advances per-PR keys and uses advanceMembership for id-set changes.
 *
 * Uses force:true on every load to bypass the on-disk warm cache.
 * Uses relative-value comparisons so the shared resourceRevisions singleton's
 * accumulated membershipRevision counters do not affect test results.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

import { resourceRevisions } from '../../resources/revisions.js';

import { resetPRListCacheForTests, servePRList } from './list-cache.js';
import { prPrKey } from './pr-entity-keys.js';

function makePR(pr: number, repo = 'org/repo', title = `PR ${pr}`): PRStatus {
  return {
    pr,
    repo,
    title,
    summary: null,
    project: 'example',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
    allPassed: false,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: 'REVIEW_REQUIRED',
    recommendation: 'WORKING',
    headRef: null,
  };
}

/** Collect all ResourceChangedPayload packets while fn() runs. */
async function collectChanges(fn: () => Promise<void>): Promise<ResourceChangedPayload[]> {
  return new Promise((resolve, reject) => {
    const packets: ResourceChangedPayload[] = [];
    const unsub = resourceRevisions.subscribe((p) => packets.push(p));
    fn()
      .then(() => {
        unsub();
        resolve(packets);
      })
      .catch((err) => {
        unsub();
        reject(err);
      });
  });
}

/** Highest membershipRevision seen on the upstream COLLECTION key across packets. */
function highestMembershipRevision(packets: ResourceChangedPayload[]): number | undefined {
  let highest: number | undefined;
  for (const p of packets)
    for (const c of p.changes)
      if (c.key.family === 'upstream' && !('prKey' in c.key) && c.membershipRevision !== undefined)
        highest =
          highest === undefined ? c.membershipRevision : Math.max(highest, c.membershipRevision);
  return highest;
}

/** Flush enough microtasks to let deferred revisions.publish() calls fire. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function load(prs: PRStatus[], now = Date.now()): Promise<ResourceChangedPayload[]> {
  return collectChanges(async () => {
    await servePRList(async () => ({ prs, truncated: false }), {
      now,
      force: true,
      legacyInterest: false,
    });
    await flushMicrotasks();
  });
}

test('first load advances membership on collection key', async () => {
  resetPRListCacheForTests();
  const pr1 = makePR(1);
  const packets = await load([pr1]);
  // The post-fetch batch carries the membershipRevision set by advanceMembership.
  const mr = highestMembershipRevision(packets);
  assert.ok(
    mr !== undefined,
    'first load must produce a collection key change with membershipRevision set',
  );
});

test('data-only change does not advance membershipRevision', async () => {
  resetPRListCacheForTests();
  const now = Date.now();
  const pr1 = makePR(1);
  const pr1Updated = { ...pr1, title: 'Updated title' };

  const firstPackets = await load([pr1], now);
  const mrAfterFirstLoad = highestMembershipRevision(firstPackets);
  assert.ok(mrAfterFirstLoad !== undefined, 'first load must set membershipRevision');

  const secondPackets = await load([pr1Updated], now + 70_000);
  const mrAfterDataChange = highestMembershipRevision(secondPackets);
  // Data-only change: membershipRevision must NOT increase.
  // Client uses unchanged value to skip a versions read.
  assert.ok(
    mrAfterDataChange !== undefined,
    'data-only change must carry membershipRevision (client needs stable value to compare)',
  );
  assert.equal(
    mrAfterDataChange,
    mrAfterFirstLoad,
    'data-only change must not increase membershipRevision',
  );

  // Per-PR key for changed PR must be advanced.
  const prKey = prPrKey(pr1Updated);
  const allChanges = secondPackets.flatMap((p) => p.changes);
  const perPRChange = allChanges.find(
    (c) =>
      c.key.family === 'upstream' &&
      'prKey' in c.key &&
      (c.key as { prKey: string }).prKey === prKey,
  );
  assert.ok(perPRChange, `per-PR key ${prKey} must be advanced on data change`);
});

test('added PR advances membership and per-PR key', async () => {
  resetPRListCacheForTests();
  const now = Date.now();
  const pr1 = makePR(1);
  const pr2 = makePR(2);

  const firstPackets = await load([pr1], now);
  const mrBefore = highestMembershipRevision(firstPackets);
  assert.ok(mrBefore !== undefined, 'first load must set membershipRevision');

  const secondPackets = await load([pr1, pr2], now + 70_000);
  const mrAfter = highestMembershipRevision(secondPackets);
  // Adding a PR is a membership change → counter must increase.
  assert.ok(mrAfter !== undefined, 'second load with added PR must carry membershipRevision');
  assert.ok(
    mrAfter > mrBefore,
    `membership must advance when PR added (before=${mrBefore} after=${mrAfter})`,
  );

  const pr2Key = prPrKey(pr2);
  const allChanges = secondPackets.flatMap((p) => p.changes);
  const pr2Change = allChanges.find(
    (c) =>
      c.key.family === 'upstream' &&
      'prKey' in c.key &&
      (c.key as { prKey: string }).prKey === pr2Key,
  );
  assert.ok(pr2Change, 'per-PR key for added PR must be advanced');
});

test('removed PR advances membership and per-PR key as deleted', async () => {
  resetPRListCacheForTests();
  const now = Date.now();
  const pr1 = makePR(1);
  const pr2 = makePR(2);

  const firstPackets = await load([pr1, pr2], now);
  const mrBefore = highestMembershipRevision(firstPackets);
  assert.ok(mrBefore !== undefined, 'first load must set membershipRevision');

  const secondPackets = await load([pr1], now + 70_000);
  const mrAfter = highestMembershipRevision(secondPackets);
  // Removing a PR is a membership change → counter must increase.
  assert.ok(mrAfter !== undefined, 'second load with removed PR must carry membershipRevision');
  assert.ok(
    mrAfter > mrBefore,
    `membership must advance when PR removed (before=${mrBefore} after=${mrAfter})`,
  );

  const pr2Key = prPrKey(pr2);
  const allChanges = secondPackets.flatMap((p) => p.changes);
  const pr2Delete = allChanges.find(
    (c) =>
      c.key.family === 'upstream' &&
      'prKey' in c.key &&
      (c.key as { prKey: string }).prKey === pr2Key &&
      c.kind === 'deleted',
  );
  assert.ok(pr2Delete, 'per-PR key for removed PR must be advanced as deleted');
});
