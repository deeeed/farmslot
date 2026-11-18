import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { RunCreateParams } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'storage-admission-'));
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_TEST_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
for (const dir of ['home', 'runs', 'projects']) await mkdir(path.join(root, dir));
await import('../runtime/mock-pty.test-support.js');
const { GatewayMethodError } = await import('../core/method-error.js');
const storage = await import('../core/storage-volume.js');
let available = false;
mock.module('../core/storage-volume.js', {
  namedExports: {
    ...storage,
    assertGatewayStorageAvailable() {
      if (!available)
        throw new GatewayMethodError(
          'STORAGE_UNAVAILABLE',
          'Storage unavailable: /Volumes/fixture-bundles is not mounted.',
        );
    },
  },
});
const { createRun, deleteRun, getAllRuns, persistRunNow, runsDirectory, updateRun } =
  await import('./store.js');
const { runCreate } = await import('../methods/run.js');
const params: RunCreateParams = {
  project: 'storage-proof',
  flowType: 'dev',
  ticketOrPr: 'FIXTURE-1',
};
after(async () => {
  for (const run of getAllRuns()) {
    updateRun(run.id, { status: 'cancelled' });
    await deleteRun(run.id);
  }
  await rm(root, { recursive: true, force: true });
});
const unavailable = (error: unknown) =>
  error instanceof GatewayMethodError &&
  error.code === 'STORAGE_UNAVAILABLE' &&
  error.message.includes('/Volumes/fixture-bundles');

test('offline bundle storage refuses the API before planning or registering a run', async () => {
  available = false;
  const before = getAllRuns().map((run) => run.id);
  await assert.rejects(
    runCreate(params, () => {}),
    unavailable,
  );
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    before,
  );
  assert.deepEqual(await readdir(runsDirectory()), []);
});

test('record insertion rechecks storage and recovery does not leave a failed run behind', async () => {
  available = false;
  const before = getAllRuns().map((run) => run.id);
  assert.throws(() => createRun(params), unavailable);
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    before,
  );
  assert.deepEqual(await readdir(runsDirectory()), []);
  available = true;
  const run = createRun(params);
  try {
    await persistRunNow(run, 'storage recovery fixture');
    assert.deepEqual(
      getAllRuns().map((value) => value.id),
      [run.id],
    );
    assert((await readdir(runsDirectory())).includes(run.id + '.json'));
  } finally {
    updateRun(run.id, { status: 'cancelled' });
    await deleteRun(run.id);
  }
});
