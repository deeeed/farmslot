import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'native-review-operation-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_RUNS_DIR = path.join(fixture, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(fixture, 'pool');
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(fixture, 'status.json');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'review-operation-owner';
await mkdir(process.env.FARMSLOT_RUNS_DIR, { recursive: true });
await mkdir(process.env.FARMSLOT_POOL_DIR, { recursive: true });

const { createRun, getRun, updateRun, deleteRun, persistRunNow } = await import('../runs/store.js');
const {
  assertNativeReviewOperationCurrent,
  captureNativeReviewOperationCheck,
  withNativeReviewMutation,
  withNativeReviewOperation,
} = await import('./native-review-operation.js');

after(() => rm(fixture, { recursive: true, force: true }));

async function makeRun() {
  const run = createRun(
    {
      flowType: 'dev',
      project: 'native-operation-test',
      ticketOrPr: `TEST-${Date.now()}`,
      slotId: 'operation-slot',
      transport: 'native',
    },
    { nativeOwnerPrincipalId: 'review-operation-owner', deferBackgroundPersist: true },
  );
  await writeFile(
    process.env.FARMSLOT_TEST_STATUS_FILE!,
    JSON.stringify({ slots: [{ slot: 'operation-slot', current_run_id: run.id }] }),
  );
  updateRun(run.id, { status: 'self-reviewing' });
  return getRun(run.id)!;
}

async function removeRun(runId: string) {
  await persistRunNow(updateRun(runId, { status: 'done' }), 'review-operation fixture cleanup');
  await deleteRun(runId);
}

test('a suspended controller cannot adopt the run generation established by replay', async () => {
  const run = await makeRun();
  try {
    await withNativeReviewOperation(run, async () => {
      assertNativeReviewOperationCurrent();
      updateRun(run.id, { engineState: { generation: 1 } });
      await Promise.resolve();
      assert.throws(assertNativeReviewOperationCurrent, /superseded/);
    });
    await withNativeReviewOperation(getRun(run.id)!, async () =>
      assertNativeReviewOperationCurrent(),
    );
  } finally {
    await removeRun(run.id);
  }
});

test('successor file mutations wait for an older in-flight write and the old caller fails closed', async () => {
  const run = await makeRun();
  const events: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const old = withNativeReviewOperation(run, () =>
      withNativeReviewMutation(async () => {
        events.push('old-start');
        entered();
        await hold;
        events.push('old-io-finished');
      }),
    );
    const oldRejected = assert.rejects(old, /superseded/);
    await started;
    updateRun(run.id, { engineState: { generation: 1 } });
    const next = withNativeReviewOperation(getRun(run.id)!, () =>
      withNativeReviewMutation(async () => {
        events.push('new-write');
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['old-start']);
    release();
    await oldRejected;
    await next;
    assert.deepEqual(events, ['old-start', 'old-io-finished', 'new-write']);
  } finally {
    release?.();
    await removeRun(run.id);
  }
});

test('cancellation prevents a delayed nested mutation from changing task state', async () => {
  const run = await makeRun();
  let writes = 0;
  try {
    await assert.rejects(
      withNativeReviewOperation(run, () =>
        withNativeReviewMutation(async () => {
          updateRun(run.id, { status: 'cancelled' });
          await withNativeReviewMutation(async () => {
            writes += 1;
          });
        }),
      ),
      /superseded/,
    );
    assert.equal(writes, 0);
  } finally {
    await removeRun(run.id);
  }
});

test('a remote callback retains its original ownership check outside the async scope', async () => {
  const run = await makeRun();
  try {
    const check = await withNativeReviewOperation(run, async () =>
      captureNativeReviewOperationCheck(),
    );
    assert.equal(check(), true);
    updateRun(run.id, { engineState: { generation: 1 } });
    assert.equal(check(), false);
  } finally {
    await removeRun(run.id);
  }
});
