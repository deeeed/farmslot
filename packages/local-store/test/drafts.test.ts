import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { resourceStoreScopeId } from '@farmslot/protocol/client-cache';

import {
  createDraftStore,
  createMemoryDraftStorage,
  DRAFT_RETENTION_MS,
  type DraftInput,
} from '../src/drafts.js';
import {
  createSqliteResourceStore,
  RESOURCE_STORE_SCHEMA_VERSION,
  type ResourceSqliteDatabase,
  type SqliteValue,
} from '../src/sqlite-store.js';

const scope = {
  gatewayUrl: 'ws://drafts.invalid/',
  profileId: 'profile',
  principalId: 'user',
  principalGeneration: 3,
};
const scopeId = resourceStoreScopeId(scope);

function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    scopeId,
    slotId: 'slot-a',
    runId: 'run-1',
    path: 'src/app.ts',
    baseContent: 'base\n',
    baseHash: 'base-hash',
    editedContent: 'edited\n',
    state: 'current',
    ...overrides,
  };
}

test('a draft keeps its store key fields, slot, run, path, base and edits', async () => {
  let time = 100;
  const drafts = createDraftStore(createMemoryDraftStorage(), () => time);
  const saved = await drafts.put(draft());
  const noRun = await drafts.put(draft({ runId: null, baseHash: null, baseContent: '' }));
  await drafts.put(draft({ slotId: 'slot-b' }));
  assert.deepEqual(saved, { ...draft(), updatedAt: 100, stateEnteredAt: 100 });
  assert.deepEqual(await drafts.get(draft()), saved);
  assert.deepEqual(
    await drafts.get({ scopeId, slotId: 'slot-a', runId: null, path: 'src/app.ts' }),
    noRun,
  );
  assert.equal(noRun.baseHash, null);
  assert.equal((await drafts.list(scopeId)).length, 3);
  assert.equal((await drafts.list(scopeId, 'slot-a')).length, 2);
  time = 200;
  assert.equal((await drafts.put(draft({ state: 'stale-run' }))).updatedAt, 100);
  assert.equal(
    (await drafts.put(draft({ state: 'stale-run', editedContent: 'more\n' }))).updatedAt,
    200,
  );
  await drafts.delete(draft());
  assert.equal(await drafts.get(draft()), undefined);
  assert.equal((await drafts.list(scopeId, 'slot-a')).length, 1);
});

test('a resource store schema reset and deletion keep drafts', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const database: ResourceSqliteDatabase = {
    async run(sql, params = []) {
      sqlite.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params: readonly SqliteValue[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
  };
  const drafts = createDraftStore(createMemoryDraftStorage());
  const store = await createSqliteResourceStore({ database, scope });
  await store.putQuery({ id: 'q', data: { value: 'cached' }, observedAt: 1, bytes: 18 });
  const saved = await drafts.put(draft());
  const rebuilt = await createSqliteResourceStore({
    database,
    scope,
    schemaVersion: RESOURCE_STORE_SCHEMA_VERSION + 1,
  });
  try {
    assert(store.deleted);
    assert.equal(await rebuilt.getQuery('q'), undefined);
    await rebuilt.deleteAll();
    assert.deepEqual(await drafts.get(draft()), saved);
    assert.equal(await drafts.countUnsaved(scopeId), 1);
  } finally {
    await store.close();
    await rebuilt.close();
    sqlite.close();
  }
});

test('stale-run and hidden drafts are deleted 30 days after entering that state', async () => {
  let time = 0;
  const drafts = createDraftStore(createMemoryDraftStorage(), () => time);
  await drafts.put(draft({ path: 'stale', state: 'stale-run' }));
  await drafts.put(draft({ path: 'current' }));
  time = 10;
  await drafts.put(draft({ path: 'hidden', state: 'hidden' }));
  await drafts.put(draft({ path: 'returned', state: 'hidden' }));
  time = 20;
  // Editing in the same state keeps the clock; leaving the state restarts it.
  await drafts.put(draft({ path: 'stale', state: 'stale-run', editedContent: 'later\n' }));
  await drafts.put(draft({ path: 'returned', state: 'current' }));
  await drafts.put(draft({ path: 'returned', state: 'hidden' }));
  const paths = async () => (await drafts.list(scopeId)).map((saved) => saved.path).sort();
  time = DRAFT_RETENTION_MS;
  assert.equal(await drafts.sweep(), 0);
  time = DRAFT_RETENTION_MS + 1;
  assert.equal(await drafts.sweep(), 1);
  assert.deepEqual(await paths(), ['current', 'hidden', 'returned']);
  time = DRAFT_RETENTION_MS + 11;
  assert.equal(await drafts.sweep(), 1);
  assert.deepEqual(await paths(), ['current', 'returned']);
  time = DRAFT_RETENTION_MS + 21;
  assert.equal(await drafts.sweep(), 1);
  time = 10 * DRAFT_RETENTION_MS;
  assert.equal(await drafts.sweep(), 0);
  assert.deepEqual(await paths(), ['current']);
});

test('deleteScope removes only that scope, and unsaved counts follow it', async () => {
  const drafts = createDraftStore(createMemoryDraftStorage());
  const other = resourceStoreScopeId({ ...scope, principalGeneration: 4 });
  await drafts.put(draft({ path: 'a' }));
  await drafts.put(draft({ path: 'b', state: 'hidden' }));
  await drafts.put(draft({ path: 'unchanged', editedContent: 'base\n' }));
  await drafts.put(draft({ scopeId: other, path: 'a' }));
  assert.equal(await drafts.countUnsaved(scopeId), 2);
  assert.equal(await drafts.countUnsaved(other), 1);
  await drafts.deleteScope(scopeId);
  assert.deepEqual(await drafts.list(scopeId), []);
  assert.equal(await drafts.countUnsaved(scopeId), 0);
  assert.deepEqual(
    (await drafts.list(other)).map((saved) => saved.path),
    ['a'],
  );
  assert.equal(await drafts.countUnsaved(other), 1);
});
