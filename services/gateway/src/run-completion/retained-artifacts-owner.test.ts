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

const { runBundleStore } = await import('./retained-artifacts.js');

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
