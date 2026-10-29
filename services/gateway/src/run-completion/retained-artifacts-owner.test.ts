import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const root = await mkdtemp(path.join(tmpdir(), 'retained-runs-only-owner-'));
const runsDir = path.join(root, 'runs');
process.env.FARMSLOT_RUNS_DIR = runsDir;
delete process.env.FARMSLOT_HOME;
delete process.env.FARMSLOT_SANDBOX_HOME;
after(() => rm(root, { recursive: true, force: true }));

// Redirect the fallback home so a regression cannot claim the operator's real store.
const operatorHome = path.join(root, 'operator-home');
await mkdir(path.join(operatorHome, 'run-bundles'), { recursive: true });
await writeFile(path.join(operatorHome, 'run-bundles/sentinel'), 'operator store');
mock.module('@farmslot/protocol/node/farmslot-home', {
  namedExports: { farmslotHome: () => operatorHome },
});

const { archiveRunArtifactHousekeeping, runBundleStore } = await import('./retained-artifacts.js');

test('runs-only gateway boot owns an isolated bundle root and sandboxes cannot rebind it', async () => {
  await runBundleStore(true);
  const owner = await runBundleStore();
  assert.equal(owner.root, await realpath(path.join(runsDir, 'bundle-home/run-bundles')));
  const binding = await readFile(path.join(owner.runsDir, 'bundle-store.json'), 'utf8');
  assert.deepEqual(await readdir(path.join(operatorHome, 'run-bundles')), ['sentinel']);

  process.env.FARMSLOT_SANDBOX_HOME = path.join(root, 'sandbox');
  assert.throws(() => runBundleStore(true), /may only read/);
  await runBundleStore();
  assert.deepEqual(await runBundleStore(), owner);
  assert.equal(await readFile(path.join(owner.runsDir, 'bundle-store.json'), 'utf8'), binding);
});

test('cancelled pre-capture reservations archive instead of exhausting new admission', async () => {
  delete process.env.FARMSLOT_SANDBOX_HOME;
  const archive = path.join(root, 'storage-archive');
  await mkdir(archive);
  process.env.FARMSLOT_RUN_ARCHIVE_ROOT = archive;
  const owner = await runBundleStore(true);
  const { reserveRunBundleMetadata, DEFAULT_RUN_BUNDLE_RETENTION } =
    await import('@farmslot/run-bundle');
  const { createRun, updateRun, persistRunNow, getRunWithArchived } =
    await import('../runs/store.js');
  const first = createRun({
    flowType: 'fix-bug',
    project: 'fixture',
    mode: 'autonomous',
    ticketOrPr: 'META-1',
  });
  await persistRunNow(first);
  const policy = { ...DEFAULT_RUN_BUNDLE_RETENTION, metadataReserveBytes: 1024 ** 2 };
  await reserveRunBundleMetadata(owner, first.id, policy);
  updateRun(first.id, { status: 'cancelled' });
  await persistRunNow(first);
  await archiveRunArtifactHousekeeping();
  const next = createRun({
    flowType: 'fix-bug',
    project: 'fixture',
    mode: 'autonomous',
    ticketOrPr: 'META-2',
  });
  await persistRunNow(next);
  await reserveRunBundleMetadata(owner, next.id, policy);
  assert.ok(
    (await getRunWithArchived(first.id))?.links?.some((link) => link.label === 'Storage archive'),
  );
  const manifest = JSON.parse(
    await readFile(path.join(archive, first.id, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.entries[0].store, 'bundle-reservations');
  assert.equal(JSON.parse(await readFile(manifest.entries[0].destination, 'utf8')).runId, first.id);
});

test('admission with no housekeeping to move needs no archive write', async () => {
  const missing = path.join(root, 'not-provisioned');
  process.env.FARMSLOT_RUN_ARCHIVE_ROOT = missing;
  await archiveRunArtifactHousekeeping();
  await assert.rejects(readFile(missing), /ENOENT/);
});
