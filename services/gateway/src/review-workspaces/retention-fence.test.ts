import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  assertReviewWorkspaceAdmissionOpen,
  noteReviewWorkspaceRetirement,
  reclaimReviewWorkspaceStorage,
  useReviewWorkspaceStorage,
} from './storage-use.js';
test('expiry blocks new admission publication while allowing its owned cleanup operations', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    held = new Promise<void>((r) => (release = r));
  const cleanup = reclaimReviewWorkspaceStorage(async () => {
    await useReviewWorkspaceStorage(async () => {
      entered();
      await held;
    });
    return ['/owned/expired'];
  });
  await ready;
  assert.throws(() => assertReviewWorkspaceAdmissionOpen(), /cleanup is running/);
  let admitted = false;
  const admission = useReviewWorkspaceStorage(async () => {
    assertReviewWorkspaceAdmissionOpen();
    admitted = true;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  release();
  assert.deepEqual(await cleanup, ['/owned/expired']);
  await admission;
  assert.equal(admitted, true);
});

test('a persisted retirement keeps its PR fenced after the in-memory sweep ends', () => {
  const run: Pick<Run, 'id' | 'ticketOrPr' | 'reviewWorkspace'> = {
    id: 'retiring-run',
    ticketOrPr: 'example/app#42',
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'node',
      executionNodeId: 'node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
      retirement: {
        id: 'retirement',
        startedAt: '2026-11-06T00:00:00Z',
        pr: { host: 'github.com', repo: 'example/app', number: 42 },
      },
    },
  };
  noteReviewWorkspaceRetirement(run);
  try {
    assert.throws(
      () => assertReviewWorkspaceAdmissionOpen({ ticketOrPr: 'Example/App#42' }),
      /cleanup is running/,
    );
    assert.doesNotThrow(() =>
      assertReviewWorkspaceAdmissionOpen({ ticketOrPr: 'example/other#42' }),
    );
  } finally {
    noteReviewWorkspaceRetirement({
      ...run,
      reviewWorkspace: { ...run.reviewWorkspace!, cleanedAt: '2026-11-06T00:01:00Z' },
    });
  }
  assert.doesNotThrow(() => assertReviewWorkspaceAdmissionOpen({ ticketOrPr: 'example/app#42' }));
});
