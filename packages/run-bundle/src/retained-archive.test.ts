import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Run, RunBundleRetentionPolicy } from '@farmslot/protocol';

import { exportRunsToBundle } from './export.js';
import * as bundles from './retained.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bundle-media-archive-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archiveRoot = path.join(root, 'archive');
  await mkdir(archiveRoot);
  const store = await bundles.openRunBundleStore({
    runsDir: path.join(root, '.runs'),
    home: path.join(root, 'home'),
    create: true,
  });
  const capture = async (
    id: string,
    size: number,
    options: Pick<bundles.MaterializeRunBundleRequest, 'archiveRoot' | 'policy'> = {},
  ) => {
    const taskDir = path.join(root, 'sources', id);
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    const body = Buffer.alloc(size, id.charCodeAt(0));
    await writeFile(path.join(taskDir, 'artifacts/proof.png'), body);
    await writeFile(path.join(taskDir, 'TASK.md'), '# Evidence task\n');
    const run: Run = {
      id,
      familyId: id,
      lane: 'production',
      flowType: 'qa',
      mode: 'validation',
      status: 'done',
      project: 'demo',
      ticketOrPr: 'TAT-4520',
      slotId: null,
      branch: null,
      taskFile: path.join(taskDir, 'TASK.md'),
      steps: [],
      decisions: [],
      metrics: { nudgeCount: 0, model: 'scripted', runner: 'scripted' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const request: bundles.MaterializeRunBundleRequest = {
      store,
      farmslotRoot: root,
      run,
      taskDir,
      artifacts: [
        { path: 'TASK.md', purpose: 'task-input' },
        {
          path: 'artifacts/proof.png',
          purpose: 'screenshot',
          sizeBytes: size,
          sha256: createHash('sha256').update(body).digest('hex'),
        },
      ],
      captureKey: id,
      manifestDigest: id,
      commit: async (ref) => {
        run.artifactBundle = ref;
        await writeFile(path.join(store.runsDir, `${id}.json`), JSON.stringify(run));
      },
      ...options,
    };
    const result = await bundles.materializeRunBundle(request);
    return {
      run,
      request,
      result,
      body,
      bundle: await bundles.readRetainedRunBundle(store, result.ref, id),
    };
  };
  const archive = (policy: RunBundleRetentionPolicy, now = Date.now()) =>
    bundles.archiveRunBundleMedia({ store, farmslotRoot: root, archiveRoot, policy, now });
  return { root, store, archiveRoot, capture, archive };
}

test('f3f48aa8: admission archives oldest referenced media and retains the new proof in the same capture', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const oldest = await f.capture('oldest', 500_000);
  t.mock.timers.tick(1);
  const newer = await f.capture('newer', 500_000);
  // Archived runs still reference their media. Task trees and reservations also charge admission.
  await mkdir(path.join(f.store.runsDir, 'archive'));
  await writeFile(path.join(f.store.runsDir, 'archive/oldest.json'), JSON.stringify(oldest.run));
  await rm(path.join(f.store.runsDir, 'oldest.json'));
  await mkdir(path.join(f.root, '.sandbox/tasks'), { recursive: true });
  await writeFile(path.join(f.root, '.sandbox/tasks/historical.mp4'), Buffer.alloc(180_000));
  await bundles.reserveRunBundleMetadata(f.store, 'active-reservation', {
    ...bundles.DEFAULT_RUN_BUNDLE_RETENTION,
    metadataReserveBytes: 4_000,
  });
  const before = await bundles.runBundleAdmissionUsage(f.store, f.root);
  const policy = {
    maxStoreBytes: Math.ceil(before.total / 0.9915),
    maxBundleBytes: 2_000_000,
    metadataReserveBytes: Math.ceil(before.total * 0.0125),
    mediaRetentionDays: 30,
  };
  const manifest = await readFile(path.join(oldest.bundle.directory, 'manifest.json'));
  const fresh = await f.capture('f3f48aa8', 11_000, { policy, archiveRoot: f.archiveRoot });
  assert.deepEqual(fresh.result.missingData, [], 'small new proof must not get media-capacity');
  assert.deepEqual(
    await readFile((await fresh.bundle.resolveEntry('artifacts/proof.png')).path),
    fresh.body,
  );
  const moved = await oldest.bundle.resolveEntry('artifacts/proof.png');
  assert.ok(moved.path.startsWith(f.archiveRoot + path.sep), 'oldest media moved to archive');
  assert.deepEqual(await readFile(moved.path), oldest.body);
  await assert.rejects(stat(path.join(oldest.bundle.taskDir, 'artifacts/proof.png')), {
    code: 'ENOENT',
  });
  assert.equal(
    (await newer.bundle.resolveEntry('artifacts/proof.png')).path,
    path.join(newer.bundle.taskDir, 'artifacts/proof.png'),
  );
  assert.deepEqual(await readFile(path.join(oldest.bundle.directory, 'manifest.json')), manifest);
  assert.equal(await oldest.bundle.readText('TASK.md'), '# Evidence task\n');
  assert.ok(
    (await bundles.runBundleAdmissionUsage(f.store, f.root)).total <= policy.maxStoreBytes * 0.7,
  );
  const usage = JSON.parse(
    await readFile(
      path.join(f.store.root, 'usage', `${oldest.result.ref.bundleDigest}.json`),
      'utf8',
    ),
  );
  assert.ok(usage.bytes < 500_000, 'recorded bundle bytes follow the move');
});

