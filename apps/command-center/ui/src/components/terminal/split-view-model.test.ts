import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TmuxWorkerSummary, TmuxWorkerWatchEntry } from '@farmslot/protocol';

import {
  isFarmslotWatchEntry,
  isFarmslotWorker,
  isWorkerPaneFilter,
  meaningfulPaneTitle,
  parseWatchItems,
  parseWorkerRefs,
  tmuxRefTitle,
  watchEntryDescription,
  workerDescription,
} from './split-view-model.js';

const ref = { nodeId: 'node-a', session: 'work', target: '%3', window: '2', pane: '1' };

test('split view model parses persisted worker refs and watch items defensively', () => {
  assert.deepEqual(parseWorkerRefs(null), []);
  assert.deepEqual(parseWorkerRefs(JSON.stringify([{ ...ref }, { nodeId: 'bad' }])), [ref]);

  const item = { id: 'watch-1', nodeId: 'node-a', target: '%3', ref, title: 'api', cwd: '/repo' };
  assert.deepEqual(parseWatchItems(JSON.stringify([item, { id: 'bad' }])), [item]);
});

test('split view model labels panes without repeating low-signal titles', () => {
  assert.equal(tmuxRefTitle(ref), 'work · 2:1');
  assert.equal(
    meaningfulPaneTitle('repo', { cwd: '/Users/me/repo', nodeId: 'node-a', session: 'work' }),
    null,
  );
  assert.equal(
    meaningfulPaneTitle('API server', { cwd: '/repo', nodeId: 'node-a', session: 'work' }),
    'API server',
  );

  const worker = {
    ref,
    title: 'API server',
    cwd: '/repo',
    branch: 'feature/x',
    command: 'yarn dev',
    status: { label: 'running' },
  } as TmuxWorkerSummary;
  assert.equal(
    workerDescription(worker),
    'API server · running · feature/x · /repo · cmd:yarn dev · node-a %3',
  );
});

test('split view model classifies filters and Farmslot-linked workers', () => {
  assert.equal(isWorkerPaneFilter('adhoc'), true);
  assert.equal(isWorkerPaneFilter('all'), true);
  assert.equal(isWorkerPaneFilter('farmslot'), true);
  assert.equal(isWorkerPaneFilter('other'), false);

  const linked = { ref, linkedSlotId: 'slot-1', status: { label: 'running' } } as TmuxWorkerSummary;
  const adhoc = { ref, status: { label: 'running' } } as TmuxWorkerSummary;
  assert.equal(isFarmslotWorker(linked), true);
  assert.equal(isFarmslotWorker(adhoc), false);

  const entry = {
    id: 'watch-1',
    ref,
    live: false,
    item: {
      id: 'watch-1',
      ref,
      pinnedAt: 1,
      ...ref,
      title: 'api',
      statusLabel: 'stale',
      linkedRunId: 'run-1',
    },
  } as TmuxWorkerWatchEntry;
  assert.equal(isFarmslotWatchEntry(entry), true);
  assert.match(watchEntryDescription(entry), /stale · api/);
});
