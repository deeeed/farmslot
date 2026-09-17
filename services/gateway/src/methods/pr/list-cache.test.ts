import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Events, type PRStatus } from '@farmslot/protocol';

import {
  loadPRListCache,
  peekPRList,
  PR_LIST_CARRY_MAX_MS,
  PR_LIST_STALE_MS,
  resetPRListCacheForTests,
  servePRList,
  setPRListBroadcast,
  startPRListRefresher,
} from './list-cache.js';

function pr(n: number, extra: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: n,
    repo: 'org/app',
    title: `PR ${n}`,
    project: 'app',
    prState: 'OPEN',
    checks: [],
    checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
    failedNames: [],
    botComments: [],
    actionableBotComments: [],
    ...extra,
  } as PRStatus;
}

function list(prs: PRStatus[], truncated = false, failed: string[] = []) {
  return { prs, truncated, failed };
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
    writeFileSync(
      file,
      JSON.stringify({ version: 1, fetchedAt: '2026-09-15T00:00:00.000Z', prs: [pr(4)] }),
    );
    loadPRListCache();
    assert.equal(peekPRList()?.prs[0].pr, 4);
    for (const stale of [
      '{"prs": "nope"}',
      JSON.stringify({ fetchedAt: '2026-09-15T00:00:00.000Z', prs: [pr(4)] }),
      JSON.stringify({ version: 1, fetchedAt: 'x', prs: [{ pr: 4, repo: 'org/app' }] }),
    ]) {
      resetPRListCacheForTests();
      writeFileSync(file, stale);
      loadPRListCache();
      assert.equal(peekPRList(), null, `rejected: ${stale.slice(0, 40)}`);
    }
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
      return list([pr(1)]);
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

test('the refresher does not poll a warm list after clients leave the PR board', async () => {
  const { cleanup } = isolate();
  try {
    let calls = 0;
    await servePRList(async () => {
      calls += 1;
      return list([pr(1)]);
    });
    assert.equal(calls, 1);
    const stop = startPRListRefresher(
      async () => {
        calls += 1;
        return list([pr(1)]);
      },
      {
        broadcast: () => {},
        hasClients: () => true,
        initialDelayMs: 1,
        intervalMs: 5,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    assert.equal(calls, 1, 'fresh warm copy is not refetched inside the stale window');
  } finally {
    cleanup();
  }
});

test('an unchanged refresh still announces completion, without shipping the list', async () => {
  const { cleanup } = isolate();
  try {
    const events: Array<{ fetchedAt: string; prs?: PRStatus[] }> = [];
    setPRListBroadcast((_event, payload) => events.push(payload as (typeof events)[number]));
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
    setPRListBroadcast((_event, payload) => events.push(payload as (typeof events)[number]));
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

test('PRs GitHub could not read keep their last known row instead of vanishing', async () => {
  const { cleanup } = isolate();
  try {
    const merged = pr(1, { prState: 'MERGED', title: 'known merged' });
    await servePRList(async () => list([merged, pr(2)]));
    const partial = await servePRList(async () => list([pr(2)], false, ['org/app#1']), {
      force: true,
    });
    assert.deepEqual(
      partial.prs.map((p) => [p.pr, p.title]),
      [
        [2, 'PR 2'],
        [1, 'known merged'],
      ],
    );
    assert.equal(peekPRList()?.prs.length, 2, 'persisted copy carries the row too');
  } finally {
    cleanup();
  }
});

test('a forced refresh that fails is announced to every client, and the caller still sees the error', async () => {
  const { cleanup } = isolate();
  try {
    const events: Array<{ error?: string }> = [];
    setPRListBroadcast((_event, payload) => events.push(payload as (typeof events)[number]));
    await servePRList(async () => list([pr(1)]));
    await assert.rejects(
      servePRList(
        async () => {
          throw new Error('gh down');
        },
        { force: true },
      ),
      /gh down/,
    );
    assert.equal(events.at(-1)?.error, 'gh down');
    assert.equal(peekPRList()?.prs[0].pr, 1, 'warm copy retained');
  } finally {
    cleanup();
  }
});

test('a row GitHub keeps failing to read is carried for an hour, then dropped', async () => {
  const { cleanup } = isolate();
  try {
    const t0 = Date.parse('2026-09-15T10:00:00.000Z');
    await servePRList(async () => list([pr(1), pr(2)]), { now: t0 });
    const failing = async () => list([pr(2)], false, ['org/app#1']);
    const carried = await servePRList(failing, { force: true, now: t0 + 1_000 });
    assert.deepEqual(
      carried.prs.map((p) => p.pr),
      [2, 1],
    );
    // The carry clock starts at the first failed read (t0 + 1s), not at t0.
    const stillCarried = await servePRList(failing, {
      force: true,
      now: t0 + 1_000 + PR_LIST_CARRY_MAX_MS,
    });
    assert.deepEqual(
      stillCarried.prs.map((p) => p.pr),
      [2, 1],
    );
    const dropped = await servePRList(failing, {
      force: true,
      now: t0 + 1_000 + PR_LIST_CARRY_MAX_MS + 1,
    });
    assert.deepEqual(
      dropped.prs.map((p) => p.pr),
      [2],
      'unreadable for over an hour: gone from the list',
    );
  } finally {
    cleanup();
  }
});

test('the carry clock survives a gateway restart', async () => {
  const { dir, cleanup } = isolate();
  try {
    const t0 = Date.parse('2026-09-15T10:00:00.000Z');
    await servePRList(async () => list([pr(1), pr(2)]), { now: t0 });
    const failing = async () => list([pr(2)], false, ['org/app#1']);
    await servePRList(failing, { force: true, now: t0 + 1_000 });
    const stored = JSON.parse(readFileSync(path.join(dir, '.farm-cache', 'pr-list.json'), 'utf-8'));
    assert.deepEqual(stored.carriedSince, { 'org/app#1': t0 + 1_000 });
    // "Restart": drop memory, reload from disk, then keep failing past the cap.
    resetPRListCacheForTests();
    loadPRListCache();
    const afterRestart = await servePRList(failing, {
      force: true,
      now: t0 + 1_000 + PR_LIST_CARRY_MAX_MS + 1,
    });
    assert.deepEqual(
      afterRestart.prs.map((p) => p.pr),
      [2],
      'the hour counts from the first failure before the restart',
    );
  } finally {
    cleanup();
  }
});
