import assert from 'node:assert/strict';
import test from 'node:test';

import type { TmuxWorkerSummary } from '../../src/workers/rpc/tmux.js';
import {
  createTmuxWorkerWatchItem,
  flattenTmuxWorkers,
  isTmuxWorkerWatched,
  reconcileTmuxWorkerWatchlist,
  removeTmuxWorkerWatchItem,
  tmuxWorkerRefsMatch,
  tmuxWorkerWatchId,
  upsertTmuxWorkerWatchItem,
} from '../../src/workers/tmux-worker-watchlist.js';

function worker(overrides: Partial<TmuxWorkerSummary> = {}): TmuxWorkerSummary {
  return {
    ref: {
      nodeId: 'macwork',
      session: 'omx-farmslot',
      window: '1',
      pane: '2',
      target: 'omx-farmslot:1.2',
    },
    title: 'Farmslot cleanup',
    cwd: '/Users/deeeed/dev/farmslot',
    command: 'codex',
    status: { label: 'working', source: 'statusline', confidence: 'high' },
    ...overrides,
  };
}

test('tmux worker watch ids are stable across volatile metadata', () => {
  const ref = worker().ref;

  assert.equal(tmuxWorkerWatchId(ref), 'macwork:omx-farmslot:1.2');
  assert.equal(tmuxWorkerRefsMatch(ref, { ...ref, paneId: '%44' }), true);
  assert.equal(tmuxWorkerRefsMatch(ref, { ...ref, target: 'other:1.2' }), false);
});

test('watchlist upsert preserves pin time and refreshes last seen metadata', () => {
  const initial = createTmuxWorkerWatchItem(worker(), 10);
  const updatedWorker = worker({
    title: 'Renamed',
    cwd: '/tmp/farmslot',
    status: { label: 'waiting', source: 'hook', confidence: 'medium' },
  });

  const items = upsertTmuxWorkerWatchItem([initial], updatedWorker, 25);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.pinnedAt, 10);
  assert.equal(items[0]?.lastSeenAt, 25);
  assert.equal(items[0]?.title, 'Renamed');
  assert.equal(items[0]?.cwd, '/tmp/farmslot');
  assert.equal(items[0]?.statusLabel, 'waiting');
});

test('watchlist refresh clears metadata no longer reported by live workers', () => {
  const initial = createTmuxWorkerWatchItem(
    worker({
      branch: 'feature/old',
      linkedSlotId: 'slot-1',
      linkedRunId: 'run-1',
      linkedFamilyId: 'family-1',
    }),
    10,
  );
  const updatedWorker = worker({
    title: undefined,
    cwd: undefined,
    command: undefined,
    branch: undefined,
    linkedSlotId: undefined,
    linkedRunId: undefined,
    linkedFamilyId: undefined,
    status: { label: '', source: 'tmux', confidence: 'medium' },
  });

  const entries = reconcileTmuxWorkerWatchlist([initial], [updatedWorker], 25);

  assert.equal(entries[0]?.item.pinnedAt, 10);
  assert.equal(entries[0]?.item.lastSeenAt, 25);
  assert.equal(entries[0]?.item.title, undefined);
  assert.equal(entries[0]?.item.cwd, undefined);
  assert.equal(entries[0]?.item.command, undefined);
  assert.equal(entries[0]?.item.branch, undefined);
  assert.equal(entries[0]?.item.linkedSlotId, undefined);
  assert.equal(entries[0]?.item.linkedRunId, undefined);
  assert.equal(entries[0]?.item.linkedFamilyId, undefined);
  assert.equal(entries[0]?.item.statusLabel, undefined);
});

test('watchlist reconciles live and stale terminal entries without losing stale refs', () => {
  const live = worker();
  const stale = worker({
    ref: {
      nodeId: 'mini',
      session: 'detached',
      target: 'detached:0.0',
    },
    title: 'Detached shell',
  });
  const items = [createTmuxWorkerWatchItem(stale, 5), createTmuxWorkerWatchItem(live, 10)];

  const entries = reconcileTmuxWorkerWatchlist(items, [live], 20);

  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.live]),
    [
      ['mini:detached:0.0', false],
      ['macwork:omx-farmslot:1.2', true],
    ],
  );
  assert.equal(entries[0]?.ref.session, 'detached');
  assert.equal(entries[1]?.item.lastSeenAt, 20);
});

test('watchlist add remove and flatten helpers keep app adapters small', () => {
  const watched = upsertTmuxWorkerWatchItem([], worker(), 1);

  assert.equal(isTmuxWorkerWatched(watched, worker().ref), true);
  assert.equal(removeTmuxWorkerWatchItem(watched, worker().ref).length, 0);
  assert.deepEqual(flattenTmuxWorkers([{ workers: [worker()] }, { workers: [] }]), [worker()]);
});
