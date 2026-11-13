import assert from 'node:assert/strict';
import fs, { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadSlotVars, readSlotPools } from './config.js';

interface PoolFixture {
  dir: string;
  write(platform: string): void;
}

function poolFixture(t: test.TestContext): PoolFixture {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'slot-config-pools-')));
  const previous = process.env.FARMSLOT_POOL_DIR;
  process.env.FARMSLOT_POOL_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  // Every read must look settled: the edits below are found by their stat, not by a racy stamp.
  const settledAt = Date.now() + 10_000;
  t.mock.method(Date, 'now', () => settledAt);
  const write = (platform: string) =>
    writeFileSync(
      path.join(dir, 'm.json'),
      JSON.stringify({
        machine: 'm',
        host: 'localhost',
        ssh_user: 'u',
        platform,
        slots: ['a', 'b', 'c'].map((id) => ({ id, repo: `/tmp/${id}`, session: id })),
      }),
    );
  write('ios');
  writeFileSync(path.join(dir, 'm.json.bak.2026-11-13'), '{}');
  return { dir, write };
}

test('a pool edit between two slot lookups is seen by the second, even within one turn', async (t) => {
  const { write } = poolFixture(t);
  assert.equal((await loadSlotVars('a')).platform, 'ios');
  write('android-edited');
  assert.equal((await loadSlotVars('a')).platform, 'android-edited');
  // No await between the edit and the read: the pool is not memoised per event-loop turn.
  write('ios-edited');
  assert.equal(readSlotPools()[0].pool.platform, 'ios-edited');
});

test('lookups that share one readSlotPools stat the pool once and see that one read', async (t) => {
  const { dir, write } = poolFixture(t);
  readSlotPools();
  const statted: string[] = [];
  const { statSync } = fs;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof statSync>) => {
    statted.push(String(args[0]));
    return statSync(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const pools = readSlotPools();
  const vars = [];
  for (const id of ['a', 'b', 'c']) vars.push(await loadSlotVars(id, pools));
  assert.deepEqual(
    vars.map((slot) => slot.slotId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(statted, [dir, path.join(dir, 'm.json')], 'one directory and one pool stat');

  write('android-edited');
  assert.equal((await loadSlotVars('b', pools)).platform, 'ios', 'the shared read is one snapshot');
  assert.equal((await loadSlotVars('b')).platform, 'android-edited', 'the next read sees the edit');
});
