import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RawProjectJson, SlotVars } from '../core/config.js';
import type { SlotScaffoldingArchiveOptions } from '../fleet/slot-scaffolding.js';
import { makeRun } from '../run-engine/test-fixtures.js';

const run = makeRun({
  id: 'cancelled-recipe-owner',
  slotId: 'recipe-slot',
  status: 'cancelled',
  taskFile: '/gateway/projects/example/tasks/fix/owned-task/TASK.md',
});
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    loadSlotVars: async () => ({ slotId: 'recipe-slot', remoteRepo: '/slot', host: 'localhost' }),
    loadProjectVars: async () => ({ projectJson: {} }),
    readSlotRow: async () => null,
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRunWithArchived: async () => run,
    runSessionArchiveDir: () => '/archive/owner',
  },
});
let collections = 0;
let fenceChecks = 0;
const collector = await import('../fleet/slot-scaffolding.js');
mock.module('../fleet/slot-scaffolding.js', {
  namedExports: {
    ...collector,
    archiveSlotScaffolding: async (
      vars: SlotVars,
      _project: RawProjectJson,
      options: SlotScaffoldingArchiveOptions,
    ) => {
      assert.equal(vars.remoteRepo, '/slot');
      assert.equal(options.taskRelativeDir, 'fix/owned-task');
      assert.equal(options.recipeOwnerRunId, run.id);
      assert.equal(options.recipeArtifactsOnly, true);
      await options.beforeRemove();
      collections++;
      return { directory: '/archive', roots: 1, moved: 0 };
    },
  },
});
const { archiveRunRecipeArtifacts } = await import('./recipe-artifacts.js');

test('terminal teardown uses the canonical worker task mapping without a legacy slot task cache', async () => {
  await archiveRunRecipeArtifacts(run, async () => {
    fenceChecks++;
  });
  assert.equal(collections, 1);
  assert.equal(fenceChecks, 2);
});
