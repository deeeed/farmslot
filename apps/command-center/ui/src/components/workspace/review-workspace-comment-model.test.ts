import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewLineComment } from '@farmslot/protocol';

import {
  reviewCommentCountByFile,
  reviewCommentKey,
  reviewCommentsByFile,
  reviewThreadsForFile,
} from './review-workspace-comment-model.js';

function comment(overrides: Partial<ReviewLineComment> = {}): ReviewLineComment {
  return {
    path: 'src/app.ts',
    line: 10,
    body: 'Fix this branch',
    severity: 'must_fix',
    ...overrides,
  } as ReviewLineComment;
}

test('review comment model groups comments and counts them by file', () => {
  const comments = [
    comment({ line: 3 }),
    comment({ line: 4 }),
    comment({ path: 'src/other.ts', line: 1, severity: 'nitpick' }),
  ];

  const byFile = reviewCommentsByFile(comments);
  const counts = reviewCommentCountByFile(byFile);

  assert.deepEqual(
    [...byFile].map(([path, entries]) => [path, entries.map((entry) => entry.line)]),
    [
      ['src/app.ts', [3, 4]],
      ['src/other.ts', [1]],
    ],
  );
  assert.deepEqual(
    [...counts],
    [
      ['src/app.ts', 2],
      ['src/other.ts', 1],
    ],
  );
});

test('review comment keys preserve refresh inclusion identity inputs', () => {
  assert.equal(reviewCommentKey(comment()), 'src/app.ts\u000010\u0000Fix this branch');
});

test('reviewThreadsForFile projects comments for code-viewer view zones', () => {
  const timestamps = ['created-1', 'updated-1', 'created-2', 'updated-2'];
  const byFile = reviewCommentsByFile([
    comment({ line: 12, severity: 'suggestion', body: 'Consider extracting this' }),
    comment({ line: 15, severity: 'must_fix', body: 'Handle the error' }),
  ]);

  const threads = reviewThreadsForFile(byFile, 'src/app.ts', () => timestamps.shift() ?? 'extra');

  assert.deepEqual(
    threads.map((thread) => ({
      id: thread.id,
      line: thread.line,
      body: thread.comments[0]?.body,
      createdAt: thread.comments[0]?.createdAt,
      updatedAt: thread.comments[0]?.updatedAt,
    })),
    [
      {
        id: 'review-0-12',
        line: 12,
        body: '**[suggestion]** Consider extracting this',
        createdAt: 'created-1',
        updatedAt: 'updated-1',
      },
      {
        id: 'review-1-15',
        line: 15,
        body: '**[must_fix]** Handle the error',
        createdAt: 'created-2',
        updatedAt: 'updated-2',
      },
    ],
  );
  assert.deepEqual(reviewThreadsForFile(byFile, 'missing.ts'), []);
});
