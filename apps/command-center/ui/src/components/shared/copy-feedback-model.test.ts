import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CopyFeedbackTimer } from './copy-feedback-model.js';

test('CopyFeedbackTimer shows copied key and clears after timeout', async () => {
  let copiedKey = '';
  const feedback = new CopyFeedbackTimer({
    copiedKey: () => copiedKey,
    setCopiedKey: (key) => {
      copiedKey = key;
    },
  });

  feedback.show('action-a', 10);
  assert.equal(copiedKey, 'action-a');

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(copiedKey, '');
});

test('CopyFeedbackTimer does not clear a newer copied key from an old timer', async () => {
  let copiedKey = '';
  const feedback = new CopyFeedbackTimer({
    copiedKey: () => copiedKey,
    setCopiedKey: (key) => {
      copiedKey = key;
    },
  });

  feedback.show('action-a', 10);
  copiedKey = 'action-b';

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(copiedKey, 'action-b');
});

test('CopyFeedbackTimer clear cancels pending feedback', async () => {
  let copiedKey = '';
  const feedback = new CopyFeedbackTimer({
    copiedKey: () => copiedKey,
    setCopiedKey: (key) => {
      copiedKey = key;
    },
  });

  feedback.show('action-a', 10);
  feedback.clear();

  assert.equal(copiedKey, '');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(copiedKey, '');
});
