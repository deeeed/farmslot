import assert from 'node:assert/strict';
import test from 'node:test';

import {
  desiredRecipeRunId,
  firstAvailableRecipeRunId,
  recipeRunIdExists,
  type RecipeRunIdLike,
  selectedRecipeRun,
} from './recipe-run-selection-model.js';

function run(id: string): RecipeRunIdLike {
  return { id };
}

test('recipe run selection helpers preserve id existence and fallback behavior', () => {
  const recipeRuns = [run('first'), run('second')];

  assert.equal(recipeRunIdExists(recipeRuns, 'second'), true);
  assert.equal(recipeRunIdExists(recipeRuns, 'missing'), false);
  assert.equal(recipeRunIdExists(recipeRuns, ''), false);
  assert.equal(firstAvailableRecipeRunId(recipeRuns), 'first');
  assert.equal(firstAvailableRecipeRunId([]), '');
  assert.equal(selectedRecipeRun(recipeRuns, 'second'), recipeRuns[1]);
  assert.equal(selectedRecipeRun(recipeRuns, 'missing'), recipeRuns[0]);
  assert.equal(selectedRecipeRun([], 'missing'), null);
});

test('desiredRecipeRunId chooses the first existing candidate before defaulting to first run', () => {
  const recipeRuns = [run('first'), run('pending'), run('current')];

  assert.equal(desiredRecipeRunId(recipeRuns, [null, 'missing', 'pending', 'current']), 'pending');
  assert.equal(desiredRecipeRunId(recipeRuns, ['missing', undefined]), 'first');
  assert.equal(desiredRecipeRunId([], ['missing']), '');
});
