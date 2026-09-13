import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoUnknownPlaceholders,
  collectPlaceholderTokens,
  renderTemplatePlaceholders,
} from '../../src/index.js';

test('renderTemplatePlaceholders expands supplied vars', () => {
  assert.equal(
    renderTemplatePlaceholders('cd {{REPO}} && cat {{TASK_DIR}}/TASK.md', {
      REPO: '/tmp/r',
      TASK_DIR: '.task/t1',
    }),
    'cd /tmp/r && cat .task/t1/TASK.md',
  );
});

test('renderTemplatePlaceholders fails hard on placeholders outside the var set', () => {
  assert.throws(
    () =>
      renderTemplatePlaceholders(
        'read {{ORIGINAL_TICKET}}',
        { TICKET: 'X-1' },
        'Worker template pr-complete.md',
      ),
    /Worker template pr-complete\.md.*\{\{ORIGINAL_TICKET\}\}/,
  );
});

test('malformed tokens are collected and rejected even when the name is "known"', () => {
  assert.deepEqual(
    [...collectPlaceholderTokens('a {{foo-bar}} b {{OK}}')],
    ['{{foo-bar}}', '{{OK}}'],
  );
  assert.throws(
    () => assertNoUnknownPlaceholders('{{foo-bar}}', ['foo-bar'], 'x'),
    /\{\{foo-bar\}\}/,
  );
  assert.doesNotThrow(() => assertNoUnknownPlaceholders('{{OK}}', new Set(['OK']), 'x'));
});
