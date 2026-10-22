import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { type ReviewGatePayload, type RunDecision } from '@farmslot/protocol';

import { farmslotRoot } from '../projects/repo-root.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { hasEngineDecisionWaiter, resolveEngineDecision } from './engine-decisions.js';
import {
  assertReviewSnapshotMatchesPullRequest,
  executeReviewGate,
  publishPinnedReview,
  refreshReviewGate,
  reviewEvidencePostArgs,
  shouldIncludeReviewEvidence,
} from './review-gate.js';

test('a superseded review-posting gate stops without dismissing the reopened run', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'missing-review-gate',
    ticketOrPr: '42',
  });
  updateRun(run.id, {
    status: 'human-gating',
    slotId: null,
    engineState: { generation: 1 },
  });
  const execution = executeReviewGate(run.id);
  t.after(async () => {
    for (const decision of getRun(run.id)!.decisions) resolveEngineDecision(decision.id, 'abort');
    await execution;
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  let decisionId: string | undefined;
  for (let i = 0; i < 400 && !(decisionId && hasEngineDecisionWaiter(decisionId)); i++) {
    decisionId = getRun(run.id)!.decisions.find((d) => d.type === 'engine_review_posting')?.id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(decisionId && hasEngineDecisionWaiter(decisionId));
  const afterReplay = structuredClone(
    updateRun(run.id, { status: 'blocked', engineState: { generation: 2 } }),
  );
  resolveEngineDecision(decisionId, 'superseded');
  await execution;
  assert.deepEqual(getRun(run.id), afterReplay, 'stale gate effects cannot overwrite replay state');
});

test('refresh preserves the fresh decision list and refuses an in-flight resolution or replacement', async (t) => {
  const tasks = path.join(farmslotRoot, '.sandbox/review-refresh-retained/tasks');
  await mkdir(tasks, { recursive: true });
  const root = await mkdtemp(path.join(tasks, 'review-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts/review.md'), 'Recommendation: COMMENT\nNew report');
  await writeFile(path.join(root, 'artifacts/result.png'), 'review image');
  await writeFile(
    path.join(root, 'artifacts/review-result.json'),
    JSON.stringify({ schemaVersion: 1, verdict: 'pass', recommendation: 'COMMENT', issues: [] }),
  );
  await writeFile(
    path.join(root, 'artifacts/line-comments.json'),
    JSON.stringify({
      comments: [],
      recommendation: 'COMMENT',
    }),
  );
  const run = createRun({
    flowType: 'review-pr',
    project: 'example',
    ticketOrPr: 'example/app#42',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  const payload: ReviewGatePayload = {
    kind: 'review',
    repo: 'example/app',
    prNumber: 42,
    reviewMd: 'Original',
    lineComments: [],
    recommendation: 'COMMENT',
  };
  const decision: RunDecision = {
    id: 'posting',
    type: 'engine_review_posting',
    title: 'Post',
    description: '',
    actions: [{ id: 'post', label: 'Post', style: 'primary' }],
    createdAt: new Date().toISOString(),
    payload,
  };
  updateRun(run.id, {
    taskFile: path.join(root, 'TASK.md'),
    decisions: [decision],
    reviewResult: { recommendation: 'APPROVE', reviewMd: 'Original', lineComments: [] },
  });
  const refreshing = refreshReviewGate(run.id);
  const sibling = { ...decision, id: 'sibling', type: 'engine_retrospective' as const };
  updateRun(run.id, { decisions: [decision, sibling] });
  const refreshed = await refreshing;
  assert.deepEqual(
    refreshed.decisions.map((entry) => entry.id),
    ['posting', 'sibling'],
  );
  assert.match((refreshed.decisions[0].payload as ReviewGatePayload).reviewMd, /New report/);
  assert.equal(refreshed.reviewResult?.recommendation, 'COMMENT');
  assert.match(refreshed.reviewResult.reviewMd, /New report/);
  assert.ok(
    (refreshed.decisions[0].payload as ReviewGatePayload).artifactManifest?.find(
      (artifact) => artifact.path === 'artifacts/result.png',
    ),
  );
  const { readRetainedRunText } = await import('../run-completion/retained-artifacts.js');
  assert.equal(await readRetainedRunText(refreshed, 'artifacts/result.png'), 'review image');
  await assert.rejects(readFile(path.join(root, 'artifacts/result.png')), { code: 'ENOENT' });
  for (const change of ['resolved', 'replaced']) {
    updateRun(run.id, { decisions: [structuredClone(decision)] });
    const request = refreshReviewGate(run.id);
    const changed = {
      ...decision,
      ...(change === 'resolved'
        ? {
            resolvedAt: new Date().toISOString(),
            resolvedAction: 'post',
            selectionData: { includedIndices: [] },
          }
        : { payload: { ...payload, reviewMd: 'Another refresh won' } }),
    };
    updateRun(run.id, { decisions: [changed] });
    await assert.rejects(request, /Review changed during refresh/);
    assert.deepEqual(getRun(run.id)!.decisions[0], changed);
  }
});

test('review evidence is included unless the operator explicitly excludes it', () => {
  assert.equal(shouldIncludeReviewEvidence(), true);
  assert.equal(shouldIncludeReviewEvidence({}), true);
  assert.equal(shouldIncludeReviewEvidence({ includeEvidence: true }), true);
  assert.equal(shouldIncludeReviewEvidence({ includeEvidence: false }), false);
});

test('review posting omits the evidence file argument when the operator excludes evidence', () => {
  assert.deepEqual(
    reviewEvidencePostArgs({ includeEvidence: false }, '/tmp/review-evidence.md'),
    [],
  );
  assert.deepEqual(reviewEvidencePostArgs({}, '/tmp/review-evidence.md'), [
    '--evidence-md-file',
    '/tmp/review-evidence.md',
  ]);
});

test('review posting requires an available snapshot for the current PR head', () => {
  const snapshot = {
    source: 'github-pr' as const,
    capturedAt: '2026-08-05T00:00:00.000Z',
    headSha: 'abcdef1234567890',
  };

  assert.doesNotThrow(() => assertReviewSnapshotMatchesPullRequest(snapshot, snapshot.headSha));
  assert.throws(
    () => assertReviewSnapshotMatchesPullRequest(undefined, snapshot.headSha),
    /snapshot is unavailable/i,
  );
  assert.throws(
    () => assertReviewSnapshotMatchesPullRequest(snapshot, 'fedcba0987654321'),
    /review is stale/i,
  );
  assert.throws(
    () =>
      assertReviewSnapshotMatchesPullRequest(
        {
          source: 'unavailable',
          capturedAt: snapshot.capturedAt,
          missingReason: 'diff-unavailable',
        },
        snapshot.headSha,
      ),
    /snapshot is unavailable/i,
  );
});

test('review publication stays pinned when the PR head advances during posting', async () => {
  const reviewedHeadSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let liveHeadSha = reviewedHeadSha;
  const writes: string[] = [];
  const warnings: Array<string | null | undefined> = [];

  await publishPinnedReview({
    reviewedHeadSha,
    postFormalReview: async (commitId) => {
      writes.push(`formal:${commitId}`);
      liveHeadSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    },
    postInlineComments: async (commitId) => {
      writes.push(`inline:${commitId}`);
    },
    fetchCurrentHeadSha: async () => liveHeadSha,
    onHeadAdvanced: (currentHeadSha) => warnings.push(currentHeadSha),
  });

  assert.deepEqual(writes, [`formal:${reviewedHeadSha}`, `inline:${reviewedHeadSha}`]);
  assert.deepEqual(warnings, [liveHeadSha]);
});
