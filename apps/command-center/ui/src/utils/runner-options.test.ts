import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPARISON_LANE_RUNNERS,
  EVAL_CANDIDATE_RUNNERS,
  isRestorableModelId,
  runnerLabel,
} from './runner-options.js';

test('comparison runners use the registered evaluation choices', () => {
  assert.ok(EVAL_CANDIDATE_RUNNERS.every((runner) => COMPARISON_LANE_RUNNERS.has(runner)));
  assert.equal(runnerLabel('codex'), 'Codex');
});

test('restored model identifiers accept custom provider ids without whitespace', () => {
  assert.equal(isRestorableModelId('ollama/qwen2.5-coder'), true);
  assert.equal(isRestorableModelId('invalid model'), false);
  assert.equal(isRestorableModelId(null), false);
});
