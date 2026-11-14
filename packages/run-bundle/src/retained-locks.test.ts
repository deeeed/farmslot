import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import lockfile, { type LockOptions } from 'proper-lockfile';

import {
  openRunBundleStore,
  withRunBundleLockWaitBudget,
  withRunBundleStoreLock,
} from './retained.js';

test('capture, GC and admission in one process wait without exhausting filesystem lock retries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openRunBundleStore({
    runsDir: path.join(root, 'runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  const acquire = lockfile.lock;
  let held = false;
  t.mock.method(lockfile, 'lock', async (file: string, options?: LockOptions) => {
    // Collapse the retry window while a real lease is held. Slow retention IO
    // otherwise takes 30 seconds to reproduce this same exhausted-retry result.
    if (held)
      throw Object.assign(new Error('Lock file is already being held'), {
        code: 'ELOCKED',
        file,
      });
    const release = await acquire(file, { ...options, retries: 0 });
    held = true;
    return async () => {
      await release();
      held = false;
    };
  });
  const events = new EventEmitter();
  const entered = once(events, 'capture');
  const order: string[] = [];
  const capture = withRunBundleStoreLock(store, async () => {
    order.push('capture');
    const release = once(events, 'release');
    events.emit('capture');
    await release;
  });
  await Promise.race([entered, capture]);
  const gc = withRunBundleStoreLock(store, async () => {
    order.push('gc');
  });
  const admission = withRunBundleStoreLock(store, async () => {
    order.push('admission');
  });
  const settled = Promise.allSettled([capture, gc, admission]);
  try {
    await setImmediate();
  } finally {
    events.emit('release');
  }
  const outcomes = await settled;
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled', 'fulfilled'],
  );
  assert.deepEqual(order, ['capture', 'gc', 'admission']);
});

test('exhausted external contention names the lock and does not poison later work', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openRunBundleStore({
    runsDir: path.join(root, 'runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  const lockPath = path.join(store.runsDir, 'bundle-store.lock');
  const busy = Object.assign(new Error('Lock file is already being held'), {
    code: 'ELOCKED',
    file: lockPath,
  });
  t.mock.method(lockfile, 'lock', async () => {
    throw busy;
  });
  await assert.rejects(
    withRunBundleStoreLock(store, async () => 'unreachable'),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(lockPath) &&
      error.message.includes(String(process.pid)) &&
      'code' in error &&
      error.code === 'ELOCKED' &&
      'file' in error &&
      error.file === lockPath &&
      error.cause === busy,
  );
  t.mock.restoreAll();
  assert.equal(await withRunBundleStoreLock(store, async () => 'available'), 'available');
});

test(
  'waiters behind a holder past its limit fail naming it and stay queued behind it',
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'retained-lock-stall-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = await openRunBundleStore({
      runsDir: path.join(root, 'runs'),
      home: path.join(root, 'home'),
      create: true,
    });
    const acquire = lockfile.lock;
    let acquisitions = 0;
    t.mock.method(lockfile, 'lock', (file: string, options?: LockOptions) => {
      acquisitions += 1;
      return acquire(file, options);
    });
    const warn = t.mock.method(console, 'warn', () => {});
    let finish!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withRunBundleStoreLock(
      store,
      async () => {
        entered();
        await new Promise<void>((done) => {
          finish = done;
        });
      },
      { label: 'capture of run stuck', holdLimitMs: 50 },
    );
    await holding;
    const stalled = (error: NodeJS.ErrnoException) =>
      error.code === 'ELOCKED' &&
      /held by capture of run stuck .*past its 0s limit/.test(error.message);
    const first = withRunBundleStoreLock(store, async () => 'never');
    const second = withRunBundleStoreLock(store, async () => 'never');
    // Both waiters time out on the same deadline, in either order; observe both
    // before awaiting so neither rejection is unhandled while the other settles.
    await Promise.all([assert.rejects(first, stalled), assert.rejects(second, stalled)]);
    // A caller arriving after those timeouts still queues behind the holder, not the file lock.
    await assert.rejects(
      withRunBundleStoreLock(store, async () => 'never'),
      stalled,
    );
    assert.equal(acquisitions, 1, 'no waiter reached the file lock while the holder ran');
    assert.ok(
      warn.mock.calls.some((call) =>
        /held by capture of run stuck/.test(String(call.arguments[0])),
      ),
    );
    finish();
    await holder;
    assert.equal(await withRunBundleStoreLock(store, async () => 'next'), 'next');
  },
);

test('a compound wait budget covers successive locks and nested work without poisoning unrelated captures', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-lock-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openRunBundleStore({
    runsDir: path.join(root, 'runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let acquisitions = 0;
  let releases = 0;
  let writes = 0;
  t.mock.method(lockfile, 'lock', async () => {
    acquisitions++;
    now += acquisitions === 1 ? 40_000 : 30_000;
    return async () => {
      releases++;
    };
  });
  await assert.rejects(
    withRunBundleLockWaitBudget(60_000, async () => {
      await withRunBundleStoreLock(store, async () => {
        writes++;
      });
      await withRunBundleLockWaitBudget(60_000, () =>
        withRunBundleStoreLock(store, async () => {
          writes++;
        }),
      );
    }),
    /bundle.*wait budget exhausted/i,
  );
  assert.equal(writes, 1, 'the second lock never admits an expired writer');
  assert.equal(releases, 2, 'a late external acquisition is released before refusing');
  await withRunBundleStoreLock(store, async () => {
    writes++;
  });
  assert.equal(writes, 2, 'other captures inherit no expired budget');
});

test('failed external lock acquisitions also consume the shared wait budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-lock-failed-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openRunBundleStore({
    runsDir: path.join(root, 'runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(lockfile, 'lock', async () => {
    calls++;
    now += 60_001;
    throw Object.assign(new Error('Another process holds the store'), { code: 'ELOCKED' });
  });
  await withRunBundleLockWaitBudget(60_000, async () => {
    await assert.rejects(
      withRunBundleStoreLock(store, async () => assert.fail('not acquired')),
      /retries exhausted/,
    );
    await assert.rejects(
      withRunBundleStoreLock(store, async () => assert.fail('expired writer')),
      /wait budget exhausted/,
    );
  });
  assert.equal(calls, 1, 'retrying a failed acquisition cannot reset its caller budget');
});
