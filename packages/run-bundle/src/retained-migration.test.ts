import assert from 'node:assert/strict';
import fs, {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import lockfile from 'proper-lockfile';

import type { Run } from '@farmslot/protocol';

import * as bundles from './retained.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bundle-migrate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const runsDir = path.join(root, 'runs');
  const store = await bundles.openRunBundleStore({ home, runsDir, create: true });
  const config = path.join(home, 'run-bundle-retention.json');
  await writeFile(
    config,
    JSON.stringify({ other: true, runBundleRetention: { maxStoreBytes: 123456 } }),
  );
  const taskDir = path.join(root, 'task');
  await mkdir(taskDir);
  await writeFile(path.join(taskDir, 'TASK.md'), 'retained proof');
  const run: Run = {
    id: 'migration',
    familyId: 'migration',
    lane: 'production',
    flowType: 'qa',
    mode: 'validation',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'DEMO-1',
    slotId: null,
    branch: null,
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'scripted', runner: 'scripted' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const captured = await bundles.materializeRunBundle({
    store,
    farmslotRoot: root,
    run,
    taskDir,
    artifacts: [{ path: 'TASK.md', purpose: 'task-input' }],
    captureKey: 'migration',
    manifestDigest: 'migration',
    commit: async (ref) => {
      run.artifactBundle = ref;
    },
  });
  const targetRoot = path.join(root, 'external-store');
  const request = { home, runsDir, targetRoot, assertWriteRoom: async () => {} };
  return { root, home, runsDir, store, config, captured, targetRoot, request };
}

test('configured roots use realpath, expand tilde, retain default pairing and reject a different root', async (t) => {
  const f = await fixture(t);
  const configured = path.join(f.root, 'configured');
  const runsDir = path.join(f.root, 'configured-runs');
  const store = await bundles.openRunBundleStore({
    home: f.home,
    runsDir,
    storeRoot: configured,
    create: true,
  });
  assert.equal(store.root, configured);
  const alias = path.join(f.root, 'alias');
  await symlink(configured, alias);
  assert.deepEqual(
    await bundles.openRunBundleStore({ home: f.home, runsDir, storeRoot: alias }),
    store,
  );
  await assert.rejects(
    bundles.openRunBundleStore({ home: f.home, runsDir, storeRoot: f.store.root }),
    /configured root/,
  );
  assert.equal(bundles.runBundleRetentionSettings(f.home).storeRoot, undefined);
  await writeFile(
    f.config,
    JSON.stringify({ runBundleRetention: { storeRoot: '~/bundle-test-only' } }),
  );
  assert.equal(
    bundles.runBundleRetentionSettings(f.home).storeRoot,
    path.join(homedir(), 'bundle-test-only'),
  );
  await writeFile(
    f.config,
    JSON.stringify({ runBundleRetention: { storeRoot: 'relative/store' } }),
  );
  assert.throws(() => bundles.runBundleRetentionSettings(f.home), /absolute/);
});

test('a configured root with a missing parent is never recreated', async (t) => {
  const f = await fixture(t);
  const storeRoot = path.join(f.root, 'unmounted', 'store');
  await assert.rejects(
    bundles.openRunBundleStore({
      home: f.home,
      runsDir: path.join(f.root, 'missing-runs'),
      storeRoot,
      create: true,
    }),
    /missing|mounted/,
  );
  await assert.rejects(readFile(path.join(f.root, 'missing-runs/bundle-store.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(realpath(path.dirname(storeRoot)), { code: 'ENOENT' });
});

test('migration copies the whole store, verifies bundles, switches config and binding and keeps the backup', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.store.root, 'extra.json'), 'whole store');
  const result = await bundles.migrateRunBundleStore(f.request);
  assert.equal(result.backupRoot, f.store.root);
  assert.equal(result.store.root, f.targetRoot);
  assert.equal(result.store.id, f.store.id);
  assert.equal(await readFile(path.join(f.targetRoot, 'extra.json'), 'utf8'), 'whole store');
  assert.equal(await readFile(path.join(f.store.root, 'extra.json'), 'utf8'), 'whole store');
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), {
    other: true,
    runBundleRetention: { maxStoreBytes: 123456, storeRoot: f.targetRoot },
  });
  assert.deepEqual(
    await bundles.openRunBundleStore({ home: f.home, runsDir: f.runsDir }),
    result.store,
  );
  const retained = await bundles.readRetainedRunBundle(result.store, f.captured.ref, 'migration');
  assert.equal(await retained.readText('TASK.md'), 'retained proof');
  assert.deepEqual(await bundles.migrateRunBundleStore(f.request), result);
  await assert.rejects(
    bundles.withRunBundleStoreLock(f.store, async () => assert.fail('stale store acquired lock')),
    /pairing changed/,
  );
});

