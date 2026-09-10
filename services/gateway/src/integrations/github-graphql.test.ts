import assert from 'node:assert/strict';
import test from 'node:test';

import { collectGitHubPages, type GitHubPage } from './github-graphql.js';

test('collectGitHubPages follows every page and rejects incomplete pagination', async () => {
  const cursors: (string | null)[] = [];
  const result = await collectGitHubPages(async (cursor) => {
    cursors.push(cursor);
    return cursor === null
      ? { nodes: ['first'], pageInfo: { hasNextPage: true, endCursor: 'next' } }
      : { nodes: ['last'], pageInfo: { hasNextPage: false, endCursor: null } };
  });
  assert.deepEqual(result, ['first', 'last']);
  assert.deepEqual(cursors, [null, 'next']);
  await assert.rejects(
    collectGitHubPages(async () => ({
      nodes: ['partial'],
      pageInfo: { hasNextPage: true, endCursor: null },
    })),
    /did not advance/,
  );
  await assert.rejects(
    collectGitHubPages(async () => ({
      nodes: ['partial'],
      pageInfo: { hasNextPage: true, endCursor: 'same' },
    })),
    /did not advance/,
  );
  await assert.rejects(
    collectGitHubPages(async () => ({
      nodes: [null],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
    /incomplete/,
  );
  await assert.rejects(
    collectGitHubPages(async () => ({ nodes: [] }) as unknown as GitHubPage<string>),
    /incomplete/,
  );
});

test('invalid cursor classification uses the structured GitHub error type', async () => {
  const { hasInvalidGitHubCursor } = await import('./github-errors.js');
  assert.equal(hasInvalidGitHubCursor([{ type: 'INVALID_CURSOR_ARGUMENT' }]), true);
  assert.equal(
    hasInvalidGitHubCursor([{ type: 'RATE_LIMITED', message: 'query cursor was present' }]),
    false,
  );
  assert.equal(hasInvalidGitHubCursor([{ message: 'INVALID_CURSOR_ARGUMENT' }]), false);
});
