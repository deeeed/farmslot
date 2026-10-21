import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { ReadyGatePrPackage, ReviewStatus } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const completion = await import('../run-completion/orchestrator.js');
const inputs = await import('../review/reviewed-inputs.js');
const prerequisites = await import('./gate-prerequisites.js');
const artifacts = await import('./task-artifacts.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent, makeReadyGatePackage } = await import('./test-fixtures.js');
const { reviewDiffHash } = await import('../core/review-diff-identity.js');
const { computeReadyGateReviewSubjectHash } =
  await import('../run-completion/ready-gate-package.js');
let prepared: ReadyGatePrPackage;
let reviews: ReviewStatus[];
// Script package capture and policy readers; use the real refresh owner, diff verification,
// restamping and run store. No slot, worker or reviewer is launched.
mock.module('../run-completion/orchestrator.js', {
  namedExports: {
    ...completion,
    prepareCompletionPackageTransitionLocked: async () => ({
      prPackage: prepared,
      reviews,
      commit: async () => {},
    }),
  },
});
mock.module('../review/reviewed-inputs.js', {
  namedExports: { ...inputs, reviewedInputsChanged: async () => false },
});
mock.module('./gate-prerequisites.js', {
  namedExports: { ...prerequisites, refreshRunGateReadiness: async () => {} },
});
mock.module('./task-artifacts.js', {
  namedExports: { ...artifacts, getDiffStat: async () => prepared.diffStat },
});
const { refreshPublishPackage }: typeof import('./publish-package-refresh.js') = await import(
  new URL('./publish-package-refresh.js?legacy-diff-refresh', import.meta.url).href
);
const patch =
  'diff --git a/f b/f\nindex abc1234..def5678 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n';

for (const tampered of [false, true])
  test(`package refresh ${tampered ? 'rejects altered' : 'preserves verified legacy'} pipeline diff evidence`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'package-legacy-diff-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'artifacts'));
    const bytes = tampered ? patch.replace('+b', '+changed') : patch;
    await writeFile(path.join(root, 'artifacts/review.diff'), bytes);
    const old = makeReadyGatePackage({
      headSha: 'head',
      reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
    });
    assert.ok(old.reviewSnapshot);
    old.reviewSnapshot = {
      ...old.reviewSnapshot,
      headSha: 'head',
      diffPath: undefined,
      diffHash: createHash('sha256').update(patch).digest('hex'),
    };
    old.reviewSubjectHash = computeReadyGateReviewSubjectHash(old);
    prepared = {
      ...old,
      id: 'new-package',
      reviewSnapshot: { ...old.reviewSnapshot, diffHash: reviewDiffHash(patch) },
    };
    prepared.reviewSubjectHash = computeReadyGateReviewSubjectHash(prepared);
    reviews = [
      {
        id: 'pipeline-pass',
        source: 'pipeline',
        mode: 'cold',
        loopNumber: 1,
        verdict: 'pass',
        unresolvedCount: 0,
        reviewerSessionId: 'retained-session',
        reviewedHeadSha: 'head',
        reviewedReviewSubjectHash: old.reviewSubjectHash,
        reviewSnapshot: { ...old.reviewSnapshot, diffPath: 'artifacts/review.diff' },
      },
    ];
    const run = createRun({
      flowType: 'dev',
      project: 'legacy-diff-refresh',
      ticketOrPr: 'LEGACY-DIFF',
    });
    t.after(() => deleteTestRunIfPresent(run.id));
    updateRun(run.id, {
      status: 'human-gating',
      slotId: null,
      taskFile: path.join(root, 'TASK.md'),
      engineState: { publishGate: { reviews } },
      decisions: [
        {
          id: 'gate',
          type: 'engine_human_gate',
          title: 'Publish',
          description: '',
          createdAt: '2026-10-21T00:00:00Z',
          actions: [],
          payload: {
            kind: 'ready',
            prNumber: null,
            repo: null,
            workerReport: '',
            branch: old.branch,
            diffStat: old.diffStat,
            prPackage: old,
          },
        },
      ],
    });
    await refreshPublishPackage({ runId: run.id, decisionId: 'gate' });
    const review = getRun(run.id)!.engineState!.publishGate!.reviews![0]!;
    assert.equal(review.reviewerSessionId, 'retained-session');
    if (tampered) assert.equal(review.reviewedReviewSubjectHash, old.reviewSubjectHash);
    else assert.equal(review.reviewedReviewSubjectHash, prepared.reviewSubjectHash);
    assert.equal(
      old.reviewSnapshot.diffHash,
      createHash('sha256').update(patch).digest('hex'),
      'historical package stays immutable',
    );
    assert.equal(await readFile(path.join(root, 'artifacts/review.diff'), 'utf8'), bytes);
    assert.equal(getRun(run.id)!.reviewRoundAdmissions, undefined, 'refresh starts no review');
  });