test('migration resumes an interrupted copy and refuses an unrelated nonempty destination', async (t) => {
  const f = await fixture(t);
  await mkdir(f.targetRoot);
  await writeFile(path.join(f.targetRoot, 'unrelated'), 'keep');
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /empty|different|unrelated/);
  await rm(f.targetRoot, { recursive: true });
  const original = fs.copyFile;
  const mocked = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    if (String(args[0]).endsWith('TASK.md')) throw new Error('interrupted copy');
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /interrupted copy/);
  assert.equal(
    (await bundles.openRunBundleStore({ home: f.home, runsDir: f.runsDir })).root,
    f.store.root,
  );
  mocked.mock.restore();
  syncBuiltinESMExports();
  assert.equal((await bundles.migrateRunBundleStore(f.request)).store.root, f.targetRoot);
});

test('a verified switch interrupted between config and binding recovers before any reader opens', async (t) => {
  const f = await fixture(t);
  const original = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === path.join(f.runsDir, 'bundle-store.json'))
      throw new Error('interrupted switch');
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /interrupted switch/);
  mocked.mock.restore();
  syncBuiltinESMExports();
  await assert.rejects(
    bundles.withRunBundleStoreLock(f.store, async () =>
      assert.fail('verified migration fenced the backup'),
    ),
    /pairing changed/,
  );
  const store = await bundles.openRunBundleStore({ home: f.home, runsDir: f.runsDir });
  assert.equal(store.root, f.targetRoot);
  assert.equal(bundles.runBundleRetentionSettings(f.home).storeRoot, f.targetRoot);
  assert.equal((await bundles.migrateRunBundleStore(f.request)).backupRoot, f.store.root);
});

test('migration refuses corrupt manifest entries or recorded bytes without switching', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.store.root, 'sha256', f.captured.ref.bundleDigest);
  const payload = path.join(directory, 'tasks/migration/TASK.md');
  await chmod(payload, 0o600);
  await writeFile(payload, 'changed proof!');
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /verif|bytes|digest/);
  assert.equal(bundles.runBundleRetentionSettings(f.home).storeRoot, undefined);
  await writeFile(payload, 'retained proof');
  const usage = path.join(f.store.root, 'usage', `${f.captured.ref.bundleDigest}.json`);
  await writeFile(usage, JSON.stringify({ bytes: 1 }));
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /recorded bytes/);
  assert.equal(
    JSON.parse(await readFile(path.join(f.runsDir, 'bundle-store.json'), 'utf8')).root,
    f.store.root,
  );
});

test('migration refuses a damaged copy and a missing or capacity-refused target without switching', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    bundles.migrateRunBundleStore({
      ...f.request,
      targetRoot: path.join(f.root, 'missing-volume/store'),
    }),
    /missing|mounted/,
  );
  await assert.rejects(
    bundles.migrateRunBundleStore({
      ...f.request,
      assertWriteRoom: async (_root: string, bytes: number) => {
        assert.ok(bytes > 0);
        throw new Error('under the floor');
      },
    }),
    /floor/,
  );
  assert.ok(!(await readdir(f.root)).includes('external-store'));
  const original = fs.copyFile;
  const mocked = t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof fs.copyFile>) => {
    await original(...args);
    if (String(args[0]).endsWith('TASK.md')) {
      await chmod(args[1], 0o600);
      await writeFile(args[1], 'corrupt target');
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /verif|bytes|digest/);
  assert.equal(bundles.runBundleRetentionSettings(f.home).storeRoot, undefined);
  assert.equal(
    JSON.parse(await readFile(path.join(f.runsDir, 'bundle-store.json'), 'utf8')).root,
    f.store.root,
  );
});

test('migration refuses an active media transfer outside the store lock', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.runsDir, `bundle-repair-${f.captured.ref.bundleDigest}.lock`);
  const release = await lockfile.lock(lock, { lockfilePath: lock, realpath: false });
  try {
    await assert.rejects(bundles.migrateRunBundleStore(f.request), /media transfer is active/);
    assert.equal(bundles.runBundleRetentionSettings(f.home).storeRoot, undefined);
    await assert.rejects(realpath(f.targetRoot), { code: 'ENOENT' });
  } finally {
    await release();
  }
});

test('migration refuses staged archival that can still remove files outside the store lock', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.store.root, 'sha256/.retention-12345678-1234-1234-1234-123456789abc'));
  await assert.rejects(bundles.migrateRunBundleStore(f.request), /archive.*staged/);
  assert.equal(bundles.runBundleRetentionSettings(f.home).storeRoot, undefined);
  assert.equal(
    (await bundles.openRunBundleStore({ home: f.home, runsDir: f.runsDir })).root,
    f.store.root,
  );
});
