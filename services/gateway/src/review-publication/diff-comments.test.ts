import assert from 'node:assert/strict';
import { test } from 'node:test';

import { locatePublicationComments, rightDiffLines } from './diff-comments.js';

test('right-side lines include context and additions across hunks, excluding deleted and missing lines', () => {
  assert.deepEqual(
    [
      ...rightDiffLines(
        '@@ -3,3 +3,2 @@\n context\n-deleted\n-old\n+new\n@@ -20 +19 @@\n-old\n+new\n\\ No newline at end of file',
      ),
    ],
    [3, 4, 19],
  );
  assert.deepEqual([...rightDiffLines('@@ -3,2 +3,0 @@\n-a\n-b')], []);
  assert.deepEqual([...rightDiffLines('@@ -3,4 +3,4 @@\n context\n+added')], [3, 4]);
});

test('missing patches preserve findings in the body with escaped labels and frozen source links', () => {
  const comment = { path: 'src/a [b].ts', line: 8, side: 'RIGHT', body: 'Keep this finding.' };
  const result = locatePublicationComments([comment], [[{ filename: comment.path }]], {
    host: 'github.com',
    repo: 'example/app',
    headSha: 'abc',
  });
  assert.deepEqual(result.inline, []);
  assert(result.bodySuffix.includes('Keep this finding.'));
  assert(result.bodySuffix.includes('/blob/abc/src/a%20%5Bb%5D.ts#L8'));
  assert.throws(
    () =>
      locatePublicationComments([comment], [null], {
        host: 'github.com',
        repo: 'example/app',
        headSha: 'abc',
      }),
    /incomplete/,
  );
});
