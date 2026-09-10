import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GitHubPage } from '../integrations/github-graphql.js';

import type { PRSourceScan } from './preview.js';
import {
  PRSourceCheckpoints,
  prSourceCheckpointScope,
  type PRSourceTraversal,
} from './source-checkpoints.js';

const scope = prSourceCheckpointScope(
  { ownerId: 'owner', id: 'team', revision: 1 },
  { ownerId: 'owner', id: 'rule', revision: 1 },
  { host: 'github.com', scope: 'owner-reader', token: 'private-test-credential' },
);
const page = <T>(nodes: T[], cursor: string | null = null): GitHubPage<T> => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const success = (items: unknown[]): PRSourceScan => ({
  subjects: [],
  complete: true,
  errors: [],
  ignoredItems: items.length,
});
async function attempt(read: () => Promise<unknown[]>): Promise<PRSourceScan> {
  try {
    return success(await read());
  } catch (error) {
    // These tests exercise persisted incomplete coverage rather than hiding unexpected failures.
    if (!(error instanceof Error) || !/paused|quota|cursor/.test(error.message)) throw error;
    return { subjects: [], complete: false, errors: [error.message], ignoredItems: 0 };
  }
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-source-checkpoints-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'checkpoints.json');
  return { file, store: await PRSourceCheckpoints.load(file) };
}

test('bounded scans resume after restart and retain completed results until consumer acknowledgement', async (t) => {
  const f = await fixture(t);
  const cursors: Array<string | null> = [];
  const collect = (traversal: PRSourceTraversal) =>
    attempt(() =>
      traversal.pages('repository', async (cursor) => {
        cursors.push(cursor);
        return cursor === null ? page(['first'], 'next') : page(['second']);
      }),
    );
  const partial = await f.store.read(scope, 1, collect);
  assert.equal(partial.complete, false);
  assert.equal(partial.progress.pages, 1);
  assert.equal(partial.progress.pendingConnections, 1);
  const restarted = await PRSourceCheckpoints.load(f.file);
  const completed = await restarted.read(scope, 1, collect);
  assert.equal(completed.complete, true);
  assert.equal(completed.ignoredItems, 2);
  assert.equal(completed.progress.id, partial.progress.id);
  assert.deepEqual(cursors, [null, 'next']);
  const afterCrash = await PRSourceCheckpoints.load(f.file);
  const retained = await afterCrash.read(scope, 1, async () => {
    throw new Error('Completed result was fetched again');
  });
  assert.equal(retained.ignoredItems, 2);
  assert.equal(retained.progress.requestsThisAttempt, 0);
  assert(await afterCrash.consume(retained.progress.id));
  const next = await afterCrash.read(scope, 1, async (traversal) =>
    success(await traversal.pages('repository', async () => page(['third']))),
  );
  assert.notEqual(next.progress.id, retained.progress.id);
  assert.equal(
    await afterCrash.consume(retained.progress.id),
    false,
    'Old consumer must not erase a newer traversal',
  );
  assert(afterCrash.current(next.progress.id));
});

test('the next connection is recorded before the last request budget is exhausted', async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const collect = (traversal: PRSourceTraversal) =>
    attempt(async () => {
      const first = await traversal.pages('first', async () => {
        calls.push('first');
        return page(['a']);
      });
      const second = await traversal.pages('second', async () => {
        calls.push('second');
        return page(['b']);
      });
      return [...first, ...second];
    });
  const partial = await f.store.read(scope, 1, collect);
  assert.equal(partial.complete, false);
  assert.equal(partial.progress.pendingConnections, 1);
  const pending = f.store.connection(partial.progress.id, 'second');
  assert(pending && pending.pages === 0 && !pending.complete);
  const complete = await (await PRSourceCheckpoints.load(f.file)).read(scope, 1, collect);
  assert.equal(complete.complete, true);
  assert.deepEqual(
    calls,
    ['first', 'second'],
    'Continuation cannot repeat the first connection forever',
  );
});

test('provider failure retains the cursor and active incomplete progress does not expire by age', async (t) => {
  const f = await fixture(t);
  const partial = await f.store.read(scope, 2, (traversal) =>
    attempt(() =>
      traversal.pages('source', async (cursor) => {
        if (cursor) throw new Error('quota exhausted');
        return page(['first'], 'next');
      }),
    ),
  );
  assert.equal(partial.complete, false);
  const data = JSON.parse(await readFile(f.file, 'utf8'));
  const old = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
  data.traversals[0].startedAt = old;
  data.traversals[0].updatedAt = old;
  data.traversals[0].connections[0].firstPageAt = old;
  await writeFile(f.file, JSON.stringify(data));
  const restarted = await PRSourceCheckpoints.load(f.file);
  const complete = await restarted.read(
    scope,
    1,
    (traversal) =>
      attempt(() =>
        traversal.pages('source', async (cursor) => {
          assert.equal(cursor, 'next');
          return page(['second']);
        }),
      ),
    1,
  );
  assert.equal(complete.complete, true);
  assert.equal(complete.progress.startedAt, old);
  assert.equal(
    complete.progress.oldestObservationAt,
    old,
    'Cached pages cannot be reported as freshly observed',
  );
});

