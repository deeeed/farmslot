import assert from 'node:assert/strict';
import test from 'node:test';

import { codexReasoningEfforts, DEFAULT_CODEX_MODEL } from '../../src/contracts/runs.js';

test('GPT-6 Sol is the Codex default and supports max and ultra', () => {
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-6-sol');
  assert.deepEqual(codexReasoningEfforts('gpt-6-sol'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ]);
  assert.deepEqual(codexReasoningEfforts('gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
});
