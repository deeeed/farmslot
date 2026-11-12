import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProjectOwnedPaths } from './owned-paths.js';

test('ownership keeps current paths and permanent retired tombstones in one list', () => {
  const list = [
    { path: '.agents/skills/example', state: 'current' },
    { path: 'CLAUDE.local.md', state: 'retired' },
  ];
  assert.deepEqual(parseProjectOwnedPaths(list), list);
  assert.equal(parseProjectOwnedPaths(undefined), undefined);
});

for (const path of [
  '.',
  '..',
  '../notes',
  '/tmp/notes',
  '.git/info/exclude',
  'support/../notes',
  '.cursor/',
  '*.md',
]) {
  test(`ownership refuses unsafe or ambiguous path ${path}`, () => {
    assert.throws(
      () => parseProjectOwnedPaths([{ path, state: 'retired' }]),
      /Invalid fixtures.owned_paths/,
    );
  });
}

test('ownership rejects duplicate paths, missing states and misspelled metadata', () => {
  assert.throws(
    () =>
      parseProjectOwnedPaths([
        { path: 'support', state: 'current' },
        { path: 'support', state: 'retired' },
      ]),
    /Duplicate/,
  );
  for (const list of [
    null,
    {},
    [{ path: 'support' }],
    [{ path: 'support', state: 'old' }],
    [{ path: 'support', state: 'retired', extra: true }],
  ])
    assert.throws(() => parseProjectOwnedPaths(list), /fixtures.owned_paths/);
});
