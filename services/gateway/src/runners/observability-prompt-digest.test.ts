import assert from 'node:assert/strict';
import test from 'node:test';

import { instructionNeedle, runnerPromptDigest } from './observability-prompt-digest.js';

test('runnerPromptDigest is stable for normalized instruction text', () => {
  const message = '  Read TASK.md and follow checklist\n';
  const a = runnerPromptDigest(message);
  const b = runnerPromptDigest(`Read TASK.md and follow checklist`);
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.equal(instructionNeedle(message).length <= 160, true);
});
