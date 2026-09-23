import assert from 'node:assert/strict';
import test from 'node:test';

import { codexReasoningEfforts, DEFAULT_CODEX_MODEL } from '../../src/contracts/runs.js';

test('GPT-6 Sol supports Codex max and ultra without changing the default', () => {
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-6-astra');
  assert.deepEqual(codexReasoningEfforts('gpt-6-sol'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ]);
});
