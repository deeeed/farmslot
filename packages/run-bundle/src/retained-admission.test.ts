import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { Run } from '@farmslot/protocol';

const root = await fs.mkdtemp(path.join(tmpdir(), 'retention-admission-'));
after(() => fs.rm(root, { recursive: true, force: true }));
const taskRoot = path.join(root, '.sandbox/tasks');
await fs.mkdir(taskRoot, { recursive: true });
const historicFile = path.join(taskRoot, 'historic-media.mp4');
await fs.writeFile(historicFile, 'unreclaimed acquisition bytes');
let scans = 0;
let stalled: Promise<void> | undefined;
let entered: (() => void) | undefined;
let activeStats = 0;
let peakStats = 0;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const file = String(args[0]);
      if (
        file === historicFile ||
        (path.dirname(file) === taskRoot && path.basename(file).startsWith('parallel-'))
      ) {
        scans++;
        activeStats++;
        peakStats = Math.max(peakStats, activeStats);
        entered?.();
        try {
          await stalled;
          return await fs.stat(...args);
        } finally {
          activeStats--;
        }
      }
      return fs.stat(...args);
    },
  },
});
const {
  openRunBundleStore,
  reserveRunBundleMetadata,
  materializeRunBundle,
  DEFAULT_RUN_BUNDLE_RETENTION,
} = await import('./retained.js');
const store = await openRunBundleStore({
  runsDir: path.join(root, 'runs'),
  home: path.join(root, 'home'),
  create: true,
});

test('an existing reservation bypasses historical acquisition scanning without rewriting it', async () => {
  await reserveRunBundleMetadata(store, 'already-admitted');
  const file = path.join(store.root, 'reservations/already-admitted.json');
  const before = await fs.readFile(file, 'utf8');
  const previousScans = scans;
  await reserveRunBundleMetadata(store, 'already-admitted', undefined, root);
  assert.equal(scans, previousScans);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('new admission times out by name and a late read-only scan cannot write a reservation', async (t) => {
  let release!: () => void;
  stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reservation = reserveRunBundleMetadata(store, 'new-work', undefined, root);
  const rejected = assert.rejects(
    reservation,
    /Retention admission acquisition scan timed out after 30000ms for run new-work/,
  );
  try {
    await scanning;
    t.mock.timers.tick(30_000);
    await rejected;
  } finally {
    release();
    stalled = undefined;
    entered = undefined;
    t.mock.timers.reset();
  }
  // Wait for the shared scan to settle through an ordinary accounting call.
  await reserveRunBundleMetadata(store, 'other-work', undefined, root);
  await assert.rejects(fs.readFile(path.join(store.root, 'reservations/new-work.json')), /ENOENT/);
});

test('accounting overlaps filesystem reads within a bound and still charges every byte', async () => {
  for (let i = 1; i <= 32; i++)
    await fs.writeFile(path.join(taskRoot, `parallel-${i}`), Buffer.alloc(i));
  const reservationFiles = (await fs.readdir(path.join(store.root, 'reservations'))).map((name) =>
    path.join(store.root, 'reservations', name),
  );
  let reserved = 0;
  for (const file of reservationFiles)
    reserved += JSON.parse(await fs.readFile(file, 'utf8')).bytes;
  let storeBytes = 0;
  for (const file of [path.join(store.root, 'store.json'), ...reservationFiles])
    storeBytes += (await fs.stat(file)).size;
  const newReservation = 1024 ** 2;
  const policy = {
    ...DEFAULT_RUN_BUNDLE_RETENTION,
    metadataReserveBytes: reserved + newReservation,
    maxStoreBytes:
      storeBytes +
      reserved +
      newReservation +
      Buffer.byteLength('unreclaimed acquisition bytes') +
      528 -
      1,
  };
  let release!: () => void;
  stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  peakStats = 0;
  const result = assert.rejects(
    reserveRunBundleMetadata(store, 'parallel-accounting', policy, root),
    /capacity is exhausted/,
  );
  try {
    await scanning;
    assert.ok(
      peakStats > 1,
      'independent stats must overlap instead of serializing the whole tree',
    );
    assert.ok(peakStats <= 16, 'one scan must bound filesystem pressure');
  } finally {
    release();
    stalled = undefined;
    entered = undefined;
    await result;
  }
  await assert.rejects(
    fs.readFile(path.join(store.root, 'reservations/parallel-accounting.json')),
    /ENOENT/,
  );
});

test('capture scan expiry creates no intent, staging or late commit', async (t) => {
  const taskDir = path.join(taskRoot, 'capture-case');
  await fs.mkdir(taskDir);
  const run: Run = {
    id: 'capture-timeout',
    familyId: 'capture-timeout',
    lane: 'production',
    flowType: 'qa',
    mode: 'validation',
    completionPolicy: 'artifact-only',
    status: 'monitoring',
    project: 'fixture',
    ticketOrPr: 'QA',
    slotId: null,
    branch: null,
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'scripted', model: 'scripted' },
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  };
  let release!: () => void;
  stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scanning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  let failure: unknown;
  let commits = 0;
  const result = materializeRunBundle({
    store,
    farmslotRoot: root,
    run,
    taskDir,
    artifacts: [],
    manifestDigest: 'capture-timeout',
    captureKey: 'first',
    commit: async () => {
      commits++;
    },
  }).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      failure = error;
      settled = true;
    },
  );
  try {
    await scanning;
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(settled, true, 'capture must leave a stalled accounting scan at its deadline');
    assert.ok(failure instanceof Error);
    assert.match(
      failure.message,
      /Retention capture acquisition scan timed out after 30000ms for run capture-timeout/,
    );
  } finally {
    release();
    stalled = undefined;
    entered = undefined;
    t.mock.timers.reset();
    await result;
  }
  await reserveRunBundleMetadata(store, 'after-capture-timeout', undefined, root);
  assert.equal(commits, 0);
  await assert.rejects(fs.stat(path.join(store.runsDir, 'bundle-intents')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(store.root, 'staging')), /ENOENT/);
});
