import assert from 'node:assert/strict';
import test from 'node:test';

import * as lazyImportModule from './lazy-import.js';
import { lazyImport } from './lazy-import.js';

test('a resolved load runs once and every caller shares its module', async () => {
  let loads = 0;
  const load = lazyImport(async () => {
    loads += 1;
    return { value: loads };
  });
  const [first, second] = await Promise.all([load(), load()]);
  const third = await load();
  assert.equal(loads, 1);
  assert.equal(first, second);
  assert.equal(first, third);
});

test('a rejected load is not kept: the next call loads again', async () => {
  let loads = 0;
  const load = lazyImport(async () => {
    loads += 1;
    if (loads === 1) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    return { value: loads };
  });
  await assert.rejects(load(), { code: 'EMFILE' });
  assert.deepEqual(await load(), { value: 2 });
  assert.deepEqual(await load(), { value: 2 });
  assert.equal(loads, 2);
});

test('a lazily imported module is the same module a static import binds', async () => {
  const load = lazyImport(() => import('./lazy-import.js'));
  assert.equal(await load(), lazyImportModule);
});
