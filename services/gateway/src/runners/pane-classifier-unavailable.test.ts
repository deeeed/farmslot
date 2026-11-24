import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('../llm/index.js', {
  namedExports: {
    callLLM: async () => {
      throw new Error('403 forbidden: credential refused');
    },
  },
});

const { classifyRunnerPaneStateBestEffort } = await import('./pane-classifier.js');

test('a classifier that cannot be asked says so in a typed field', async () => {
  const verdict = await classifyRunnerPaneStateBestEffort({
    runner: 'claude',
    target: 'slot:dev',
    pane: '❯',
    expected: 'post-launch prompt ready for task delivery',
  });
  assert.equal(verdict.unavailable, true);
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.confidence, 0);
});
