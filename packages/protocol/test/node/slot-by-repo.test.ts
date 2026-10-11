import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findSlotByRepo,
  isIgnoredPoolFile,
  resolveSlotPoolDir,
  SlotByRepoError,
} from '../../src/node/slot-by-repo.js';

function tempDir(t: test.TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'protocol-slot-by-repo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pool(dir: string, file: string, value: unknown): void {
  writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
}

test('finds the slot whose repo is the checkout, through symlinks and ~/', async (t) => {
  const root = tempDir(t);
  const pools = join(root, 'pool');
  const checkout = join(root, 'checkout');
  mkdirSync(pools);
  mkdirSync(checkout);
  symlinkSync(checkout, join(root, 'linked'));
  pool(pools, 'remote.json', {
    machine: 'elsewhere',
    host: 'elsewhere.example',
    slots: [{ id: 'remote-1', repo: checkout, session: 'r1' }],
  });
  pool(pools, 'macwork.json', {
    machine: 'macwork',
    host: 'localhost',
    slots: [
      { id: 'no-repo', session: 'x' },
      { id: 'relative', repo: 'checkout', session: 'x' },
      { id: 'missing', repo: join(root, 'gone'), session: 'x' },
      { id: 'mmt-1', repo: join(root, 'linked'), session: 'mmt-1', platform: 'web' },
    ],
  });
  const match = await findSlotByRepo(pools, checkout);
  assert.equal(match?.slot.id, 'mmt-1');
  assert.equal(match?.slot.session, 'mmt-1');
  assert.equal(match?.poolFile, join(pools, 'macwork.json'));
  assert.equal(match?.pool.machine, 'macwork');

  // `~/` expands against the home directory.
  const savedHome = process.env.HOME;
  t.after(() => {
    process.env.HOME = savedHome;
  });
  process.env.HOME = root;
  pool(pools, 'macwork.json', {
    machine: 'macwork',
    host: 'localhost',
    slots: [{ id: 'home', repo: '~/checkout', session: 'h' }],
  });
  assert.equal((await findSlotByRepo(pools, checkout))?.slot.id, 'home');
});

test('prefers a slot on this machine, else the first pool that maps the checkout', async (t) => {
  const root = tempDir(t);
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  pool(root, 'a-remote.json', {
    machine: 'far',
    host: 'far.example',
    slots: [{ id: 'far-1', repo: checkout, session: 'f' }],
  });
  assert.equal((await findSlotByRepo(root, checkout))?.slot.id, 'far-1');
  pool(root, 'b-local.json', {
    machine: hostname().replace(/\.local$/u, ''),
    host: 'some-alias',
    slots: [{ id: 'near-1', repo: checkout, session: 'n' }],
  });
  assert.equal((await findSlotByRepo(root, checkout))?.slot.id, 'near-1');
});

test('skips ignored and unparsable pool files, and answers null when nothing maps the checkout', async (t) => {
  const root = tempDir(t);
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const slots = [{ id: 'ignored', repo: checkout, session: 's' }];
  pool(root, 'example.json', { host: 'localhost', slots });
  pool(root, 'farmslot-demo.json', { host: 'localhost', slots });
  pool(root, 'agent-contexts-1.json', { host: 'localhost', slots });
  pool(root, 'notes.txt', JSON.stringify({ host: 'localhost', slots }));
  pool(root, 'broken.json', '{');
  assert.equal(await findSlotByRepo(root, checkout), null);
  await assert.rejects(findSlotByRepo(join(root, 'no-pools'), checkout), { code: 'ENOENT' });
});

test('strict lookup refuses multiple local slots and accepts an explicit matching slot', async (t) => {
  const root = tempDir(t);
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  pool(root, 'a-remote.json', {
    host: 'remote.example',
    slots: [{ id: 'remote', repo: checkout }],
  });
  pool(root, 'b-local.json', {
    host: 'localhost',
    slots: [{ id: 'first', repo: checkout }],
  });
  assert.equal((await findSlotByRepo(root, checkout, { strict: true }))?.slot.id, 'first');
  pool(root, 'c-local.json', {
    host: '127.0.0.1',
    slots: [{ id: 'second', repo: checkout }],
  });
  await assert.rejects(findSlotByRepo(root, checkout, { strict: true }), (error: unknown) => {
    assert.ok(error instanceof SlotByRepoError);
    assert.deepEqual(error.candidates, ['first', 'second']);
    return true;
  });
  assert.equal(
    (await findSlotByRepo(root, checkout, { strict: true, slotId: 'second' }))?.slot.id,
    'second',
  );
  await assert.rejects(findSlotByRepo(root, checkout, { strict: true, slotId: 'missing' }), {
    code: 'SLOT_NOT_FOUND',
  });
  assert.equal((await findSlotByRepo(root, checkout))?.slot.id, 'first');
});

test('isIgnoredPoolFile admits the demo pool only when FARMSLOT_DEMO_POOL=1', () => {
  assert.equal(isIgnoredPoolFile('macwork.json', {}), false);
  assert.equal(isIgnoredPoolFile('macwork.json.bak', {}), true);
  assert.equal(isIgnoredPoolFile('example.json', {}), true);
  assert.equal(isIgnoredPoolFile('agent-contexts-12.json', {}), true);
  assert.equal(isIgnoredPoolFile('farmslot-demo.json', {}), true);
  assert.equal(isIgnoredPoolFile('farmslot-demo.json', { FARMSLOT_DEMO_POOL: '1' }), false);
});

test('resolveSlotPoolDir: FARMSLOT_POOL_DIR, else FARMSLOT_ROOT/pool, else ~/farmslot-node/pool when present', (t) => {
  const home = tempDir(t);
  assert.deepEqual(
    resolveSlotPoolDir({ FARMSLOT_POOL_DIR: '/p', FARMSLOT_ROOT: '/r', HOME: home }),
    {
      dir: '/p',
      source: 'FARMSLOT_POOL_DIR',
    },
  );
  assert.deepEqual(resolveSlotPoolDir({ FARMSLOT_ROOT: '/r', HOME: home }), {
    dir: '/r/pool',
    source: 'FARMSLOT_ROOT',
  });
  assert.equal(
    resolveSlotPoolDir({ FARMSLOT_POOL_DIR: '  ', FARMSLOT_ROOT: '', HOME: home }),
    undefined,
  );
  mkdirSync(join(home, 'farmslot-node', 'pool'), { recursive: true });
  assert.deepEqual(resolveSlotPoolDir({ HOME: home }), {
    dir: join(home, 'farmslot-node', 'pool'),
    source: 'farmslot-node',
  });
});
