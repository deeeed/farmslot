import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  INTERACTIVE_CHECKLIST_MARKDOWN,
  resolveTaskProgressMarkdownPath,
  TASK_PROGRESS_MARKDOWN,
} from './progress-path.js';

test('resolveTaskProgressMarkdownPath keeps non-TASK files unchanged', () => {
  const selfReview = '/repo/tasks/feat/foo/SELF-REVIEW.md';
  assert.equal(resolveTaskProgressMarkdownPath(selfReview), selfReview);
});

test('resolveTaskProgressMarkdownPath maps TASK.md to sibling CHECKLIST.md', () => {
  const taskMd = path.join('/repo', 'tasks', 'feat', '112-0627', TASK_PROGRESS_MARKDOWN);
  assert.equal(
    resolveTaskProgressMarkdownPath(taskMd),
    path.join('/repo', 'tasks', 'feat', '112-0627', INTERACTIVE_CHECKLIST_MARKDOWN),
  );
});