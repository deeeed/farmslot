import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as files from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { QueueItem, Run } from '@farmslot/protocol';
const root = mkdtempSync(path.join(os.tmpdir(), 'review-queue-retirement-'));
const file = path.join(root, 'queue.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = file;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
let failCancellation = false;
mock.module('node:fs/promises', {
  namedExports: {
    ...files,
    rename: async (...args: Parameters<typeof files.rename>) => {
      if (failCancellation && String(args[1]) === file)
        throw new Error('cancel persistence unavailable');
      return files.rename(...args);
    },
  },
});
const {
  loadQueue,
  getQueueSnapshot,
  persistQueueNow,
  removeItem,
  resetDispatchQueueForTests,
  claimQueueItem,
} = await import('./dispatch-queue.js');
const {
  noteReviewWorkspaceRetirement,
  assertReviewWorkspaceAdmissionOpen,
  reclaimReviewWorkspaceStorage,
} = await import('../review-workspaces/storage-use.js');
after(async () => {
  await resetDispatchQueueForTests();
  await files.rm(root, { recursive: true, force: true });
});
const retired: Pick<Run, 'id' | 'ticketOrPr' | 'reviewWorkspace'> = {
  id: 'retiring-queue',
  ticketOrPr: 'example/app#92',
  reviewWorkspace: {
    workspaceId: 'workspace',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/owned/source',
    taskPath: '/owned/task',
    artifactPath: '/owned/task/artifacts',
    retirement: {
      id: 'retirement',
      startedAt: '2026-11-06T00:00:00Z',
      pr: { host: 'github.com', repo: 'example/app', number: 92 },
    },
  },
};
for (const state of ['queued', 'dispatching'])
  test(`restored ${state} review waits for earlier retirement without blocking its cleanup`, async () => {
    await resetDispatchQueueForTests();
    const row: QueueItem = {
      id: 'queued-review',
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: retired.ticketOrPr,
      transport: 'tmux',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      reviewWorkspaceTarget: { machine: 'local' },
      reviewMode: 'cold',
      priority: 10,
      createdAt: new Date().toISOString(),
      status: 'queued',
    };
    await files.writeFile(file, JSON.stringify([{ ...row, originator: { kind: 'system' } }]));
    await loadQueue();
    if (state === 'dispatching') assert(claimQueueItem(row.id, 'old-dispatcher'));
    await persistQueueNow();
    failCancellation = true;
    removeItem(row.id);
    await assert.rejects(persistQueueNow(), /cancel persistence unavailable/);
    assert.deepEqual(getQueueSnapshot(), []);
    failCancellation = false;
    noteReviewWorkspaceRetirement(retired, true);
    try {
      await loadQueue();
      await persistQueueNow();
      assert.equal(getQueueSnapshot()[0].status, 'queued');
      assert.deepEqual(
        getQueueSnapshot({ forRetention: true }),
        [],
        'unadmitted restored row cannot deadlock its prior retirement',
      );
      assert.throws(() => assertReviewWorkspaceAdmissionOpen(row), /cleanup is running/);
      await reclaimReviewWorkspaceStorage(async () => {
        noteReviewWorkspaceRetirement(
          {
            ...retired,
            reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
          },
          true,
        );
        return [];
      });
      assert.equal(getQueueSnapshot({ forRetention: true })[0].id, row.id);
      assert.doesNotThrow(() => assertReviewWorkspaceAdmissionOpen(row));
      assert(claimQueueItem(row.id, 'new-dispatcher'));
    } finally {
      failCancellation = false;
      noteReviewWorkspaceRetirement(
        {
          ...retired,
          reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
        },
        true,
      );
      await resetDispatchQueueForTests();
    }
  });

test('restored reviews for other PRs remain admitted and protect retention', async () => {
  await resetDispatchQueueForTests();
  const first: QueueItem = {
    id: 'fenced-review',
    flowType: 'review-pr',
    project: 'fixture',
    ticketOrPr: retired.ticketOrPr,
    priority: 10,
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  const other: QueueItem = { ...first, id: 'other-review', ticketOrPr: 'example/app#93' };
  await files.writeFile(file, JSON.stringify([first, other]));
  noteReviewWorkspaceRetirement(retired, true);
  try {
    await loadQueue();
    assert.equal(getQueueSnapshot().length, 2);
    assert.deepEqual(
      getQueueSnapshot({ forRetention: true }).map((row) => row.id),
      [other.id],
    );
    noteReviewWorkspaceRetirement(
      {
        ...retired,
        reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
      },
      true,
    );
    assert.equal(getQueueSnapshot({ forRetention: true }).length, 2);
  } finally {
    noteReviewWorkspaceRetirement(
      {
        ...retired,
        reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
      },
      true,
    );
    await resetDispatchQueueForTests();
  }
});
