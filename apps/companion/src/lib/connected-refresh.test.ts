import assert from 'node:assert/strict';
import test from 'node:test';

import { connectedRefresh } from './connected-refresh';

const recipeRuns = () => undefined;
const otherRecipeRun = () => undefined;

test('nothing is read until the gateway is connected', () => {
  assert.equal(connectedRefresh(null, recipeRuns, null), null);
  assert.equal(connectedRefresh(recipeRuns, recipeRuns, null), null);
});

test('a new target starts fresh and a reconnect keeps what is on screen', () => {
  assert.deepEqual(connectedRefresh(null, recipeRuns, 0), { reason: 'initial load', reset: true });
  assert.deepEqual(connectedRefresh(recipeRuns, recipeRuns, 1), {
    reason: 'connect',
    reset: false,
  });
  assert.deepEqual(connectedRefresh(recipeRuns, otherRecipeRun, 1), {
    reason: 'initial load',
    reset: true,
  });
});