test('hourly pressure relief uses admission total and stops at the low water mark', async (t) => {
  const f = await fixture(t);
  const first = await f.capture('first', 120_000);
  const second = await f.capture('second', 120_000);
  const usage = await bundles.runBundleAdmissionUsage(f.store, f.root);
  const policy = {
    maxStoreBytes: usage.total / 0.84,
    maxBundleBytes: 1_000_000,
    metadataReserveBytes: 1,
    mediaRetentionDays: 30,
  };
  assert.equal((await f.archive(policy)).reclaimedBytes, 0);
  await mkdir(path.join(f.root, '.sandbox/tasks'), { recursive: true });
  await writeFile(path.join(f.root, '.sandbox/tasks/acquisition.mp4'), Buffer.alloc(10_000));
  const result = await f.archive(policy);
  assert.ok(result.reclaimedBytes >= 120_000);
  assert.ok(
    (await bundles.runBundleAdmissionUsage(f.store, f.root)).total <= policy.maxStoreBytes * 0.7,
  );
  assert.ok(
    (await first.bundle.resolveEntry('artifacts/proof.png')).path.startsWith(f.archiveRoot),
  );
  assert.ok(
    (await second.bundle.resolveEntry('artifacts/proof.png')).path.startsWith(f.store.root),
  );
});

test('age retention archives media and cold readers resolve it without the source task', async (t) => {
  const f = await fixture(t);
  const saved = await f.capture('expired', 10_000);
  const future = Date.now() + 31 * 86_400_000;
  await bundles.collectRunBundleGarbage(f.store, undefined, future, {
    archiveRoot: f.archiveRoot,
    farmslotRoot: f.root,
  });
  await rm(saved.request.taskDir, { recursive: true });
  const reopened = await bundles.openRunBundleStore({
    runsDir: f.store.runsDir,
    home: path.join(f.root, 'home'),
  });
  const bundle = await bundles.readRetainedRunBundle(reopened, saved.result.ref, saved.run.id);
  const entry = await bundle.resolveEntry('artifacts/proof.png');
  assert.ok(entry.path.startsWith(f.archiveRoot));
  assert.deepEqual(await readFile(entry.path), saved.body);
  const availability = await bundles.readRunBundleAvailability(
    reopened,
    saved.result.ref,
    saved.run.id,
  );
  assert.deepEqual(availability.prunedPaths, []);
  assert.equal(
    availability.archivedPaths?.[`tasks/${saved.run.id}/artifacts/proof.png`],
    entry.path,
  );
  assert.ok(availability.revision > 0);
  const replay = await bundles.materializeRunBundle(saved.request);
  assert.deepEqual(replay.missingData, []);
  assert.deepEqual(replay.ref, saved.result.ref);
});

test('expiry without an archive leaves history in the store', async (t) => {
  const f = await fixture(t);
  const saved = await f.capture('no-archive', 10_000);
  await bundles.collectRunBundleGarbage(f.store, undefined, Date.now() + 31 * 86_400_000);
  assert.deepEqual(
    await readFile((await saved.bundle.resolveEntry('artifacts/proof.png')).path),
    saved.body,
  );
});

test('pressure and age leave live runs and pending decision pins intact', async (t) => {
  const f = await fixture(t);
  const active = await f.capture('active', 10_000);
  active.run.status = 'monitoring';
  const pinned = await f.capture('pinned', 10_000);
  pinned.run.decisions.push({
    id: 'review',
    type: 'engine_output_review',
    title: 'Review',
    description: '',
    actions: [],
    createdAt: pinned.run.createdAt,
    payload: {
      kind: 'output-review',
      manifestDigest: 'pinned',
      reportPath: 'artifacts/proof.png',
      artifactBundle: pinned.result.ref,
    },
  });
  for (const saved of [active, pinned])
    await writeFile(path.join(f.store.runsDir, `${saved.run.id}.json`), JSON.stringify(saved.run));
  const result = await f.archive({
    maxStoreBytes: 100,
    maxBundleBytes: 100_000,
    metadataReserveBytes: 1,
    mediaRetentionDays: 0,
  });
  assert.equal(result.reclaimedBytes, 0);
  for (const saved of [active, pinned])
    assert.deepEqual(
      await readFile(path.join(saved.bundle.taskDir, 'artifacts/proof.png')),
      saved.body,
    );
});

