import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import type { MonitorViolationPayload } from '@farmslot/protocol';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gateway-bundle-archive-')));
after(() => rm(root, { recursive: true, force: true }));
for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  await mkdir(path.dirname(path.join(root, marker)), { recursive: true });
  await writeFile(path.join(root, marker), marker.endsWith('.json') ? '{}' : '');
}
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_RUN_ARCHIVE_ROOT = path.join(root, 'archive');
process.env.FARMSLOT_COPILOT_DIR = path.join(root, 'copilot');
delete process.env.FARMSLOT_SANDBOX_HOME;
await mkdir(process.env.FARMSLOT_RUN_ARCHIVE_ROOT);

const { Events } = await import('@farmslot/protocol');
const { materializeRunBundle, readRetainedRunBundle, runBundleAdmissionUsage } =
  await import('@farmslot/run-bundle');
const { makeRun } = await import('./test-fixtures.js');
const {
  archiveRunArtifactHousekeeping,
  runBundleStore,
  initializeRunBundleStore,
  warnRunBundleCapacity,
  retainedRunArtifactManifest,
  retainCapturedRunArtifacts,
  reserveRunArtifactMetadata,
} = await import('./retained-artifacts.js');
const { initCopilotObserver, resetCopilotObserverForTests } =
  await import('../chat/copilot-observer.js');

