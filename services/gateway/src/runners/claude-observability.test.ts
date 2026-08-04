import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeSessionPaneMoveIsSafe } from './claude-observability.js';
import { makeVars } from './test-fixtures.js';

test('Claude session recovery refuses a second live pane for the same persisted session', async () => {
  const safe = await claudeSessionPaneMoveIsSafe(
    makeVars(),
    '%3',
    '%9',
    async (_vars, target) => target,
  );

  assert.equal(safe, false);
});

test('Claude session recovery permits a pane move after the recorded pane is gone', async () => {
  const safe = await claudeSessionPaneMoveIsSafe(makeVars(), '%3', '%9', async () => null);

  assert.equal(safe, true);
});
