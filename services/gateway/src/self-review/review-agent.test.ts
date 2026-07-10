import assert from 'node:assert/strict';
import { test } from 'node:test';

import { targetForChecklistBasename } from '../tasks/checklist-target.js';

import {
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  scopeReviewFeedbackPath,
  selfReviewChecklistMarkPrompt,
} from './review-agent.js';

test('review agent instructions use context-scoped checklist, signal, and feedback files', () => {
  const checklist = reviewerChecklistBasename('rev-codex-2');
  const feedback = reviewerFeedbackRelPath('rev-codex-2');
  const target = targetForChecklistBasename(checklist);

  assert.equal(checklist, 'SELF-REVIEW.rev-codex-2.md');
  assert.equal(target.signal, 'SELF-REVIEW.rev-codex-2-SIGNAL.json');
  assert.equal(feedback, 'artifacts/review-feedback.rev-codex-2.md');

  const prompt = selfReviewChecklistMarkPrompt(
    'tasks/run-1',
    `tasks/run-1/${checklist}`,
    target,
    feedback,
  );

  assert.match(prompt, /--checklist SELF-REVIEW\.rev-codex-2\.md/);
  assert.match(prompt, /--signal SELF-REVIEW\.rev-codex-2-SIGNAL\.json/);
  assert.match(prompt, /tasks\/run-1\/artifacts\/review-feedback\.rev-codex-2\.md/);
});

test('review agent scopes legacy template feedback paths to the reviewer context', () => {
  const scoped = scopeReviewFeedbackPath(
    'Write artifacts/review-feedback.md, then include review-feedback.md in evidence.',
    reviewerFeedbackRelPath('rev-claude'),
  );

  assert.equal(
    scoped,
    'Write artifacts/review-feedback.rev-claude.md, then include artifacts/review-feedback.rev-claude.md in evidence.',
  );
});

test('review agent appends scoped feedback path when template omits legacy path', () => {
  const scoped = scopeReviewFeedbackPath('Review the diff.', reviewerFeedbackRelPath('rev-codex'));

  assert.equal(
    scoped,
    'Review the diff.\n\nWrite reviewer feedback to artifacts/review-feedback.rev-codex.md.',
  );
});