test('repeated cursors reset the connection and dependencies without turning truncation into success', async (t) => {
  const f = await fixture(t);
  const failed = await f.store.read(scope, 3, (traversal) =>
    attempt(() => traversal.pages('root', async () => page(['partial'], 'same'))),
  );
  assert.equal(failed.complete, false);
  assert.equal(f.store.connection(failed.progress.id, 'root'), undefined);
  const recovered = await f.store.read(scope, 3, async (traversal) => {
    const root = await traversal.pages('root', async () => page(['fresh']));
    await traversal.pages('dependent', async () => page(['nested']), ['root']);
    return success(root);
  });
  assert.equal(recovered.ignoredItems, 1, 'The reset must discard incomplete rows');
  await f.store.invalidate(recovered.progress.id, ['root']);
  assert.equal(f.store.connection(recovered.progress.id, 'dependent'), undefined);
  assert.equal(f.store.progress(recovered.progress.id).completedAt, undefined);
});

test('concurrent consumers coalesce and obsolete policy pruning fences in-flight page writes', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const first = f.store.read(scope, 1, (traversal) =>
    attempt(() =>
      traversal.pages('source', async () => {
        reads++;
        entered();
        await gate;
        return page(['old']);
      }),
    ),
  );
  await started;
  const second = f.store.read(scope, 1, async () => {
    throw new Error('Parallel consumer ran another traversal');
  });
  assert.equal(first, second);
  const obsolete = assert.rejects(first, /superseded/);
  await f.store.prune([]);
  release();
  await obsolete;
  assert.equal(reads, 1);
  const current = await f.store.read(scope, 1, async (traversal) =>
    success(await traversal.pages('source', async () => page(['new']))),
  );
  assert.equal(current.ignoredItems, 1);
});

test('credential contexts and policy revisions have separate persisted scopes without storing credentials', async (t) => {
  const f = await fixture(t);
  const other = prSourceCheckpointScope(
    { ownerId: 'owner', id: 'team', revision: 1 },
    { ownerId: 'owner', id: 'rule', revision: 1 },
    { host: 'github.com', scope: 'owner-reader', token: 'another-private-test-credential' },
  );
  assert.notEqual(scope.key, other.key);
  await f.store.read(scope, 1, async (traversal) =>
    success(await traversal.pages('source', async () => page(['one']))),
  );
  const result = await f.store.read(other, 1, async (traversal) =>
    success(await traversal.pages('source', async () => page(['two']))),
  );
  assert.equal(result.progress.requestsThisAttempt, 1);
  const persisted = await readFile(f.file, 'utf8');
  assert(!persisted.includes('private-test-credential'));
  await f.store.prune([{ ...scope, ruleRevision: 2 }]);
  assert.equal(f.store.current(result.progress.id), false);
});

test('overlapping provider pages deduplicate stable IDs and retain the later observation', async (t) => {
  const f = await fixture(t);
  let rows: Array<{ id: string; value: string }> = [];
  const result = await f.store.read(scope, 2, async (traversal) => {
    rows = await traversal.pages('source', async (cursor) =>
      cursor === null
        ? page([{ id: 'one', value: 'old' }], 'next')
        : page([
            { id: 'one', value: 'new' },
            { id: 'two', value: 'second' },
          ]),
    );
    return success(rows);
  });
  assert.equal(result.progress.items, 2);
  assert.deepEqual(rows, [
    { id: 'one', value: 'new' },
    { id: 'two', value: 'second' },
  ]);
});

test('provider-rejected cursor resets progress while quota errors retain it', async (t) => {
  const { GitHubCursorError } = await import('../integrations/github-errors.js');
  const f = await fixture(t);
  const cursors: Array<string | null> = [];
  const partial = await f.store.read(scope, 1, (traversal) =>
    attempt(() =>
      traversal.pages('source', async (cursor) => {
        cursors.push(cursor);
        return page(['old'], 'expired');
      }),
    ),
  );
  const rejected = await f.store.read(scope, 1, (traversal) =>
    attempt(() =>
      traversal.pages('source', async (cursor) => {
        cursors.push(cursor);
        throw new GitHubCursorError();
      }),
    ),
  );
  assert.equal(rejected.complete, false);
  assert.equal(f.store.connection(partial.progress.id, 'source'), undefined);
  const complete = await f.store.read(scope, 1, async (traversal) =>
    success(
      await traversal.pages('source', async (cursor) => {
        cursors.push(cursor);
        return page(['fresh']);
      }),
    ),
  );
  assert.equal(complete.complete, true);
  assert.deepEqual(cursors, [null, 'expired', null]);
});
