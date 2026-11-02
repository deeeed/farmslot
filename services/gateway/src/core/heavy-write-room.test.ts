import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertHeavyWriteRoom,
  HEAVY_WRITE_FLOOR_DEFAULT_GB,
  heavyWriteFloorBytes,
  HeavyWriteRefusedError,
} from './heavy-write-room.js';

const gateway = ['node', 'services/gateway/src/index.ts'];

test('the floor is 50 GB unless configured, and test processes default to none', () => {
  assert.equal(heavyWriteFloorBytes({}, gateway), HEAVY_WRITE_FLOOR_DEFAULT_GB * 1e9);
  assert.equal(heavyWriteFloorBytes({ FARMSLOT_HEAVY_WRITE_FLOOR_GB: '20' }, gateway), 20e9);
  assert.equal(heavyWriteFloorBytes({ FARMSLOT_HEAVY_WRITE_FLOOR_GB: '0' }, gateway), 0);
  assert.equal(heavyWriteFloorBytes({ FARMSLOT_HEAVY_WRITE_FLOOR_GB: 'lots' }, gateway), 50e9);
  assert.equal(heavyWriteFloorBytes({ NODE_TEST_CONTEXT: 'child' }, gateway), 0);
});

test('a heavy write below the floor is refused with the volume, free space and floor', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'heavy-write-room-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // No volume has 100 PB free. The target does not exist yet: its nearest ancestor is measured.
  await assert.rejects(
    assertHeavyWriteRoom(path.join(root, 'tasks/run-1/artifacts'), {
      FARMSLOT_HEAVY_WRITE_FLOOR_GB: '100000000',
    }),
    (error: unknown) =>
      error instanceof HeavyWriteRefusedError &&
      /^Refusing to write .*tasks\/run-1\/artifacts: its volume has [\d.]+ GB free, under the 100000000\.0 GB floor \(FARMSLOT_HEAVY_WRITE_FLOOR_GB\)$/.test(
        error.message,
      ),
  );
  await assertHeavyWriteRoom(path.join(root, 'tasks/run-1/artifacts'), {
    FARMSLOT_HEAVY_WRITE_FLOOR_GB: '0',
  });
});

// Arthur 11-02: heavy data moves to an external drive. If it is unplugged, a missing configured
// root must not be recreated on the internal disk.
test('a configured root on a missing volume refuses writes into it and nowhere else', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'heavy-write-room-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unmounted = path.join(root, 'Volumes/c910ssd/farmslot-data');
  const env = {
    FARMSLOT_HEAVY_WRITE_FLOOR_GB: '0',
    FARMSLOT_RUNS_DIR: path.join(unmounted, 'runs'),
    FARMSLOT_HOME: path.join(unmounted, 'home'),
  };
  for (const [name, target] of [
    ['FARMSLOT_RUNS_DIR', path.join(unmounted, 'runs/session-archives/run-1')],
    ['FARMSLOT_HOME', path.join(unmounted, 'home/run-bundles')],
  ])
    await assert.rejects(
      assertHeavyWriteRoom(target, env),
      new RegExp(
        `Refusing to write .*: ${name} .* is missing and so is its parent \\(is its volume mounted\\?\\)$`,
      ),
    );
  await assertHeavyWriteRoom(path.join(root, 'projects/tasks'), env);
  // Mounted: the root's parent exists, so a root not created yet is created as usual.
  await mkdir(unmounted, { recursive: true });
  await assertHeavyWriteRoom(path.join(unmounted, 'runs/session-archives/run-1'), env);
});
