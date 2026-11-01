import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

const root = await fs.mkdtemp(path.join(tmpdir(), 'retained-footprints-'));
after(() => fs.rm(root, { recursive: true, force: true }));
let stalled: Promise<void> | undefined;
let entered: (() => void) | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      // Hold the first footprint save at its rename, after its snapshot was written.
      if (String(args[1]).endsWith('acquisition-footprints.json') && stalled) {
        const wait = stalled;
        stalled = undefined;
        entered?.();
        await wait;
      }
      return fs.rename(...args);
    },
  },
});
const { forgetAcquisitionFootprints, materializeRunBundle, openRunBundleStore } =
  await import('./retained.js');

test('a forget queued behind an earlier save is never overwritten by it', async () => {
  const store = await openRunBundleStore({
    runsDir: path.join(root, '.runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  const settledDir = path.join(root, 'projects/demo/tasks/qa/ended');
  await fs.mkdir(settledDir, { recursive: true });
  await fs.writeFile(path.join(settledDir, 'TASK.md'), 'task');
  const taskDir = path.join(root, 'capture');
  await fs.mkdir(taskDir, { recursive: true });
  const run: Run = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    familyId: 'family',
    lane: 'production',
    flowType: 'qa',
    mode: 'validation',
    completionPolicy: 'artifact-only',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'QA',
    slotId: null,
    branch: null,
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'scripted', runner: 'scripted' },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  let release!: () => void;
  stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const capture = materializeRunBundle({
    store,
    farmslotRoot: root,
    run,
    taskDir,
    artifacts: [],
    manifestDigest: 'inventory',
    captureKey: 'capture',
    acquisitionTaskDirs: async () => (directory) =>
      directory === settledDir ? 'ended@1' : undefined,
    commit: async () => undefined,
  });
  await saving;
  // The scan's save, which still holds the dir, is stalled at its rename.
  const forgotten = forgetAcquisitionFootprints(store, [settledDir]);
  // Unserialized, the forget's own save lands now; serialized, it waits for the stalled one.
  await Promise.race([forgotten, new Promise((resolve) => setTimeout(resolve, 50))]);
  release();
  await Promise.all([capture, forgotten]);
  const kept = JSON.parse(
    await fs.readFile(path.join(store.root, 'usage', 'acquisition-footprints.json'), 'utf8'),
  ) as { dirs: object };
  assert.deepEqual(kept.dirs, {});
});
