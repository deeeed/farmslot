import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidenceReviewerHash,
  evidenceReviewerViewFromHash,
  evidenceReviewerViewKey,
  reviewLinkMatchesRun,
} from './evidence-reviewer-url-state.js';

test('a review view round-trips through the hash, other params kept', () => {
  const view = {
    claimId: 'AC-2',
    path: 'artifacts/stills/a.webp',
    recordingPath: 'artifacts/videos/alternate.mp4',
    atMs: 78_250,
    check: 0,
    timelinePage: 2,
  };
  const hash = evidenceReviewerHash(view, '#runs?run=r1&tab=evidence');
  assert.match(hash, /run=r1/);
  assert.match(hash, /tab=evidence/);
  assert.deepEqual(evidenceReviewerViewFromHash(hash), view);
});

test('closing the review drops only its params', () => {
  const hash = evidenceReviewerHash(
    null,
    '#runs?run=r1&review=AC-2&reviewFile=a.webp&reviewAt=3.0&reviewCheck=4&reviewTimeline=0&reviewRecording=a.mp4',
  );
  assert.equal(hash, '#runs?run=r1');
  assert.equal(evidenceReviewerViewFromHash(hash), null);
});

test('a malformed time or step is ignored, not applied', () => {
  assert.deepEqual(
    evidenceReviewerViewFromHash('#runs?review=AC-1&reviewAt=x&reviewCheck=1.5&reviewTimeline=-1'),
    {
      claimId: 'AC-1',
    },
  );
});

test('the view key matches what the link records, to a millisecond', () => {
  const shown = { claimId: 'AC-2', atMs: 78_213 };
  const linked = evidenceReviewerViewFromHash(evidenceReviewerHash(shown, '#runs?run=r1'));
  assert.equal(evidenceReviewerViewKey(shown), evidenceReviewerViewKey(linked));
  assert.notEqual(evidenceReviewerViewKey(shown), evidenceReviewerViewKey({ ...shown, check: 2 }));
  assert.equal(evidenceReviewerViewKey(null), '');
});

test('the first timeline page and a sub-frame seek survive a share link', () => {
  const view = { claimId: 'AC-1', path: 'artifacts/videos/run.mp4', atMs: 50, timelinePage: 0 };
  const hash = evidenceReviewerHash(view, '#run/r1');
  assert.match(hash, /reviewAt=0.050/);
  assert.deepEqual(evidenceReviewerViewFromHash(hash), view);
});

test('fractional seconds decode to integer milliseconds', () => {
  assert.equal(evidenceReviewerViewFromHash('#run/r1?review=AC-1&reviewAt=1.001')?.atMs, 1001);
});

test('an outgoing review cannot write its recording into another run route', () => {
  assert.equal(reviewLinkMatchesRun('r1', '#run/r2?review=AC-1'), false);
  assert.equal(reviewLinkMatchesRun('r1', '#runs?run=r2&review=AC-1'), false);
  assert.equal(reviewLinkMatchesRun('r1', '#runs'), false);
  assert.equal(reviewLinkMatchesRun('r1', '#run/r1?review=AC-1'), true);
  assert.equal(reviewLinkMatchesRun('r1', '#decisions?review=AC-1'), true);
});

test('a review link keeps the recipe group that owns the recording', () => {
  const view = { claimId: 'AC-1', recipeGroupId: 'recipe-run:older', timelinePage: 0 };
  const hash = evidenceReviewerHash(view, '#run/r1?tab=evidence');
  assert.deepEqual(evidenceReviewerViewFromHash(hash), view);
  assert.equal(evidenceReviewerHash(null, hash), '#run/r1?tab=evidence');
});

test('a timeline link retains its immutable recording revision', () => {
  const view = {
    claimId: 'AC-1',
    recordingPath: 'video.mp4',
    recipeGroupId: 'current-artifacts',
    recordingRevision: 'sha256:' + 'd'.repeat(64),
    atMs: 1032,
    timelinePage: 0,
  };
  const hash = evidenceReviewerHash(view, '#run/r1?tab=evidence');
  assert.deepEqual(evidenceReviewerViewFromHash(hash), view);
  assert.equal(evidenceReviewerHash(null, hash), '#run/r1?tab=evidence');
});
