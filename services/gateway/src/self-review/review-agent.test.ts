import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { targetForChecklistBasename } from '../tasks/checklist-target.js';

import {
  reviewerChecklistBasename,
  reviewerFeedbackRelPath,
  scopeReviewFeedbackPath,
  selectRecoverableReviewContext,
  selfReviewChecklistMarkPrompt,
} from './review-agent.js';

test('restart recovery reclaims only the newest matching in-flight reviewer', () => {
  const context = (id: string, status: AgentContext['status'], scope: string | null) =>
    ({
      id,
      role: 'self-review',
      label: id,
      status,
      slotId: 'slot-1',
      runId: 'run-1',
      runner: 'claude',
      taskFile: `tasks/run-1/SELF-REVIEW.${id}.md`,
      signalFile: `tasks/run-1/SELF-REVIEW.${id}-SIGNAL.json`,
      artifactScope: scope,
      target: { session: 'ff-1', window: id, pane: null, target: `ff-1:${id}` },
    }) satisfies AgentContext;
  const contexts = [
    context('rev-claude', 'working', 'independent-review-2'),
    context('rev1-claude', 'complete', 'independent-review-2'),
    { ...context('rev2-claude', 'working', 'independent-review-2'), reviewLoopNumber: 4 },
  ];

  const recovered = selectRecoverableReviewContext(contexts, {
    taskDir: 'tasks/run-1',
    runner: 'claude',
    artifactScope: 'independent-review-2',
  });
  assert.equal(recovered?.id, 'rev2-claude');
  assert.equal(recovered?.reviewLoopNumber, 4);
  assert.equal(
    selectRecoverableReviewContext(contexts, {
      taskDir: 'tasks/run-1',
      runner: 'claude',
      artifactScope: null,
    }),
    null,
  );
});

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
    'Write tasks/run-1/artifacts/review-feedback.md, include review-feedback.md in evidence, but leave docs/review-feedback.md alone.',
    reviewerFeedbackRelPath('rev-claude'),
  );

  assert.equal(
    scoped,
    'Write tasks/run-1/artifacts/review-feedback.rev-claude.md, include artifacts/review-feedback.rev-claude.md in evidence, but leave docs/review-feedback.md alone.',
  );
});

test('review agent appends scoped feedback path when template omits legacy path', () => {
  const scoped = scopeReviewFeedbackPath('Review the diff.', reviewerFeedbackRelPath('rev-codex'));

  assert.equal(
    scoped,
    'Review the diff.\n\nWrite reviewer feedback to artifacts/review-feedback.rev-codex.md.',
  );
});

test('review agent does not rewrite a similarly named artifact directory', () => {
  const scoped = scopeReviewFeedbackPath(
    'Keep my-artifacts/review-feedback.md; write artifacts/review-feedback.md, now.',
    reviewerFeedbackRelPath('rev-codex'),
  );

  assert.equal(
    scoped,
    'Keep my-artifacts/review-feedback.md; write artifacts/review-feedback.rev-codex.md, now.',
  );
});