test('hourly housekeeping archives referenced media and publishes capacity and pressure to the board stream', async (t) => {
  const store = await runBundleStore(true);
  const taskDir = path.join(root, 'source');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const body = Buffer.alloc(100_000, 1);
  await writeFile(path.join(taskDir, 'artifacts/proof.png'), body);
  const run = makeRun({ id: 'historical', taskFile: path.join(taskDir, 'TASK.md') });
  await materializeRunBundle({
    store,
    farmslotRoot: root,
    run,
    taskDir,
    artifacts: [
      {
        path: 'artifacts/proof.png',
        purpose: 'screenshot',
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    ],
    captureKey: run.id,
    manifestDigest: run.id,
    commit: async (ref) => {
      run.artifactBundle = ref;
      await writeFile(path.join(store.runsDir, `${run.id}.json`), JSON.stringify(run));
    },
  });
  const ref = run.artifactBundle!;
  const usage = await runBundleAdmissionUsage(store, root);
  const policyPath = path.join(root, 'home/run-bundle-retention.json');
  t.after(() => rm(policyPath, { force: true }));
  await writeFile(
    policyPath,
    JSON.stringify({
      runBundleRetention: {
        maxStoreBytes: usage.total / 0.9,
        maxBundleBytes: 1_000_000,
        metadataReserveBytes: 1,
        mediaRetentionDays: 30,
      },
    }),
  );
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  initCopilotObserver((event, payload) => broadcasts.push({ event, payload }));
  t.after(resetCopilotObserverForTests);
  await warnRunBundleCapacity();
  await archiveRunArtifactHousekeeping();
  for (const type of ['run-bundle.capacity', 'run-bundle.archive-pressure']) {
    assert.ok(
      broadcasts.some(
        ({ event, payload }) =>
          event === Events.MONITOR_VIOLATION &&
          (payload as MonitorViolationPayload).violation.target === type,
      ),
      `${type} reaches board health stream`,
    );
  }
  const retained = await readRetainedRunBundle(store, ref, run.id);
  const media = await retained.resolveEntry('artifacts/proof.png');
  assert.ok(media.path.startsWith(process.env.FARMSLOT_RUN_ARCHIVE_ROOT!));
  assert.deepEqual(await readFile(media.path), body);
  assert.equal((await retainedRunArtifactManifest(run))[0]?.availability, 'available');
  assert.equal(
    JSON.parse(await readFile(path.join(store.runsDir, `${run.id}.json`), 'utf8')).id,
    run.id,
    'run record remains',
  );
});

test('gateway materialization retries admission after archiving old media', async (t) => {
  const store = await runBundleStore(true);
  const taskDir = path.join(root, 'new-task');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const body = Buffer.alloc(11_000, 2);
  await writeFile(path.join(taskDir, 'artifacts/proof.png'), body);
  const run = makeRun({ id: 'fresh-proof', taskFile: path.join(taskDir, 'TASK.md') });
  // Keep a referenced historical capture eligible for pressure relief.
  await materializeRunBundle({
    store,
    farmslotRoot: root,
    run: { ...run, id: 'old-proof' },
    taskDir,
    artifacts: [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
    captureKey: 'old-proof',
    manifestDigest: 'old-proof',
    commit: async (ref) => {
      await writeFile(
        path.join(store.runsDir, 'old-proof.json'),
        JSON.stringify({ ...run, id: 'old-proof', artifactBundle: ref }),
      );
    },
  });
  const usage = await runBundleAdmissionUsage(store, root);
  const policyPath = path.join(root, 'home/run-bundle-retention.json');
  t.after(() => rm(policyPath, { force: true }));
  await writeFile(
    policyPath,
    JSON.stringify({
      runBundleRetention: {
        maxStoreBytes: usage.total + 20_000,
        maxBundleBytes: 1_000_000,
        metadataReserveBytes: 10_000,
        mediaRetentionDays: 30,
      },
    }),
  );
  const captured = await retainCapturedRunArtifacts({
    run,
    artifacts: [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
    manifestDigest: 'fresh-proof',
    commit: async (ref) => {
      await writeFile(
        path.join(store.runsDir, `${run.id}.json`),
        JSON.stringify({ ...run, artifactBundle: ref }),
      );
    },
  });
  assert.deepEqual(captured.missingData, []);
  const retained = await readRetainedRunBundle(store, captured.ref, run.id);
  assert.deepEqual(await readFile((await retained.resolveEntry('artifacts/proof.png')).path), body);
});

test('an unavailable configured store pauses capture, warns the board and leaves runs free to continue', async (t) => {
  const missing = path.join(root, 'missing-volume', 'store');
  const config = path.join(root, 'home/run-bundle-retention.json');
  t.after(() => rm(config, { force: true }));
  await writeFile(config, JSON.stringify({ runBundleRetention: { storeRoot: missing } }));
  const { gatewayStorageRoots } = await import('../core/storage-volume.js');
  assert.ok(gatewayStorageRoots().includes(missing), 'volume health watches the configured store');
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  initCopilotObserver((event, payload) => broadcasts.push({ event, payload }));
  t.after(resetCopilotObserverForTests);
  await warnRunBundleCapacity();
  await initializeRunBundleStore();
  await reserveRunArtifactMetadata(makeRun({ id: 'continue-without-volume' }));
  await assert.rejects(
    retainCapturedRunArtifacts({
      run: makeRun({ id: 'capture-without-volume', taskFile: path.join(root, 'new-task/TASK.md') }),
      artifacts: [],
      manifestDigest: 'missing-volume',
      commit: async () => assert.fail('capture must pause'),
    }),
    /missing|mounted/,
  );
  assert.ok(
    broadcasts.some(
      ({ event, payload }) =>
        event === Events.MONITOR_VIOLATION &&
        (payload as MonitorViolationPayload).violation.target === 'run-bundle.capacity',
    ),
  );
  await assert.rejects(realpath(path.dirname(missing)), { code: 'ENOENT' });
});

test('startup and pairing stay available below the floor while capture refuses and warns', async (t) => {
  const previousFloor = process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB;
  process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB = '100000000000';
  t.after(() => {
    if (previousFloor === undefined) delete process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB;
    else process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB = previousFloor;
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  initCopilotObserver((event, payload) => broadcasts.push({ event, payload }));
  t.after(resetCopilotObserverForTests);
  const owner = await runBundleStore(true);
  await initializeRunBundleStore();
  assert.deepEqual(await runBundleStore(), owner);
  await reserveRunArtifactMetadata(makeRun({ id: 'dispatch-below-floor' }));
  const source = path.join(root, 'new-task/artifacts/proof.png');
  const before = await readFile(source);
  await assert.rejects(
    retainCapturedRunArtifacts({
      run: makeRun({ id: 'capture-below-floor', taskFile: path.join(root, 'new-task/TASK.md') }),
      artifacts: [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
      manifestDigest: 'below-floor',
      commit: async () => assert.fail('capture must pause'),
    }),
    /floor/,
  );
  assert.deepEqual(await readFile(source), before);
  assert.ok(
    broadcasts.some(
      ({ event, payload }) =>
        event === Events.MONITOR_VIOLATION &&
        (payload as MonitorViolationPayload).violation.target === 'run-bundle.capacity' &&
        (payload as MonitorViolationPayload).violation.message.includes('floor'),
    ),
    'capture refusal reaches the board stream',
  );
});

test('housekeeping refuses an archive destination below its floor and warns without moving media', async (t) => {
  const store = await runBundleStore(true);
  const run = makeRun({ id: 'archive-floor', taskFile: path.join(root, 'new-task/TASK.md') });
  const saved = await materializeRunBundle({
    store,
    farmslotRoot: root,
    run,
    taskDir: path.dirname(run.taskFile!),
    artifacts: [{ path: 'artifacts/proof.png', purpose: 'screenshot' }],
    manifestDigest: run.id,
    captureKey: run.id,
    commit: async (ref) => {
      run.artifactBundle = ref;
      await writeFile(path.join(store.runsDir, `${run.id}.json`), JSON.stringify(run));
    },
  });
  const bundle = await readRetainedRunBundle(store, saved.ref, run.id);
  const source = path.join(bundle.taskDir, 'artifacts/proof.png');
  const before = await readFile(source);
  const config = path.join(root, 'home/run-bundle-retention.json');
  await writeFile(config, JSON.stringify({ runBundleRetention: { mediaRetentionDays: 0 } }));
  t.after(() => rm(config, { force: true }));
  const previousFloor = process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB;
  process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB = '100000000000';
  t.after(() => {
    if (previousFloor === undefined) delete process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB;
    else process.env.FARMSLOT_HEAVY_WRITE_FLOOR_GB = previousFloor;
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  initCopilotObserver((event, payload) => broadcasts.push({ event, payload }));
  t.after(resetCopilotObserverForTests);
  await assert.rejects(archiveRunArtifactHousekeeping(), /floor/);
  assert.deepEqual(await readFile(source), before);
  assert.equal((await bundle.resolveEntry('artifacts/proof.png')).path, source);
  assert.ok(
    broadcasts.some(
      ({ event, payload }) =>
        event === Events.MONITOR_VIOLATION &&
        (payload as MonitorViolationPayload).violation.target === 'run-bundle.capacity' &&
        (payload as MonitorViolationPayload).violation.message.includes(
          process.env.FARMSLOT_RUN_ARCHIVE_ROOT!,
        ),
    ),
    'the refusal names the archive destination',
  );
});

test('heavy-write admission reserves the migration copy bytes above the free-space floor', async () => {
  const { assertHeavyWriteRoom } = await import('../core/heavy-write-room.js');
  await assert.rejects(
    assertHeavyWriteRoom(root, { FARMSLOT_HEAVY_WRITE_FLOOR_GB: '0' }, Number.MAX_SAFE_INTEGER),
    /floor/,
  );
});

test('the supported migration CLI prints its verified store and retained backup on temporary roots', async () => {
  const home = path.join(root, 'cli-home');
  const runsDir = path.join(root, 'cli-runs');
  const { openRunBundleStore } = await import('@farmslot/run-bundle');
  const store = await openRunBundleStore({ home, runsDir, create: true });
  const target = path.join(root, 'cli-target');
  const { runBundleMigrationCommand } = await import('../../scripts/run-bundle-migrate.js');
  const output: string[] = [];
  await runBundleMigrationCommand(
    ['--home', home, '--runs-dir', runsDir, '--target', target],
    (line) => output.push(line),
  );
  assert.equal(
    `${output.join('\n')}\n`,
    `Verified bundles: 0\nRun bundle store: ${target}\nRetained backup (not deleted): ${store.root}\n`,
  );
  assert.equal((await openRunBundleStore({ home, runsDir })).root, target);
  assert.equal(
    JSON.parse(await readFile(path.join(store.root, 'store.json'), 'utf8')).root,
    store.root,
  );
});
