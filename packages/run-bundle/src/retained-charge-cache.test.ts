import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { ArtifactRef, Run } from '@farmslot/protocol';

import {
  collectRunBundleGarbage,
  DEFAULT_RUN_BUNDLE_RETENTION,
  forgetRunBundleStoreChargeCache,
  materializeRunBundle,
  type MaterializeRunBundleRequest,
  openRunBundleStore,
  runBundleAdmissionUsage,
  runBundleStableChargeWalks,
  type RunBundleStore,
} from './retained.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-charge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openRunBundleStore({
    runsDir: path.join(root, '.runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  let housekeeping = 0;
  const capture = async (id: string, extra: Partial<MaterializeRunBundleRequest> = {}) => {
    const taskDir = path.join(root, 'projects/demo/tasks/qa', id);
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    const artifacts: ArtifactRef[] = [];
    for (const [name, body] of Object.entries({
      'report.html': `<h1>${id}</h1>`,
      'capture.mp4': `video bytes of ${id}`,
    })) {
      await writeFile(path.join(taskDir, 'artifacts', name), body);
      artifacts.push({
        path: `artifacts/${name}`,
        purpose: name === 'report.html' ? 'report' : 'video',
        sha256: createHash('sha256').update(body).digest('hex'),
        sizeBytes: Buffer.byteLength(body),
      });
    }
    const run: Run = {
      id,
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
      createdAt: '2026-11-25T00:00:00.000Z',
      updatedAt: '2026-11-25T00:00:00.000Z',
    };
    return materializeRunBundle({
      store,
      farmslotRoot: root,
      run,
      taskDir,
      artifacts,
      manifestDigest: `inventory-${id}`,
      captureKey: `generation-1:inventory-${id}`,
      housekeepBeforeCapture: async () => {
        housekeeping += 1;
      },
      commit: async () => undefined,
      ...extra,
    });
  };
  return { root, store, capture, housekeepingCalls: () => housekeeping };
}

/** The charge as a cold walk computes it, then the cache back as it was for the next read. */
async function freshCharge(store: RunBundleStore, root: string): Promise<number> {
  forgetRunBundleStoreChargeCache();
  return (await runBundleAdmissionUsage(store, root)).store;
}

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

test('a capture below the archive threshold runs no housekeeping and walks the stable charge at most once', async (t) => {
  const f = await fixture(t);
  await f.capture(ids[0]);
  // Captures on a farm are minutes apart; a walk this close to a change is not kept.
  await delay(30);
  const walks = runBundleStableChargeWalks();
  await f.capture(ids[1]);
  // Before: every capture ran full housekeeping and walked the whole store 2-4 times.
  assert.equal(f.housekeepingCalls(), 0);
  // Publishing the bundle renames it into sha256/, which a later read must see.
  assert.ok(
    runBundleStableChargeWalks() - walks <= 1,
    `${runBundleStableChargeWalks() - walks} walks`,
  );
});

test('the cached store charge equals a cold walk after captures, an outside write and GC', async (t) => {
  const f = await fixture(t);
  await f.capture(ids[0]);
  const afterCapture = (await runBundleAdmissionUsage(f.store, f.root)).store;
  assert.equal(afterCapture, await freshCharge(f.store, f.root));

  // A writer outside this cache (another gateway, a restore) changes a stamped directory.
  await runBundleAdmissionUsage(f.store, f.root);
  const walks = runBundleStableChargeWalks();
  await writeFile(path.join(f.store.root, 'availability', 'outside.json'), 'x'.repeat(5000));
  const afterOutside = (await runBundleAdmissionUsage(f.store, f.root)).store;
  assert.equal(runBundleStableChargeWalks() - walks, 1);
  assert.equal(afterOutside, afterCapture + 5000);
  assert.equal(afterOutside, await freshCharge(f.store, f.root));

  // A retention finish outside the lock removes a bundle moved aside as `.retention-*`.
  const retention = path.join(f.store.root, 'sha256', '.retention-outside');
  await mkdir(retention, { recursive: true });
  await writeFile(path.join(retention, 'payload'), 'y'.repeat(3000));
  assert.equal(
    (await runBundleAdmissionUsage(f.store, f.root)).store,
    await freshCharge(f.store, f.root),
  );
  await f.capture(ids[1]);
  await rm(retention, { recursive: true });
  assert.equal(
    (await runBundleAdmissionUsage(f.store, f.root)).store,
    await freshCharge(f.store, f.root),
  );
  await collectRunBundleGarbage(f.store);
  assert.equal(
    (await runBundleAdmissionUsage(f.store, f.root)).store,
    await freshCharge(f.store, f.root),
  );
});

test('a capture at the archive threshold runs housekeeping first, and one below it does not', async (t) => {
  const f = await fixture(t);
  await f.capture(ids[0]);
  // Fill the store to 1 MB, then cap it so that is about 90% while a small capture still fits.
  await writeFile(path.join(f.store.root, 'availability', 'filler.json'), 'x'.repeat(1_000_000));
  const stored = (await runBundleAdmissionUsage(f.store, f.root)).store;
  const policy = {
    ...DEFAULT_RUN_BUNDLE_RETENTION,
    metadataReserveBytes: 1024,
    maxStoreBytes: Math.ceil(stored / 0.9),
  };
  await f.capture(ids[1], { policy });
  assert.equal(f.housekeepingCalls(), 1);
  await f.capture(ids[2], { policy: { ...policy, maxStoreBytes: stored * 4 } });
  assert.equal(f.housekeepingCalls(), 1);
});
