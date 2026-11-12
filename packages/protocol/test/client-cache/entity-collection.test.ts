/**
 * Tests for EntityCollection (ADR-071 Amendment 3).
 *
 * Item 2 (stale page fix):
 *   A page response that arrives after a push must not regress the row's version.
 *   Scenario: fetchVersions returns a:v1; push delivers a@v2; fetchPage returns a@v1 — stale.
 *   The fix skips the page write when the row is already at the currently-listed version.
 *   Revert proof: comment out the `currentRow.version === currentListedVersion` guard
 *   in entity-collection.ts → 'stale page must not overwrite fresher push' fails.
 *
 * Item 7a (offline hydration):
 *   Rows applied before a versions read (e.g. from cold-start offline storage) are
 *   replaced when the refresh returns a different version for the same id.
 *   Rows whose id is absent from the versions response are pruned.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EntitySyncPage,
  EntityVersionEntry,
} from '../../src/client-cache/entity-collection.js';
import { EntityCollection } from '../../src/client-cache/entity-collection.js';

interface TestEntity {
  id: string;
  value: string;
}

// ── Item 2: stale page must not overwrite fresher push ──────────────────────

test('stale page must not overwrite fresher push (item 2)', async () => {
  // Interleaving:
  //   1. fetchVersions → {a:v1}  (this.listed = {a:v1}, toFetch = ['a'])
  //   2. push → applyEntity(a, entity_v2, v2)  (this.listed updated to {a:v2}, rows[a]=v2)
  //   3. fetchPage(['a']) → {entity_v1, version:v1}  (stale — must be ignored)
  //
  // The fix checks: currentRow.version === this.listed.get(id) → v2===v2 → skip page write.

  const entity_v1: TestEntity = { id: 'a', value: 'old' };
  const entity_v2: TestEntity = { id: 'a', value: 'new' };

  // Gate on fetchPage so we can inject the push between fetchVersions and page response.
  let releasePage: ((p: EntitySyncPage<TestEntity>) => void) | undefined;
  const pageFetchGate = new Promise<EntitySyncPage<TestEntity>>((r) => {
    releasePage = r;
  });

  const col = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: (a, b) => a.id.localeCompare(b.id),
    fetchVersions: async () => ({ versions: [{ id: 'a', version: 'v1' }] }),
    fetchPage: async () => pageFetchGate,
  });

  // Start refresh — fetchVersions resolves immediately; fetchPage awaits the gate.
  const refreshPromise = col.refresh();

  // Drain microtasks so refresh has processed fetchVersions and set this.listed = {a:v1}.
  await new Promise<void>((r) => setImmediate(r));

  // Push arrives — applyEntity updates this.listed[a]=v2 and rows[a]={entity_v2,v2}.
  col.applyEntity('a', entity_v2, 'v2');

  // Release the page gate with stale data (a@v1).
  releasePage!({
    entities: [entity_v1],
    versions: [{ id: 'a', version: 'v1' }],
  });
  await refreshPromise;

  const rows = col.assemble();
  assert.ok(rows, 'collection has rows after refresh');
  const row = rows.find((e) => e.id === 'a');
  assert.ok(row, 'row for a must be present');
  assert.equal(
    row.value,
    'new',
    // Revert proof: comment out the stale-page guard in entity-collection.ts.
    // Failing assertion: row.value = 'old' instead of 'new'.
    'stale page must not overwrite fresher push: row must keep the pushed (newer) value',
  );
});

// ── Item 7a: offline hydration ──────────────────────────────────────────────

test('offline hydration: rows with outdated version replaced by refresh', async () => {
  // Cold-start: a stale row is loaded from offline storage via applyEntity.
  // When refresh runs, the server returns a newer version; the row is re-fetched.
  const stale: TestEntity = { id: 'b', value: 'stale' };
  const fresh: TestEntity = { id: 'b', value: 'fresh' };

  let servedVersions: EntityVersionEntry[] = [{ id: 'b', version: 'new-version' }];
  let servedPage: EntitySyncPage<TestEntity> = {
    entities: [fresh],
    versions: [{ id: 'b', version: 'new-version' }],
  };

  const col = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: (a, b) => a.id.localeCompare(b.id),
    fetchVersions: async () => ({ versions: servedVersions }),
    fetchPage: async (ids) => ({
      entities: servedPage.entities.filter((e) => ids.includes(e.id)),
      versions: servedPage.versions.filter((v) => ids.includes(v.id)),
    }),
  });

  // Apply stale row (simulates cold-start from offline storage).
  col.applyEntity('b', stale, 'old-version');

  await col.refresh();

  const rows = col.assemble();
  assert.ok(rows, 'collection has rows after refresh');
  const row = rows.find((e) => e.id === 'b');
  assert.ok(row, 'row for b must be present');
  assert.equal(
    row.value,
    'fresh',
    'outdated offline row must be replaced by refresh with the server-current version',
  );
});

test('offline hydration: row absent from versions response is pruned', async () => {
  // If a stored row is absent from the new versions listing (entity no longer exists
  // server-side), the EntityCollection prunes it during the versions read.
  const stale: TestEntity = { id: 'c', value: 'gone' };

  const col = new EntityCollection<TestEntity>({
    idOf: (e) => e.id,
    sort: (a, b) => a.id.localeCompare(b.id),
    fetchVersions: async () => ({ versions: [] }), // c not listed
    fetchPage: async () => ({ entities: [], versions: [] }),
  });

  // Apply stale row from offline storage.
  col.applyEntity('c', stale, 'old-c');

  await col.refresh();

  const rows = col.assemble() ?? [];
  assert.equal(
    rows.find((e) => e.id === 'c'),
    undefined,
    'row removed server-side must be pruned from the collection after refresh',
  );
});
