import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus } from '@farmslot/protocol';

import {
  describeMineScope,
  isMineEntry,
  normalizeLogins,
  parseLoginList,
  withAdoption,
} from './pr-scope-mine.js';
import type { PRWorkspaceEntry } from './pr-workspace.js';

function entry(
  author: string | undefined,
  ownedFamily?: boolean,
  familyRootTicketOrPr = 'TAT-1',
): PRWorkspaceEntry {
  return {
    key: { repo: 'org/app', pr: 1 },
    title: 'PR',
    author,
    reviewObservations: [],
    monitors: [],
    reviews: [],
    requests: [],
    status:
      ownedFamily === undefined ? undefined : ({ ownedFamily, familyRootTicketOrPr } as PRStatus),
  };
}

test('logins are trimmed, de-@ed, lower-cased and de-duplicated', () => {
  assert.deepEqual(normalizeLogins([' @Arthur ', 'arthur', '', 'Bob']), ['arthur', 'bob']);
  assert.deepEqual(parseLoginList('@Arthur, bob\nCarol'), ['arthur', 'bob', 'carol']);
});

test('mine = my logins, plus farmslot-run PRs when enabled', () => {
  const scope = { logins: ['arthur'], includeRunOwned: true, adopted: [] };
  assert.equal(isMineEntry(entry('Arthur'), scope), true, 'author match is case-insensitive');
  assert.equal(isMineEntry(entry('bob'), scope), false);
  assert.equal(isMineEntry(entry('bob', true), scope), true, 'a run created it from a ticket');
  assert.equal(
    isMineEntry(entry('bob', true, 'org/app#1'), scope),
    false,
    "a run that only worked on someone else's PR does not make it mine",
  );
  assert.equal(isMineEntry(entry('bob', true), { ...scope, includeRunOwned: false }), false);
  assert.equal(isMineEntry(entry(undefined), scope), false, 'unknown author is not mine');
});

test('the scope is described for the pill tooltip', () => {
  assert.equal(
    describeMineScope({ logins: ['arthur', 'bob'], includeRunOwned: true, adopted: [] }),
    '@arthur, @bob + PRs farmslot created',
  );
  assert.equal(describeMineScope({ logins: [], includeRunOwned: false, adopted: [] }), 'no logins');
});

test('taking a PR over makes it mine regardless of author; releasing undoes it', () => {
  const base = { logins: ['arthur'], includeRunOwned: false, adopted: [] };
  const theirs = entry('bob');
  assert.equal(isMineEntry(theirs, base), false);
  const taken = withAdoption(base, { repo: 'Org/App', pr: 1 }, true);
  assert.deepEqual(taken.adopted, ['github.com/org/app#1'], 'host-qualified, case-folded');
  assert.equal(
    isMineEntry(
      theirs,
      withAdoption(base, { repo: 'org/app', pr: 1, host: 'git.example.com' }, true),
    ),
    false,
    'adopting the same number on another host does not adopt this one',
  );
  assert.equal(isMineEntry(theirs, taken), true);
  assert.equal(describeMineScope(taken), '@arthur + 1 taken over');
  assert.equal(isMineEntry(theirs, withAdoption(taken, { repo: 'org/app', pr: 1 }, false)), false);
});
