import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = await fs.mkdtemp(path.join(tmpdir(), 'retention-admission-'));
after(() => fs.rm(root, { recursive: true, force: true }));
const taskRoot = path.join(root, '.sandbox/tasks');
await fs.mkdir(taskRoot, { recursive: true });
const historicFile = path.join(taskRoot, 'historic-media.mp4');
await fs.writeFile(historicFile, 'unreclaimed acquisition bytes');
let scans = 0;
let stalled: Promise<void> | undefined;
let entered: (() => void) | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === historicFile) {
        scans++;
        entered?.();
        await stalled;
      }
      return fs.stat(...args);
    },
  },
});
const { openRunBundleStore, reserveRunBundleMetadata } = await import('./retained.js');
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
