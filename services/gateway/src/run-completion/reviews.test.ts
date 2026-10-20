import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ReviewStatus } from '@farmslot/protocol';

import { augmentReviewAttemptsFromArtifacts, materializeReviewArtifacts } from './reviews.js';
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

test('materializing old pipeline output preserves its newer WARM result and artifact', async (t) => {
  const taskDir = await mkdtemp(path.join(tmpdir(), 'review-materialization-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'artifacts'));
  const review: ReviewStatus = {
    id: 'pipeline-review-lane',
    source: 'pipeline',
    mode: 'warm',
    reviewerSessionId: 'retained-session',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    completedAt: '2026-10-12T00:02:00Z',
    reviewedHeadSha: 'head-2',
    reviewedReviewSubjectHash: 'subject-2',
    session: {
      mode: 'warm',
      continuity: 'resumed',
      reviewId: 'pipeline-review-lane',
      sessionId: 'retained-session',
      lastReviewedHeadSha: 'head-1',
    },
    reviewSnapshot: {
      source: 'local-git',
      capturedAt: '2026-10-12T00:01:00Z',
      baseSha: 'head-1',
      headSha: 'head-2',
    },
    attempts: [
      { mode: 'cold', loopNumber: 1, verdict: 'pass', unresolvedCount: 0 },
      { mode: 'warm', loopNumber: 2, verdict: 'pass', unresolvedCount: 0 },
    ],
  };
  const artifact = path.join(taskDir, 'artifacts/pipeline-review-lane.json');
  await writeFile(artifact, JSON.stringify(review));
  for (const attempts of [undefined, [review.attempts![0]]]) {
    const run = makeRun({
      taskFile: path.join(taskDir, 'TASK.md'),
      engineState: { publishGate: { reviews: [review] } },
      steps: [
        {
          name: 'review',
          status: 'done',
          completedAt: '2026-10-12T00:00:00Z',
          outputs: { reviewId: review.id, mode: 'cold', verdict: 'pass', attempts },
        },
      ],
    });
    assert.deepEqual(await materializeReviewArtifacts(run), [review]);
    assert.deepEqual(JSON.parse(await readFile(artifact, 'utf8')), review);
  }
});

test('completed pipeline materialization drops a stale pending record', async () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'pipeline-review-1',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pending',
            unresolvedCount: 0,
            startedAt: '2026-10-12T00:02:00Z',
          },
        ],
      },
    },
    steps: [
      {
        name: 'review',
        status: 'done',
        completedAt: '2026-10-12T00:01:00Z',
        outputs: { verdict: 'pass' },
      },
    ],
  });
  assert.equal((await materializeReviewArtifacts(run))[0]?.verdict, 'pass');
});

test('mirrored review loops add no attempt the review already records', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-augment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const review: ReviewStatus = {
    id: 'review-run-1-dispatch',
    source: 'dispatch',
    mode: 'cold',
    loopNumber: 2,
    verdict: 'issues',
    unresolvedCount: 1,
    maxRetries: 1,
    attempts: [
      {
        mode: 'cold',
        loopNumber: 2,
        verdict: 'issues',
        unresolvedCount: 1,
        completedAt: '2026-10-20T01:00:00.000Z',
      },
    ],
  };
  for (const loop of [1, 2]) {
    const dir = path.join(root, 'artifacts', review.id, `review-loop-${loop}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'review-result.json'),
      JSON.stringify({ schemaVersion: 1, verdict: 'issues', issues: [], unresolvedCount: 1 }),
    );
    await writeFile(
      path.join(dir, 'review-diff-stat.json'),
      JSON.stringify({ capturedAt: `2026-10-20T00:${loop}0:00.000Z` }),
    );
  }

  const [augmented] = await augmentReviewAttemptsFromArtifacts(
    makeRun({ taskFile: path.join(root, 'TASK.md') }),
    [review],
  );

  assert.deepEqual(
    augmented!.attempts?.map((attempt) => [attempt.loopNumber, attempt.completedAt]),
    [
      [1, '2026-10-20T00:10:00.000Z'],
      [2, '2026-10-20T01:00:00.000Z'],
    ],
    'loop 1 is recovered from its artifacts; recorded loop 2 is not counted twice',
  );
});
