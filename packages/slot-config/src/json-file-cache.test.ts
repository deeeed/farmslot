import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { RACY_STAMP_MS } from '@farmslot/protocol';

import { readJsonFile, rememberJsonFile } from './json-file-cache.js';

const dir = mkdtempSync(path.join(tmpdir(), 'json-file-cache-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Files written now look settled, so the cache trusts their stamps as it does in steady state. */
function settledClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + RACY_STAMP_MS * 10 });
}

test('an unchanged file is parsed once and shared, frozen', async (t) => {
  settledClock(t);
  const file = path.join(dir, 'shared.json');
  await writeFile(file, JSON.stringify({ hooks: { a: 'x' }, list: [1] }));
  const first = await readJsonFile(file);
  assert.equal(await readJsonFile(file), first, 'a hit returns the same parse');
  assert.ok(first && typeof first === 'object' && 'list' in first);
  const list = first.list;
  assert.ok(Array.isArray(list));
  assert.ok(Object.isFrozen(first));
  assert.equal(Reflect.set(first, 'hooks', {}), false, 'a caller cannot replace a field');
  assert.throws(() => list.push(2), TypeError, 'or change a nested value');
  assert.deepEqual(await readJsonFile(file), { hooks: { a: 'x' }, list: [1] });
});

test('a same-size rewrite in place is read again', async (t) => {
  settledClock(t);
  const file = path.join(dir, 'same-size.json');
  await writeFile(file, '{"v":1}');
  assert.deepEqual(await readJsonFile(file), { v: 1 });
  const before = statSync(file);
  await writeFile(file, '{"v":2}');
  assert.equal(statSync(file).ino, before.ino, 'the rewrite kept the inode');
  assert.equal(statSync(file).size, before.size, 'and the size');
  assert.deepEqual(await readJsonFile(file), { v: 2 });
});

test('an atomic rename over the file is read again', async (t) => {
  settledClock(t);
  const file = path.join(dir, 'renamed.json');
  await writeFile(file, '{"v":1}');
  assert.deepEqual(await readJsonFile(file), { v: 1 });
  await writeFile(`${file}.tmp`, '{"v":3}');
  await rename(`${file}.tmp`, file);
  assert.deepEqual(await readJsonFile(file), { v: 3 });
});

test('a deleted file throws what readFile throws, and nothing stays cached', async (t) => {
  settledClock(t);
  const file = path.join(dir, 'deleted.json');
  await writeFile(file, '{"v":1}');
  await readJsonFile(file);
  await rm(file);
  const expected = await readFile(file, 'utf8').then(
    () => assert.fail('the file is gone'),
    (error: unknown) => error,
  );
  await assert.rejects(readJsonFile(file), (error: NodeJS.ErrnoException) => {
    assert.ok(expected instanceof Error);
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.message, expected.message, 'the error names the open, as before');
    return true;
  });
});

test('invalid JSON throws JSON.parse’s error each time; a fixed file is read', async (t) => {
  settledClock(t);
  const file = path.join(dir, 'invalid.json');
  await writeFile(file, '{ not json');
  const expected = (() => {
    try {
      JSON.parse('{ not json');
    } catch (error) {
      return error;
    }
    return assert.fail('the text is not JSON');
  })();
  assert.ok(expected instanceof SyntaxError);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(readJsonFile(file), { name: 'SyntaxError', message: expected.message });
  await writeFile(file, '{"fixed":true}');
  assert.deepEqual(await readJsonFile(file), { fixed: true });
});

test('a file changed within the racy window is read again even with an equal stamp', async () => {
  const file = path.join(dir, 'racy.json');
  await writeFile(file, '{"v":1}');
  const first = await readJsonFile(file);
  assert.notEqual(await readJsonFile(file), first, 'a fresh stamp is not trusted');
});

test('text this process committed is served from memory for that file version', async (t) => {
  settledClock(t);
  const file = path.join(dir, 'committed.json');
  writeFileSync(file, '{"on":"disk"}');
  rememberJsonFile(file, statSync(file, { bigint: true }), '{"in":"memory"}');
  assert.deepEqual(await readJsonFile(file), { in: 'memory' }, 'the file is not read back');
  await writeFile(file, '{"by":"other"}');
  assert.deepEqual(await readJsonFile(file), { by: 'other' }, 'an outside write replaces it');
});
