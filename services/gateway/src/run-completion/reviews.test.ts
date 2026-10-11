import assert from 'node:assert/strict';
import test from 'node:test';

import { materializeReviewArtifacts } from './reviews.js';
import { makeRun } from './test-fixtures.js';

test('materializeReviewArtifacts coalesces review retry attempts', async () => {
  const run = makeRun({
    steps: [
      {
        name: 'review',
        status: 'done',
        startedAt: '2026-04-25T00:00:00.000Z',
        completedAt: '2026-04-25T00:05:00.000Z',
        outputs: {
          attempts: [
            {
              mode: 'cold' as const,
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 1,
              issues: [{ file: 'bad.ts', description: 'fixed later' }],
              artifactPaths: ['artifacts/review-loop-1/review.md'],
              reviewSnapshot: {
                source: 'local-git',
                capturedAt: '2026-04-25T00:01:00.000Z',
                headSha: 'old-head',
              },
            },
            {
              mode: 'cold' as const,
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              artifactPaths: ['artifacts/review-loop-2/review.md'],
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

  const reviews = await materializeReviewArtifacts(run);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, 'pipeline-review-1');
  assert.equal(reviews[0].verdict, 'pass');
  assert.equal(reviews[0].unresolvedCount, 0);
  assert.equal(reviews[0].reviewSnapshot?.headSha, 'new-head');
  assert.equal(reviews[0].attempts?.length, 2);
  assert.deepEqual(reviews[0].artifactPaths, [
    'artifacts/review-loop-1/review.md',
    'artifacts/review-loop-2/review.md',
  ]);
});

test('materializeReviewArtifacts does not create stale pending review for completed step without verdict', async () => {
  const run = makeRun({
    steps: [
      {
        name: 'review',
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

  const reviews = await materializeReviewArtifacts(run);

  assert.deepEqual(reviews, []);
});
