import assert from 'node:assert/strict';
import test from 'node:test';

import { isRecipeFlowUpdate, type RecipeFlowUpdate } from '../src/recipe/index.js';

test('progress decoding preserves unknown totals and refuses inconsistent exact counters', () => {
  const update: RecipeFlowUpdate = {
    version: 1,
    recipeRunId: 'execution',
    rootId: '$root',
    activeId: 'first/read',
    progress: { current: 2, completed: 1, total: 4, remaining: 3, qualification: 'exact' },
  };
  assert.equal(isRecipeFlowUpdate(update), true);
  assert.equal(
    isRecipeFlowUpdate({
      ...update,
      progress: { ...update.progress, total: null, remaining: null, qualification: 'unknown' },
    }),
    true,
  );
  assert.equal(
    isRecipeFlowUpdate({ ...update, progress: { ...update.progress, remaining: 0 } }),
    false,
  );
  assert.equal(
    isRecipeFlowUpdate({ ...update, progress: { ...update.progress, total: 0, remaining: 0 } }),
    false,
  );
  assert.equal(isRecipeFlowUpdate({ ...update, recipeRunId: undefined }), false);
});