test('an unavailable archive cannot delete media or claim it was archived', async (t) => {
  const f = await fixture(t);
  const saved = await f.capture('unavailable', 10_000);
  await rm(f.archiveRoot, { recursive: true });
  await assert.rejects(
    f.archive({
      maxStoreBytes: 100,
      maxBundleBytes: 100_000,
      metadataReserveBytes: 1,
      mediaRetentionDays: 0,
    }),
    /ENOENT|archive/i,
  );
  assert.deepEqual(
    await readFile(path.join(saved.bundle.taskDir, 'artifacts/proof.png')),
    saved.body,
  );
  assert.deepEqual(
    (await bundles.readRunBundleAvailability(f.store, saved.result.ref, saved.run.id)).prunedPaths,
    [],
  );
});

test('interrupted source removal keeps a durable verified location and retries repair accounting', async (t) => {
  const f = await fixture(t);
  const saved = await f.capture('interrupted', 10_000);
  const source = path.join(saved.bundle.taskDir, 'artifacts/proof.png');
  const remove = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === source) throw new Error('interrupted after archive journal');
    return remove(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const policy = {
    maxStoreBytes: 100,
    maxBundleBytes: 100_000,
    metadataReserveBytes: 1,
    mediaRetentionDays: 0,
  };
  await assert.rejects(f.archive(policy), /interrupted after archive journal/);
  const availability = await bundles.readRunBundleAvailability(
    f.store,
    saved.result.ref,
    saved.run.id,
  );
  const archived = availability.archivedPaths?.[`tasks/${saved.run.id}/artifacts/proof.png`];
  assert.ok(archived);
  assert.deepEqual(await readFile(archived), saved.body);
  assert.deepEqual(await readFile(source), saved.body);
  mocked.mock.restore();
  syncBuiltinESMExports();
  // The crash may happen after unlink but before updating the bundle byte record.
  await rm(source);
  const before = await bundles.runBundleAdmissionUsage(f.store, f.root);
  await f.archive(policy);
  const after = await bundles.runBundleAdmissionUsage(f.store, f.root);
  assert.equal(before.total - after.total, saved.body.length);
  assert.equal((await saved.bundle.resolveEntry('artifacts/proof.png')).path, archived);
  await chmod(archived, 0o600);
  await writeFile(archived, Buffer.alloc(saved.body.length, 9));
  await assert.rejects(saved.bundle.resolveEntry('artifacts/proof.png'), /archive bytes changed/);
});

test('portable exports include media that has moved to the run archive', async (t) => {
  const f = await fixture(t);
  const saved = await f.capture('portable', 10_000);
  await f.archive({ ...bundles.DEFAULT_RUN_BUNDLE_RETENTION, mediaRetentionDays: 0 });
  const exported = await exportRunsToBundle({
    farmslotRoot: f.root,
    runIds: [saved.run.id],
    profile: 'reference',
    outputPath: path.join(f.root, 'history.farmrun'),
  });
  assert.deepEqual(exported.manifest.missingData ?? [], []);
  assert.ok(exported.manifest.entries[`tasks/${saved.run.id}/artifacts/proof.png`]);
});

test('archival waits for the store lock and rechecks active pins before moving media', async (t) => {
  const f = await fixture(t);
  const saved = await f.capture('newly-active', 10_000);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = bundles.withRunBundleStoreLock(f.store, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await held;
  const archival = f.archive({ ...bundles.DEFAULT_RUN_BUNDLE_RETENTION, mediaRetentionDays: 0 });
  try {
    saved.run.status = 'monitoring';
    await writeFile(path.join(f.store.runsDir, `${saved.run.id}.json`), JSON.stringify(saved.run));
  } finally {
    release();
    await hold;
  }
  assert.equal((await archival).reclaimedBytes, 0);
  assert.deepEqual(
    await readFile(path.join(saved.bundle.taskDir, 'artifacts/proof.png')),
    saved.body,
  );
});

test('when all history is pinned, admission preserves the source and fails instead of returning incomplete evidence', async (t) => {
  const f = await fixture(t);
  const pinned = await f.capture('live', 100_000);
  pinned.run.status = 'monitoring';
  await writeFile(path.join(f.store.runsDir, `${pinned.run.id}.json`), JSON.stringify(pinned.run));
  const usage = await bundles.runBundleAdmissionUsage(f.store, f.root);
  await assert.rejects(
    f.capture('retry-later', 11_000, {
      archiveRoot: f.archiveRoot,
      policy: {
        maxStoreBytes: usage.total + 20_000,
        maxBundleBytes: 1_000_000,
        metadataReserveBytes: 10_000,
        mediaRetentionDays: 30,
      },
    }),
    bundles.RunBundleCapacityError,
  );
  assert.equal(
    (await readFile(path.join(f.root, 'sources/retry-later/artifacts/proof.png'))).length,
    11_000,
  );
  assert.deepEqual(
    await readFile(path.join(pinned.bundle.taskDir, 'artifacts/proof.png')),
    pinned.body,
  );
});
