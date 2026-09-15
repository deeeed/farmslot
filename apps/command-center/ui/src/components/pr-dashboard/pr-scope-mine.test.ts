import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import {
  describeMineScope,
  isMineEntry,
  normalizeLogins,
  parseLoginList,
} from './pr-scope-mine.js';
import type { PRWorkspaceEntry } from './pr-workspace.js';

function entry(author: string | undefined, ownedFamily?: boolean): PRWorkspaceEntry {
  return {
    key: { repo: 'org/app', pr: 1 },
    title: 'PR',
    author,
    reviewObservations: [],
    monitors: [],
    reviews: [],
    requests: [],
    status: ownedFamily === undefined ? undefined : ({ ownedFamily } as PRStatus),
  };
}

test('logins are trimmed, de-@ed, lower-cased and de-duplicated', () => {
  assert.deepEqual(normalizeLogins([' @Arthur ', 'arthur', '', 'Bob']), ['arthur', 'bob']);
  assert.deepEqual(parseLoginList('@Arthur, bob\nCarol'), ['arthur', 'bob', 'carol']);
});

test('mine = my logins, plus farmslot-run PRs when enabled', () => {
  const scope = { logins: ['arthur'], includeRunOwned: true };
  assert.equal(isMineEntry(entry('Arthur'), scope), true, 'author match is case-insensitive');
  assert.equal(isMineEntry(entry('bob'), scope), false);
  assert.equal(isMineEntry(entry('bob', true), scope), true, 'run-owned counts');
  assert.equal(isMineEntry(entry('bob', true), { ...scope, includeRunOwned: false }), false);
  assert.equal(isMineEntry(entry(undefined), scope), false, 'unknown author is not mine');
});

test('the scope is described for the pill tooltip', () => {
  assert.equal(
    describeMineScope({ logins: ['arthur', 'bob'], includeRunOwned: true }),
    '@arthur, @bob + farmslot runs',
  );
  assert.equal(describeMineScope({ logins: [], includeRunOwned: false }), 'no logins');
});
