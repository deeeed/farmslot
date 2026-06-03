import { strict as assert } from 'node:assert';
import test from 'node:test';

import { completedSlotViewRecipeRunId } from './slot-view-recipe-execution-model.js';

test('completedSlotViewRecipeRunId maps recipe completion requests to live run ids', () => {
  assert.equal(completedSlotViewRecipeRunId('req-123'), 'live-run:req-123');
  assert.equal(completedSlotViewRecipeRunId(''), null);
  assert.equal(completedSlotViewRecipeRunId(undefined), null);
});
