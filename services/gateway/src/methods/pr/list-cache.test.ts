import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Events, type PRStatus } from '@farmslot/protocol';

import {
  loadPRListCache,
  peekPRList,
  PR_LIST_STALE_MS,
  resetPRListCacheForTests,
  servePRList,
  startPRListRefresher,
} from './list-cache.js';

function pr(n: number, extra: Partial<PRStatus> = {}): PRStatus {
  return { pr: n, repo: 'org/app', title: `PR ${n}`, project: 'app', ...extra } as PRStatus;
}

function list(prs: PRStatus[], truncated = false) {
  return { prs, truncated };
}

function isolate(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-list-cache-'));
  const previous = process.env.FARMSLOT_DIR;
  process.env.FARMSLOT_DIR = dir;
  resetPRListCacheForTests();
  return {
    dir,
    cleanup: () => {
      resetPRListCacheForTests();
      if (previous === undefined) delete process.env.FARMSLOT_DIR;
      else process.env.FARMSLOT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('cold request fetches, answers fresh, and persists the snapshot', async () => {
  const { dir, cleanup } = isolate();
  try {
    let calls = 0;
    const result = await servePRList(async () => {
      calls += 1;
      return list([pr(1)]);
    });
    assert.equal(calls, 1);
    assert.equal(result.refreshing, false);
    assert.equal(result.prs.length, 1);
    assert.ok(result.fetchedAt);
    const file = path.join(dir, '.farm-cache', 'pr-list.json');
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf-8')).prs[0].pr, 1);
  } finally {
    cleanup();
  }
});

test('warm request answers without fetching until the copy is stale, then refreshes in the background', async () => {
  const { cleanup } = isolate();
  try {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return list([pr(calls)]);
    };
    const first = await servePRList(fetch);
    const now = Date.parse(first.fetchedAt!);
    const warm = await servePRList(fetch, { now: now + PR_LIST_STALE_MS - 1 });
    assert.equal(calls, 1, 'fresh copy served without a fetch');
    assert.equal(warm.refreshing, false);
    const stale = await servePRList(fetch, { now: now + PR_LIST_STALE_MS + 1 });
    assert.equal(stale.prs[0].pr, 1, 'stale copy served immediately');
    assert.equal(stale.refreshing, true, 'a background refresh is running');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    assert.equal(peekPRList()?.prs[0].pr, 2);
  } finally {
    cleanup();
  }
});

test('force bypasses the warm copy, asks the fetcher to bypass GitHub caches, and waits', async () => {
  const { cleanup } = isolate();
  try {
    const forces: boolean[] = [];
    const fetch = async (force: boolean) => {
      forces.push(force);
      return list([pr(forces.length)]);
    };
    await servePRList(fetch);
    const forced = await servePRList(fetch, { force: true });
    assert.deepEqual(forces, [false, true]);
    assert.equal(forced.prs[0].pr, 2);
    assert.equal(forced.refreshing, false);
  } finally {
    cleanup();
  }
});

test('concurrent cold requests share one fetch', async () => {
  const { cleanup } = isolate();
  try {
    let calls = 0;
    const fetch = () =>
      new Promise<{ prs: PRStatus[]; truncated: boolean }>((resolve) => {
        calls += 1;
        setTimeout(() => resolve(list([pr(9)])), 5);
      });
    const [a, b] = await Promise.all([servePRList(fetch), servePRList(fetch)]);
    assert.equal(calls, 1);
    assert.equal(a.fetchedAt, b.fetchedAt);
  } finally {
    cleanup();
  }
});

test('a failed background refresh keeps the warm copy and the cold path still throws', async () => {
  const { cleanup } = isolate();
  try {
    const first = await servePRList(async () => list([pr(1)]));
    const failing = async () => {
      throw new Error('gh quota');
    };
    const served = await servePRList(failing, {
      now: Date.parse(first.fetchedAt!) + PR_LIST_STALE_MS + 1,
    });
    assert.equal(served.prs[0].pr, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(peekPRList()?.prs[0].pr, 1);
    await assert.rejects(servePRList(failing, { force: true }), /gh quota/);
  } finally {
    cleanup();
  }
});

test('the snapshot on disk is served on the next start; malformed files are ignored', () => {
  const { dir, cleanup } = isolate();
  try {
    const cacheDir = path.join(dir, '.farm-cache');
    mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, 'pr-list.json');
    writeFileSync(file, JSON.stringify({ fetchedAt: '2026-09-15T00:00:00.000Z', prs: [pr(4)] }));
    loadPRListCache();
    assert.equal(peekPRList()?.prs[0].pr, 4);
    resetPRListCacheForTests();
    writeFileSync(file, '{"prs": "nope"}');
    loadPRListCache();
    assert.equal(peekPRList(), null);
  } finally {
    cleanup();
  }
});

test('the refresher only fetches while a client is connected and broadcasts changed lists', async () => {
  const { cleanup } = isolate();
  try {
    let calls = 0;
    let clients = false;
    const events: Array<{ event: string; count: number | undefined }> = [];
    const fetch = async () => {
      calls += 1;
      return list(calls === 3 ? [pr(1), pr(2)] : [pr(1)]);
    };
    const stop = startPRListRefresher(fetch, {
      broadcast: (event, payload) =>
        events.push({ event, count: (payload as { prs?: PRStatus[] }).prs?.length }),
      hasClients: () => clients,
      initialDelayMs: 1,
      intervalMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, 0, 'no clients, no GitHub traffic');
    clients = true;
    await new Promise((resolve) => setTimeout(resolve, 15));
    stop();
    assert.ok(calls >= 1, 'a connected client triggers the cold refresh');
    assert.deepEqual(events[0], { event: Events.PR_LIST_UPDATED, count: 1 });
    // A fresh copy is not refetched by later ticks within PR_LIST_STALE_MS.
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});

test('an unchanged refresh still announces completion, without shipping the list', async () => {
  const { cleanup } = isolate();
  try {
    const events: Array<{ fetchedAt: string; prs?: PRStatus[] }> = [];
    startPRListRefresher(async () => list([pr(1)]), {
      broadcast: (_event, payload) => events.push(payload as (typeof events)[number]),
      hasClients: () => false,
      initialDelayMs: 100_000,
      intervalMs: 100_000,
    })();
    const first = await servePRList(async () => list([pr(1)]));
    assert.equal(events.length, 1, 'cold fetch announces the new list');
    assert.equal(events[0].prs?.length, 1);
    await servePRList(async () => list([pr(1)]), { force: true });
    assert.equal(events.length, 2);
    assert.equal(events[1].prs, undefined, 'unchanged list is not re-sent');
    assert.ok(Date.parse(events[1].fetchedAt) >= Date.parse(first.fetchedAt!));
  } finally {
    cleanup();
  }
});

test('a truncated fetch is reported so project-scoped callers can rediscover', async () => {
  const { cleanup } = isolate();
  try {
    const served = await servePRList(async () => list([pr(1)], true));
    assert.equal(served.truncated, true);
    assert.equal(
      (await servePRList(async () => list([pr(1)]))).truncated,
      true,
      'warm copy remembers',
    );
  } finally {
    cleanup();
  }
});

test('a forced refresh during a non-forced fetch runs after it and reaches the fetcher with force', async () => {
  const { cleanup } = isolate();
  try {
    const seen: boolean[] = [];
    let release: (() => void) | undefined;
    const fetch = (force: boolean) =>
      new Promise<{ prs: PRStatus[]; truncated: boolean }>((resolve) => {
        seen.push(force);
        if (!force) release = () => resolve(list([pr(1)]));
        else resolve(list([pr(2)]));
      });
    const cold = servePRList(fetch);
    const forced = servePRList(fetch, { force: true });
    const forcedAgain = servePRList(fetch, { force: true });
    assert.deepEqual(seen, [false], 'forced call waits for the running fetch');
    release!();
    const [first, second, third] = await Promise.all([cold, forced, forcedAgain]);
    assert.deepEqual(seen, [false, true], 'one forced fetch serves both forced callers');
    assert.equal(first.prs[0].pr, 1);
    assert.equal(second.prs[0].pr, 2);
    assert.equal(third.fetchedAt, second.fetchedAt);
  } finally {
    cleanup();
  }
});

test('a failed background refresh is announced with the retained fetch time', async () => {
  const { cleanup } = isolate();
  try {
    const events: Array<{ fetchedAt?: string; error?: string; prs?: PRStatus[] }> = [];
    startPRListRefresher(async () => list([pr(1)]), {
      broadcast: (_event, payload) => events.push(payload as (typeof events)[number]),
      hasClients: () => false,
      initialDelayMs: 100_000,
      intervalMs: 100_000,
    })();
    const first = await servePRList(async () => list([pr(1)]));
    await servePRList(
      async () => {
        throw new Error('gh down');
      },
      { now: Date.parse(first.fetchedAt!) + PR_LIST_STALE_MS + 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(events.length, 2);
    assert.equal(events[1].error, 'gh down');
    assert.equal(events[1].fetchedAt, first.fetchedAt);
    assert.equal(events[1].prs, undefined);
  } finally {
    cleanup();
  }
});
