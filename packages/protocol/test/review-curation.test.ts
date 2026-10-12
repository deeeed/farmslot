import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewGatePayload } from '../src/contracts/runs.js';
import { buildRunResolveDecisionParams } from '../src/runs/decision-resolution.js';
import {
  assertReviewCurationFresh,
  createReviewCuration,
  reviewCurationView,
  reviewedFindingContext,
  reviewPostingFingerprint,
  selectReviewFindings,
  toggleReviewFinding,
} from '../src/runs/review-curation.js';
const payload: ReviewGatePayload = {
  kind: 'review',
  prNumber: 42,
  repo: 'example/app',
  recommendation: 'REQUEST_CHANGES',
  reviewMd: 'Saved original review report.',
  reviewSnapshot: {
    source: 'github-pr',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    capturedAt: '2026-10-12T00:00:00Z',
    diffHash: 'diff',
  },
  lineComments: [
    { path: 'src/a.ts', line: 2, body: 'Handle A.', severity: 'major' },
    { path: 'src/a.ts', line: 3, body: 'Handle B.', severity: 'minor' },
  ],
};
test('all findings start selected; toggles and an empty selection are explicit', () => {
  const state = createReviewCuration(payload);
  assert.deepEqual(state.includedIndices, [0, 1]);
  const onlyB = toggleReviewFinding(state, 0);
  assert.deepEqual(onlyB.includedIndices, [1]);
  const none = toggleReviewFinding(onlyB, 1);
  assert.deepEqual(none.includedIndices, []);
  assert.deepEqual(selectReviewFindings(payload, { ...none }).lineComments, []);
  assert.deepEqual(
    reviewCurationView(payload, onlyB).findings.map((x) => x.included),
    [false, true],
  );
  assert.deepEqual(
    payload.lineComments.map((x) => x.body),
    ['Handle A.', 'Handle B.'],
  );
});
test('evidence choice follows attachable markdown rather than media file extensions', () => {
  const mediaOnly = {
    ...payload,
    artifactManifest: [{ path: 'evidence.webm', type: 'video' as const }],
  };
  assert.equal(
    reviewCurationView(mediaOnly, createReviewCuration(mediaOnly)).evidenceAvailable,
    false,
  );
  for (const evidenceMarkdown of ['', '  ', '![Proof](https://example.test/evidence.gif)']) {
    const review = { ...mediaOnly, evidenceMarkdown };
    assert.equal(
      reviewCurationView(review, createReviewCuration(review)).evidenceAvailable,
      Boolean(evidenceMarkdown.trim()),
    );
  }
});
test('selected result carries the requested finding and preserves the original report', () => {
  const state = {
    ...createReviewCuration(payload),
    includedIndices: [1],
    recommendation: 'COMMENT' as const,
  };
  const selected = selectReviewFindings(payload, state as unknown as Record<string, unknown>);
  assert.equal(selected.lineComments[0].body, 'Handle B.');
  assert.equal(selected.recommendation, 'COMMENT');
  assert.equal(selected.reviewMd, payload.reviewMd);
  assert.equal(payload.recommendation, 'REQUEST_CHANGES');
});
test('reordered findings invalidate old indices even at the same reviewed SHA', () => {
  const state = createReviewCuration(payload);
  const changed = { ...payload, lineComments: [...payload.lineComments].reverse() };
  assert.throws(
    () => assertReviewCurationFresh(changed, state as unknown as Record<string, unknown>),
    /Review changed/,
  );
  const newState = { ...createReviewCuration(changed), includedIndices: [0] };
  assert.equal(
    selectReviewFindings(changed, newState as unknown as Record<string, unknown>).lineComments[0]
      .body,
    'Handle B.',
  );
});
test('fingerprint changes for reviewed inputs/report/recommendation and ignores refresh metadata', () => {
  for (const changed of [
    { ...payload, reviewMd: 'Replacement report' },
    { ...payload, recommendation: 'APPROVE' },
    { ...payload, reviewSnapshot: { ...payload.reviewSnapshot!, headSha: 'c'.repeat(40) } },
    {
      ...payload,
      reviewSnapshot: {
        ...payload.reviewSnapshot!,
        untrackedFiles: [{ path: 'new.ts', blobSha: 'd'.repeat(40), mode: '100644' as const }],
      },
    },
  ])
    assert.notEqual(reviewPostingFingerprint(changed), reviewPostingFingerprint(payload));
  assert.equal(
    reviewPostingFingerprint({
      ...payload,
      artifactUrls: { 'src/a.ts': 'https://example.test/transient' },
      reviewSnapshot: { ...payload.reviewSnapshot!, capturedAt: 'later', diffPath: 'other' },
    }),
    reviewPostingFingerprint(payload),
  );
});
test('request builder binds default review post and retains an explicitly captured old fingerprint', () => {
  const decision = { id: 'd', payload };
  const params = buildRunResolveDecisionParams({
    runId: 'r',
    decision,
    actionId: 'post',
    selectionData: { includedIndices: [] },
  });
  assert.equal(params.selectionData?.reviewFingerprint, reviewPostingFingerprint(payload));
  assert.deepEqual(params.selectionData?.includedIndices, []);
  const old = buildRunResolveDecisionParams({
    runId: 'r',
    decision,
    actionId: 'post',
    selectionData: { reviewFingerprint: 'old', includedIndices: [0] },
  });
  assert.equal(old.selectionData?.reviewFingerprint, 'old');
  assert.equal(
    buildRunResolveDecisionParams({ runId: 'r', decision, actionId: 'dismiss' }).selectionData,
    undefined,
  );
  assert.doesNotThrow(() => assertReviewCurationFresh(payload, { includedIndices: [1] }));
});
test('source context preserves the reviewed line and distinguishes unavailable line numbers', () => {
  const source = 'one\r\nREVIEWED LINE\r\nthree\r\n';
  const view = reviewedFindingContext(source, 2);
  assert.equal(view.available, true);
  assert.deepEqual(
    view.lines.find((x) => x.target),
    { number: 2, text: 'REVIEWED LINE', target: true },
  );
  for (const line of [0, 4, 1.5])
    assert.equal(reviewedFindingContext(source, line).available, false);
  assert.equal(reviewedFindingContext('', 1).available, false);
});
