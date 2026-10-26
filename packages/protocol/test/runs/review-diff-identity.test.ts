import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  reviewDiffHash,
  reviewSnapshotIdentityText,
  verifiedReviewDiffHash,
} from '../../src/index.js';

const patch =
  'diff --git a/f.ts b/f.ts\nindex e4a35fd49f..86323ff1d8 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n';
const nodeSha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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
  const oldHash = nodeSha256(patch);
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

test('hashes equal the former gateway node:crypto digests', () => {
  const nonAscii = patch.replace('+new', '+café 日本 🚜');
  const binary =
    'diff --git a/i.png b/i.png\nindex 1234567..89abcde 100644\nGIT binary patch\nliteral 3\nKcmZQzWMT#Y01f~L\n\nliteral 0\nKcmV+b0RR6000031\n\n';
  const empty =
    'diff --git a/empty.ts b/empty.ts\nnew file mode 100644\nindex 0000000000..e69de29bb2\n';
  const untracked = reviewSnapshotIdentityText(nonAscii, [
    { path: 'ünïcode/新.ts', blobSha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', mode: '100644' },
  ]);
  const twoFiles = patch + nonAscii.replaceAll('f.ts', 'g.ts') + '+index abc..def 100644\n';
  // Recorded from the gateway's node:crypto implementation before the move.
  for (const [text, hash] of [
    [patch, '313dddf55b03bf9d34c33fa994a7087b48ac4c223b9b98905201d0e462032b37'],
    [nonAscii, '457b43d29416f85d6c21c954251657b869720cb1f48b458c65197eb4b8c1be6c'],
    [binary, '24038c0154c5bcd0493c05557504d2b26806a1f2d1f66a2d9beac0b94ce9e5fa'],
    [empty, '8c41a10b7a2d3b1c9e60fe11ae7800ac6c3d26e92e53d3eb9b0b627ff2f4933f'],
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [untracked, 'ceeeff6ea836e3e02cb79c6ad57538ab622edb372eb8afca8fe5f31bc54731e2'],
    [twoFiles, 'a9453e555015a99c2222944531cf4f355a98217af2823fc00074c07e8967acd6'],
  ]) {
    assert.equal(reviewDiffHash(text), hash);
    assert.equal(verifiedReviewDiffHash(text, nodeSha256(text)), hash);
  }
});
