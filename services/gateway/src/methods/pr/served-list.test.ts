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
const { resetServedPRListsForTests } = await import('./served-list.js');
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

test('N4: an entity read after a local input change equals the full read', async () => {
  coldGateway();
  const { ci, deps } = scope([row(1), row(2)]);
  await prListVersions('p', interest, deps);
  await settle();

  // A run moved: the same collected rows project differently, and no collector changed.
  ci.passed = 8;
  const full = await prList({ project: 'p' }, deps.fetchList, interest, deps.projectRows);
  let listing: Awaited<ReturnType<typeof prListVersions>> | undefined;
  const changes = await published(async () => {
    listing = await prListVersions('p', interest, deps);
  });
  assert.deepEqual(
    listing?.versions,
    full.prs.map((entry) => ({
      id: `${entry.repo}/${entry.pr}`,
      version: realHash.entityVersionHash(entry),
    })),
    'the listing is that of the rows the full read serves now',
  );
  const page = await prListIds('p', ['o/r/1', 'o/r/2'], interest, deps);
  assert.deepEqual(page.entities, full.prs, 'and the ids read serves those rows');
  assert.equal(
    changes.filter((change) => 'prKey' in change.key).length,
    2,
    'the rows that changed are pushed to the other clients',
  );
});

test('N7: the observations of one list refresh project another scope once, when it ends', async () => {
  coldGateway();
  const rows = [row(1), row(2), row(3), row(4)];
  let projectedScopes: Array<string | undefined> = [];
  const deps = {
    fetchList: async () => ({ prs: rows, truncated: false, failed: [] }),
    projectRows: async (stored: readonly PRStatus[], project?: string) => {
      projectedScopes.push(project);
      return { prs: [...stored], truncated: false, failed: [] };
    },
  };
  await prListVersions(undefined, interest, deps);
  await prListVersions('p', interest, deps);
  await settle();

  // The farm scope refreshes: GitHub answers for its PRs one at a time.
  let finish = (_value: { prs: PRStatus[]; truncated: boolean }) => {};
  const refresh = servePRList(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { force: true, legacyInterest: false },
  );
  await settle();
  projectedScopes = [];
  for (const observed of rows) {
    for (const listener of rawListeners) listener(observed.repo, observed.pr);
    await settle();
  }
  assert.deepEqual(projectedScopes, [], 'no projection per observation while the refresh runs');

  finish({ prs: rows, truncated: false });
  await refresh;
  await settle();
  assert.deepEqual(
    projectedScopes.filter((scope) => scope === 'p'),
    ['p'],
    'the other scope is projected once for the whole refresh',
  );
});

test('R1: a versions reply carries the marker of the rows and fields it carries', async () => {
  coldGateway();
  let held: Promise<void> | undefined;
  let release = () => {};
  const deps = {
    fetchList: async () => ({ prs: [row(1)], truncated: false, failed: [] }),
    // The projection behind the held one settles at once, before the held read resumes.
    projectRows: (stored: readonly PRStatus[]) => {
      const projected = { prs: [...stored], truncated: false, failed: [] };
      return held ? held.then(() => projected) : Promise.resolve(projected);
    },
  };
  await prListVersions('p', interest, deps);
  await settle();

  // A versions read projects the scope and waits in its projector.
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = prListVersions('p', interest, deps);
  await settle();
  // Meanwhile a refresh fails: newer fields and a newer marker, projected right behind.
  held = undefined;
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
  release();
  const reply = await reading;
  await settle();

  const latest = await prListVersions('p', interest, deps);
  assert.equal(latest.observation?.error?.message, 'GitHub refused');
  assert.equal(reply.observation?.error, undefined, 'the held read answers from its own snapshot');
  assert.ok(
    reply.membershipRevision < latest.membershipRevision,
    `an older snapshot keeps its own marker (got ${reply.membershipRevision}, latest ${latest.membershipRevision})`,
  );
});

test('R4: one PR observed outside a list refresh projects and hashes that row only', async () => {
  coldGateway();
  const rows = Array.from({ length: 100 }, (_, index) => row(index + 1));
  let listProjections = 0;
  const deps = {
    fetchList: async () => ({ prs: rows, truncated: false, failed: [] }),
    projectRows: async (stored: readonly PRStatus[]) => {
      listProjections++;
      return { prs: [...stored], truncated: false, failed: [] };
    },
    // The observed PR's newer CI result, with the placement the list projection gave the row.
    projectRow: async (served: PRStatus) => ({
      ...served,
      checkSummary: { ...served.checkSummary, passed: 7 },
    }),
  };
  const before = await prListVersions(undefined, interest, deps);
  await settle();
  hashes = 0;
  listProjections = 0;

  const changes = await published(() => {
    for (const listener of rawListeners) listener('o/r', 42);
  });
  assert.equal(hashes, 1, 'one row is hashed');
  assert.equal(listProjections, 0, 'the scope is not projected again');
  const pushed = changes.filter((change) => 'prKey' in change.key);
  assert.deepEqual(
    pushed.map((change) => ('prKey' in change.key ? change.key.prKey : undefined)),
    ['o/r/42'],
  );
  const entity = pushed[0].changedEntity;
  assert.equal(entity?.family === 'upstream' ? entity.entity?.checkSummary.passed : undefined, 7);
  const page = await prListIds(undefined, ['o/r/41', 'o/r/42'], interest, deps);
  assert.deepEqual(
    page.entities.map((entry) => entry.checkSummary.passed),
    [0, 7],
    'ids reads serve the updated row beside the untouched ones',
  );
  assert.equal(
    resourceRevisions.membershipRevision(prListResourceKey(undefined)),
    before.membershipRevision,
    'the listing did not change',
  );
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

test('finding 21: a versions read hashes each row once as it projects; an ids read hashes nothing', async () => {
  coldGateway();
  const { deps } = scope([row(1), row(2), row(3)]);
  await prListVersions('p', interest, deps);
  hashes = 0;
  const listing = await prListVersions('p', interest, deps);
  assert.equal(listing.versions.length, 3);
  assert.equal(hashes, 3, 'one projection, as the full read projects on every read');
  hashes = 0;
  const page = await prListIds('p', ['o/r/1', 'o/r/2', 'o/r/3'], interest, deps);
  assert.equal(page.entities.length, 3);
  assert.equal(hashes, 0, 'ids reads look versions up');
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
