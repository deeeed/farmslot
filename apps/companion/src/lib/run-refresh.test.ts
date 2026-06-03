import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRefreshEventMatches, runRefreshEventMatchesSlotWorkspace } from './run-refresh';

test('run refresh matches full run events', () => {
  assert.equal(runRefreshEventMatches('run-a', { run: { id: 'run-a' } }), true);
});

test('run refresh matches compact run id events', () => {
  assert.equal(runRefreshEventMatches('run-a', { runId: 'run-a' }), true);
});

test('run refresh rejects unrelated run events', () => {
  assert.equal(runRefreshEventMatches('run-a', { run: { id: 'run-b' } }), false);
});

test('slot workspace refresh matches full run events on the slot', () => {
  assert.equal(
    runRefreshEventMatchesSlotWorkspace(
      { slotId: 'runner-mobile-1', workspaceRunId: 'run-a', knownRunIds: [] },
      { run: { id: 'run-new', slotId: 'runner-mobile-1' } },
    ),
    true,
  );
});

test('slot workspace refresh matches compact slot-scoped events before run hydration', () => {
  assert.equal(
    runRefreshEventMatchesSlotWorkspace(
      { slotId: 'runner-mobile-1', workspaceRunId: null, knownRunIds: [] },
      { runId: 'run-new', slotId: 'runner-mobile-1' },
    ),
    true,
  );
});

test('slot workspace refresh matches compact events for the focused run', () => {
  assert.equal(
    runRefreshEventMatchesSlotWorkspace(
      { slotId: 'runner-mobile-1', workspaceRunId: 'run-a', knownRunIds: [] },
      { runId: 'run-a' },
    ),
    true,
  );
});

test('slot workspace refresh matches compact events for visible history runs', () => {
  assert.equal(
    runRefreshEventMatchesSlotWorkspace(
      { slotId: 'runner-mobile-1', workspaceRunId: 'run-a', knownRunIds: ['run-old'] },
      { runId: 'run-old' },
    ),
    true,
  );
});

test('slot workspace refresh rejects unrelated compact run events', () => {
  assert.equal(
    runRefreshEventMatchesSlotWorkspace(
      { slotId: 'runner-mobile-1', workspaceRunId: 'run-a', knownRunIds: ['run-old'] },
      { runId: 'run-other' },
    ),
    false,
  );
});
