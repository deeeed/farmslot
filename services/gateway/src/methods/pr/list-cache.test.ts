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
      return [pr(1)];
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
      return [pr(calls)];
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

test('force bypasses the warm copy and waits for GitHub', async () => {
  const { cleanup } = isolate();
  try {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return [pr(calls)];
    };
    await servePRList(fetch);
    const forced = await servePRList(fetch, { force: true });
    assert.equal(calls, 2);
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
      new Promise<PRStatus[]>((resolve) => {
        calls += 1;
        setTimeout(() => resolve([pr(9)]), 5);
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
    const first = await servePRList(async () => [pr(1)]);
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
    const events: Array<{ event: string; count: number }> = [];
    const fetch = async () => {
      calls += 1;
      return calls === 3 ? [pr(1), pr(2)] : [pr(1)];
    };
    const stop = startPRListRefresher(fetch, {
      broadcast: (event, payload) =>
        events.push({ event, count: (payload as { prs: PRStatus[] }).prs.length }),
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
