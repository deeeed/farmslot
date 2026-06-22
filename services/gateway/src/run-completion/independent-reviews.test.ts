import assert from 'node:assert/strict';
import test from 'node:test';

import { materializeIndependentReviewArtifacts } from './independent-reviews.js';
import { makeRun } from './test-fixtures.js';

test('materializeIndependentReviewArtifacts coalesces self-review retry attempts', async () => {
  const run = makeRun({
    steps: [
      {
        name: 'self-review',
        status: 'done',
        startedAt: '2026-04-25T00:00:00.000Z',
        completedAt: '2026-04-25T00:05:00.000Z',
        outputs: {
          attempts: [
            {
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 1,
              issues: [{ file: 'bad.ts', description: 'fixed later' }],
              artifactPaths: ['artifacts/review-loop-1/self-review.md'],
              reviewSnapshot: {
                source: 'local-git',
                capturedAt: '2026-04-25T00:01:00.000Z',
                headSha: 'old-head',
              },
            },
            {
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              artifactPaths: ['artifacts/review-loop-2/self-review.md'],
              reviewSnapshot: {
                source: 'local-git',
                capturedAt: '2026-04-25T00:04:00.000Z',
                headSha: 'new-head',
              },
            },
          ],
        },
      },
    ],
  });

  const reviews = await materializeIndependentReviewArtifacts(run);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, 'self-review-1');
  assert.equal(reviews[0].verdict, 'pass');
  assert.equal(reviews[0].unresolvedCount, 0);
  assert.equal(reviews[0].reviewSnapshot?.headSha, 'new-head');
  assert.equal(reviews[0].attempts?.length, 2);
  assert.deepEqual(reviews[0].artifactPaths, [
    'artifacts/review-loop-1/self-review.md',
    'artifacts/review-loop-2/self-review.md',
  ]);
});

test('materializeIndependentReviewArtifacts does not create stale pending review for completed step without verdict', async () => {
  const run = makeRun({
    steps: [
      {
        name: 'self-review',
        status: 'done',
        startedAt: '2026-04-25T00:00:00.000Z',
        completedAt: '2026-04-25T00:05:00.000Z',
        outputs: {
          replayPrerequisiteNormalized: true,
          normalizedFromStatus: 'running',
          normalizedForReplayStep: 'complete',
        },
      },
    ],
  });

  const reviews = await materializeIndependentReviewArtifacts(run);

  assert.deepEqual(reviews, []);
});
