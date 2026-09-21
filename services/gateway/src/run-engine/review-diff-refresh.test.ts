import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { IndependentReviewStatus } from '@farmslot/protocol';

import { reviewDiffHash } from '../core/review-diff-identity.js';

import { refreshReviewDiffIdentities } from './review-diff-refresh.js';
import { makeRun } from './test-fixtures.js';

const patch =
  'diff --git a/f b/f\nindex abc1234..def5678 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n';
test('refresh repairs verified legacy review hashes but never missing or tampered evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-identity-'));
  try {
    await mkdir(path.join(root, 'artifacts'));
    await writeFile(path.join(root, 'artifacts/review.diff'), patch);
    const run = makeRun({ taskFile: path.join(root, 'TASK.md'), slotId: null });
    const review: IndependentReviewStatus = {
      id: 'review-1',
      source: 'dispatch',
      crossRunner: false,
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      reviewSnapshot: {
        source: 'local-git',
        capturedAt: '2026-09-21T00:00:00Z',
        headSha: 'head',
        diffPath: 'artifacts/review.diff',
        diffHash: createHash('sha256').update(patch).digest('hex'),
      },
    };
    const [fixed] = await refreshReviewDiffIdentities(run, [review]);
    assert.equal(fixed.reviewSnapshot?.diffHash, reviewDiffHash(patch));
    assert.equal(fixed.reviewSnapshot?.headSha, review.reviewSnapshot?.headSha);
    assert.equal(await readFile(path.join(root, 'artifacts/review.diff'), 'utf8'), patch);
    await writeFile(path.join(root, 'artifacts/review.diff'), patch.replace('+b', '+bad'));
    assert.equal((await refreshReviewDiffIdentities(run, [review]))[0], review);
    await rm(path.join(root, 'artifacts/review.diff'));
    assert.equal((await refreshReviewDiffIdentities(run, [review]))[0], review);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
