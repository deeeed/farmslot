// The served PR list (ADR-071 Amendment 3): one maintained projection answers the full read,
// the versions and ids reads and the pushes of every pr.list scope.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import type { PRStatus } from '@farmslot/protocol';
import type { ResourceChangedPayload } from '@farmslot/protocol/transport/events';

let hashes = 0;
const realHash = await import('../../resources/entity-version-hash.js');
mock.module('../../resources/entity-version-hash.js', {
  namedExports: {
    ...realHash,
    entityVersionHash: (entity: object) => {
      hashes++;
      return realHash.entityVersionHash(entity);
    },
  },
});

// A new CI result reaches the collectors through the raw observation listeners.
const rawListeners: Array<(repo: string, pr: number) => void> = [];
const realRaw = await import('./raw-cache.js');
mock.module('./raw-cache.js', {
  namedExports: {
    ...realRaw,
    onPRRawObservation: (listener: (repo: string, pr: number) => void) => {
      rawListeners.push(listener);
      return realRaw.onPRRawObservation(listener);
    },
  },
});

const { prListResourceKey, resetPRListCacheForTests, servePRList } =
  await import('./list-cache.js');
const { prList } = await import('../pr.js');
const { prListIds, prListVersions } = await import('./pr-entity-sync.js');
const { resetServedPRListsForTests, startServedPRListMaintenance } =
  await import('./served-list.js');
const { resourceRevisions } = await import('../../resources/revisions.js');

function row(n: number, patch: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: n,
    title: `PR ${n}`,
    summary: null,
    repo: 'o/r',
    headRef: null,
    project: 'p',
    slot: null,
    session: null,
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 1, skipped: 0, total: 1 },
    allPassed: false,
    anyFailed: false,
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    prState: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    mergeConflict: false,
    reviewDecision: '',
    recommendation: 'WORKING',
    ...patch,
  };
}

const interest = { legacyInterest: false };

// Collectors keep a warm copy on disk: every test starts from an empty farm of its own.
const farm = mkdtempSync(path.join(tmpdir(), 'served-pr-list-'));
const previousFarm = process.env.FARMSLOT_DIR;
process.env.FARMSLOT_DIR = farm;
after(() => {
  if (previousFarm === undefined) delete process.env.FARMSLOT_DIR;
  else process.env.FARMSLOT_DIR = previousFarm;
  rmSync(farm, { recursive: true, force: true });
});

function coldGateway(): void {
  resetPRListCacheForTests();
  resetServedPRListsForTests();
  rmSync(path.join(farm, '.farm-cache'), { recursive: true, force: true });
}

