import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as files from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = mkdtempSync(path.join(os.tmpdir(), 'review-retention-queue-'));
const queueFile = path.join(root, 'queue.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = queueFile;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
let beforeEmptyWrite: (() => Promise<void>) | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...files,
    writeFile: async (...args: Parameters<typeof files.writeFile>) => {
      if (String(args[0]).startsWith(queueFile + '.tmp.') && args[1] === '[]')
        await beforeEmptyWrite?.();
      return files.writeFile(...args);
    },
  },
});
const {
  addItem,
  cancelGraphQueuedItem,
  getQueueSnapshot,
  persistQueueNow,
  resetDispatchQueueForTests,
} = await import('./dispatch-queue.js');
const { reclaimReviewWorkspaceStorage } = await import('../review-workspaces/storage-use.js');
after(async () => {
  await resetDispatchQueueForTests();
  await files.rm(root, { recursive: true, force: true });
});

for (const phase of ['persist', 'dependent'] as const) {
  test(`queue ${phase} rollback remains protected from retention reclamation`, async () => {
    await resetDispatchQueueForTests();
    const item = addItem(
      {
        flowType: 'fix-bug',
        project: 'farm',
        ticketOrPr: 'owner/repo#42',
        workGraphId: 'graph',
        workNodeId: 'node',
      },
      { kind: 'system' },
    );
    await persistQueueNow();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fail = async () => {
      entered();
      await held;
      throw new Error(`${phase} failed`);
    };
    if (phase === 'persist') beforeEmptyWrite = fail;
    const cancellation = cancelGraphQueuedItem({
      workGraphId: 'graph',
      workNodeId: 'node',
      reason: 'retention-test',
      ...(phase === 'dependent' ? { commitDependent: fail } : {}),
    });
    const rejected = assert.rejects(cancellation, new RegExp(`${phase} failed`));
    await ready;
    try {
      assert.equal(getQueueSnapshot().length, 0, 'row is detached before rollback');
      let reclaimed = false;
      assert.deepEqual(
        await reclaimReviewWorkspaceStorage(async () => {
          reclaimed = true;
          return ['unsafe'];
        }),
        [],
      );
      assert.equal(
        reclaimed,
        false,
        'cleanup cannot acquire storage during this publication transaction',
      );
    } finally {
      beforeEmptyWrite = undefined;
      release();
      await rejected;
    }
    assert.equal(getQueueSnapshot().find((row) => row.id === item.id)?.status, 'queued');
  });
}
