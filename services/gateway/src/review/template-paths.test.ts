import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { makeRun } from '../family-observability/test-fixtures.js';

import {
  renderReviewTemplatePaths,
  reviewFeedbackFileList,
  reviewFeedbackPathsForFix,
} from './template-paths.js';

test('reviewer path bindings scope explicit and legacy targets without rewriting unrelated documents', () => {
  const paths = {
    checklist: 'REVIEW.rev-test.md',
    signal: 'REVIEW.rev-test-SIGNAL.json',
    feedback: 'artifacts/review-feedback.rev-test.md',
  };
  const template =
    '{{TASK_DIR}}/{{REVIEW_CHECKLIST}} {{REVIEW_SIGNAL}} {{REVIEW_FEEDBACK}}\n{{TASK_DIR}}/SELF-REVIEW.md --checklist SELF-REVIEW.md --signal SELF-REVIEW-SIGNAL.json\nPreserve docs/REVIEW.md and my-REVIEW.md';
  assert.equal(
    renderReviewTemplatePaths(template, paths),
    '{{TASK_DIR}}/REVIEW.rev-test.md REVIEW.rev-test-SIGNAL.json artifacts/review-feedback.rev-test.md\n{{TASK_DIR}}/REVIEW.rev-test.md --checklist REVIEW.rev-test.md --signal REVIEW.rev-test-SIGNAL.json\nPreserve docs/REVIEW.md and my-REVIEW.md',
  );
});

test('fix instructions include every completed lane in the task, preserving a legacy fallback', () => {
  const context = (id: string, patch: Partial<AgentContext> = {}): AgentContext => ({
    id,
    runId: 'run-a',
    role: 'review',
    label: 'Review',
    slotId: 'slot-a',
    status: 'complete',
    taskFile: `tasks/run-a/REVIEW.${id}.md`,
    artifactScope: 'publication',
    ...patch,
  });
  const run = {
    ...makeRun(),
    agentContexts: [
      context('rev-one'),
      context('rev-two'),
      context('rev-two'),
      context('foreign', { taskFile: 'tasks/other/REVIEW.foreign.md' }),
      context('old', { artifactScope: 'pipeline' }),
      context('running', { status: 'working' }),
    ],
  };
  const paths = reviewFeedbackPathsForFix(run, 'tasks/run-a');
  assert.deepEqual(paths, [
    'artifacts/review-feedback.rev-one.md',
    'artifacts/review-feedback.rev-two.md',
    'artifacts/review-feedback.old.md',
  ]);
  assert.equal(
    reviewFeedbackFileList('tasks/run-a', paths),
    '- `tasks/run-a/artifacts/review-feedback.rev-one.md`\n- `tasks/run-a/artifacts/review-feedback.rev-two.md`\n- `tasks/run-a/artifacts/review-feedback.old.md`',
  );
  assert.deepEqual(reviewFeedbackPathsForFix(makeRun({}), 'tasks/run-a'), [
    'artifacts/review-feedback.md',
  ]);
});
