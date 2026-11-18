import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexReasoningEfforts,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  resolveCodexReasoningEffort,
} from '../../src/contracts/runs.js';

test('GPT-6.2 Sol is the Codex default and supports max and ultra', () => {
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-6.2-sol');
  const full = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
  assert.deepEqual(codexReasoningEfforts('gpt-6.2-sol'), [...full]);
  assert.deepEqual(codexReasoningEfforts('gpt-6.2-astra'), [...full]);
  assert.deepEqual(codexReasoningEfforts('gpt-6.1-sol'), [...full]);
  assert.deepEqual(codexReasoningEfforts('gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('Codex effort resolution shares defaults, auto and the model level set', () => {
  for (const effort of [undefined, null, '', '  '])
    assert.equal(resolveCodexReasoningEffort(effort), DEFAULT_CODEX_EFFORT);
  assert.equal(resolveCodexReasoningEffort(' AUTO '), undefined);
  assert.equal(resolveCodexReasoningEffort(' MAX ', 'gpt-6-luna'), 'max');
  assert.equal(resolveCodexReasoningEffort('ultra', 'gpt-6.2-sol'), 'ultra');
  assert.equal(resolveCodexReasoningEffort('ultra', 'gpt-6.1-sol'), 'ultra');
  for (const effort of ['ultra', 'invalid-level', '--help'])
    assert.throws(
      () => resolveCodexReasoningEffort(effort, 'gpt-6-luna'),
      /Invalid Codex reasoning effort/,
    );
});
