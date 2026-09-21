import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { reviewDiffHash, verifiedReviewDiffHash } from './review-diff-identity.js';

const patch =
  'diff --git a/f.ts b/f.ts\nindex e4a35fd49f..86323ff1d8 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n';

test('Git object-ID display lengths do not invalidate identical text changes', () => {
  const expanded = patch.replace('e4a35fd49f..86323ff1d8', 'e4a35fd49fe..86323ff1d81');
  assert.equal(reviewDiffHash(patch), reviewDiffHash(expanded));
  assert.notEqual(reviewDiffHash(patch), reviewDiffHash(patch.replace('+new', '+changed')));
  assert.notEqual(reviewDiffHash(patch), reviewDiffHash(patch.replace('100644', '100755')));
  assert.notEqual(reviewDiffHash(patch), reviewDiffHash(patch + '# 100644\tblob\t"new-file.ts"\n'));
});

test('binary changes and index-like source lines retain their identity', () => {
  const binary = patch.slice(0, patch.indexOf('---')) + 'Binary files a/f.ts and b/f.ts differ\n';
  assert.notEqual(
    reviewDiffHash(binary),
    reviewDiffHash(binary.replace('86323ff1d8', 'aaaaaaaaaa')),
  );
  const code = patch + '+index abc..def 100644\n';
  assert.notEqual(reviewDiffHash(code), reviewDiffHash(code.replace('+index abc', '+index abcd')));
});

test('legacy recovery verifies stored bytes before upgrading a review identity', () => {
  const oldHash = createHash('sha256').update(patch).digest('hex');
  assert.equal(verifiedReviewDiffHash(patch, oldHash), reviewDiffHash(patch));
  assert.equal(verifiedReviewDiffHash(patch, reviewDiffHash(patch)), reviewDiffHash(patch));
  assert.equal(verifiedReviewDiffHash(patch.replace('+new', '+tampered'), oldHash), undefined);
});

test('legacy empty-file patches ignore abbreviated IDs without losing file creation or mode', () => {
  const empty =
    'diff --git a/empty.ts b/empty.ts\nnew file mode 100644\nindex 0000000000..e69de29bb2\n';
  assert.equal(
    reviewDiffHash(empty),
    reviewDiffHash(empty.replace('0000000000..e69de29bb2', '00000000000..e69de29bb2d')),
  );
  assert.notEqual(reviewDiffHash(empty), reviewDiffHash(''));
  assert.notEqual(reviewDiffHash(empty), reviewDiffHash(empty.replace('100644', '100755')));
});