/** A collector whose GitHub fetch returns `rows`, projected with the current CI pass count. */
function scope(rows: PRStatus[]) {
  const ci = { passed: 3 };
  const deps = {
    fetchList: async () => ({ prs: rows, truncated: false, failed: [] }),
    projectRows: async (stored: readonly PRStatus[]) => ({
      prs: stored.map((entry) => ({
        ...entry,
        checkSummary: { ...entry.checkSummary, passed: ci.passed },
      })),
      truncated: false,
      failed: [],
    }),
  };
  return { ci, deps };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function published(
  run: () => Promise<void> | void,
): Promise<ResourceChangedPayload['changes']> {
  const changes: ResourceChangedPayload['changes'] = [];
  const stop = resourceRevisions.subscribe((payload) => changes.push(...payload.changes));
  try {
    await run();
    await settle();
  } finally {
    stop();
  }
  return changes;
}

test('finding 6: a versions read of a cold project scope starts its collector', async () => {
  coldGateway();
  const { deps } = scope([row(1)]);
  const reply = await prListVersions('p', interest, deps).catch((error: Error) =>
    assert.fail(`the cold versions read failed: ${error.message}`),
  );
  assert.deepEqual(
    reply.versions.map((entry) => entry.id),
    ['o/r/1'],
  );
});

test('finding 7: entity reads and pushes serve the full read projection', async () => {
  coldGateway();
  const { ci, deps } = scope([row(1), row(2)]);
  const full = await prList({ project: 'p' }, deps.fetchList, interest, deps.projectRows);
  const listing = await prListVersions('p', interest, deps);
  assert.deepEqual(
    listing.versions,
    full.prs.map((entry) => ({
      id: `${entry.repo}/${entry.pr}`,
      version: realHash.entityVersionHash(entry),
    })),
    'versions are those of the projected rows',
  );

  ci.passed = 5;
  const changes = await published(() => {
    for (const listener of rawListeners) listener('o/r', 1);
  });
  const pushed = changes.filter(
    (change) =>
      change.key.family === 'upstream' && 'prKey' in change.key && change.key.prKey === 'o/r/1',
  );
  assert.equal(pushed.length, 1, 'the CI result is pushed for that PR');
  const entity = pushed[0].changedEntity;
  assert.equal(entity?.family === 'upstream' ? entity.entity?.checkSummary.passed : undefined, 5);
  const page = await prListIds('p', ['o/r/1'], interest, deps);
  assert.equal(page.entities[0].checkSummary.passed, 5, 'ids reads serve the same projection');
});

test('a full read is not told to read again by the list it just projected', async () => {
  coldGateway();
  const { ci, deps } = scope([row(1)]);
  await prListVersions('p', interest, deps);
  await settle();
  const key = prListResourceKey('p');
  const before = resourceRevisions.revision(key);

  // A local input moved since the served list was computed.
  ci.passed = 9;
  const full = await prList({ project: 'p' }, deps.fetchList, interest, deps.projectRows);
  await settle();
  assert.equal(full.prs[0].checkSummary.passed, 9, 'the full read projects on every read');
  assert.equal(resourceRevisions.revision(key), before, 'and advances no list key');
});

test('finding 7: a local input change recomputes an observed scope at the view reread floor', async (t) => {
  coldGateway();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  t.after(startServedPRListMaintenance());
  t.after(resetServedPRListsForTests);
  const { ci, deps } = scope([row(1)]);
  // A reader without observer admission keeps the scope observed.
  await prListVersions('p', { legacyClientId: 'viewer' }, deps);
  await settle();
  const changes: ResourceChangedPayload['changes'] = [];
  t.after(resourceRevisions.subscribe((payload) => changes.push(...payload.changes)));
  const pushedRows = () => changes.filter((change) => 'prKey' in change.key).length;

  // Runs move PRs between slots several times a second; the view rereads them every 30 s.
  ci.passed = 6;
  resourceRevisions.advance({ family: 'runs', scope: 'farm' });
  await settle();
  t.mock.timers.tick(29_000);
  await settle();
  assert.equal(pushedRows(), 0, 'a run change waits for the floor the view rereads runs at');
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(pushedRows(), 1, 'then the list is recomputed');

  // Project configuration is read at once.
  ci.passed = 7;
  resourceRevisions.advance({ family: 'configuration', scope: 'farm' });
  await settle();
  t.mock.timers.tick(1);
  await settle();
  assert.equal(pushedRows(), 2, 'a configuration change recomputes the list at once');
  const page = await prListIds('p', ['o/r/1'], interest, deps);
  assert.equal(page.entities[0].checkSummary.passed, 7);
});

test('finding 8: refresh start, failure and recovery reach entity-sync clients', async () => {
  coldGateway();
  const { deps } = scope([row(1)]);
  await prListVersions('p', interest, deps);
  const key = prListResourceKey('p');
  const before = resourceRevisions.membershipRevision(key);

  await assert.rejects(
    servePRList(
      async () => {
        throw new Error('GitHub refused');
      },
      { project: 'p', force: true, legacyInterest: false },
    ),
    /GitHub refused/,
  );
  await settle();
  assert.ok(resourceRevisions.membershipRevision(key) > before, 'the failure advances the marker');
  const failed = await prListVersions('p', interest, deps);
  assert.equal(failed.observation?.error?.message, 'GitHub refused');
  assert.equal(failed.membershipRevision, resourceRevisions.membershipRevision(key));

  const afterFailure = resourceRevisions.membershipRevision(key);
  await servePRList(deps.fetchList, { project: 'p', force: true, legacyInterest: false });
  await settle();
  assert.ok(resourceRevisions.membershipRevision(key) > afterFailure, 'recovery advances it too');
  const recovered = await prListVersions('p', interest, deps);
  assert.equal(recovered.observation?.error, undefined);
});

test('finding 21: versions and ids reads hash nothing', async () => {
  coldGateway();
  const { deps } = scope([row(1), row(2), row(3)]);
  await prListVersions('p', interest, deps);
  hashes = 0;
  const listing = await prListVersions('p', interest, deps);
  const page = await prListIds('p', ['o/r/1', 'o/r/2', 'o/r/3'], interest, deps);
  assert.equal(listing.versions.length, 3);
  assert.equal(page.entities.length, 3);
  assert.equal(hashes, 0, 'reads look versions up');
});

test('finding 23: an ids page is bounded by UTF-8 bytes, not string length', async () => {
  coldGateway();
  // Each row is ~2.1 MB of UTF-8 but only ~700 K characters.
  const wide = '€'.repeat(700_000);
  const { deps } = scope([row(1, { title: wide }), row(2, { title: wide })]);
  const page = await prListIds('p', ['o/r/1', 'o/r/2'], interest, deps);
  assert.deepEqual(
    page.entities.map((entry) => entry.pr),
    [1],
    'the second row waits for the next page',
  );
});
