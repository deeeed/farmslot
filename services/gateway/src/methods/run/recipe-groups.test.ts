import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RecipeRunArtifactGroup, Run } from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const groups = [
  { id: 'current-artifacts', recipeRunId: null, artifactRoot: '/proof/artifacts' },
  { id: 'live-run:new', recipeRunId: 'new', artifactRoot: '/proof/artifacts/recipe-runs/new' },
] as RecipeRunArtifactGroup[];
const run = { id: 'run', liveRecipeContext: { recipeRunId: 'new' } } as Run;
mock.module('../../runs/store.js', {
  namedExports: { getRun: () => run, listRuns: () => [], listRunsForSlotHistory: () => [] },
});
mock.module('../../live-recipe/context.js', {
  namedExports: {
    attachLiveRecipeContext: async () => run,
    listRecipeRunArtifactGroupsForRun: async () => groups,
  },
});
mock.module('../../run-engine/gate-prerequisites.js', {
  namedExports: { refreshRunGateReadiness: async (value: Run) => value },
});
mock.module('../../run-engine/gate-summary.js', {
  namedExports: { enrichDecisionsWithGateSummary: (value: Run) => value },
});
mock.module('./evidence-review.js', {
  namedExports: {
    readRunRecordedEvidence: async (_run: Run, group: RecipeRunArtifactGroup) => ({
      artifactPrefix: 'artifacts/',
      errors: [],
      input: { groupId: group.id },
    }),
  },
});
const { runRecipeRunsForRun } = await import('./context.js');

test('stale live-run links preserve current groups and refuse only timed evidence', async () => {
  const result = await runRecipeRunsForRun({
    runId: run.id,
    recipeRunId: 'live-run:previous',
    includeRecordedEvidence: true,
  });
  assert.deepEqual(result.recipeRuns, groups);
  assert.equal(result.selectedRecipeRunId, 'live-run:new');
  assert.equal(result.recordedEvidence?.input, undefined);
  assert.match(result.recordedEvidence?.errors.join(' ') ?? '', /no longer available/);
  const valid = await runRecipeRunsForRun({
    runId: run.id,
    recipeRunId: 'current-artifacts',
    includeRecordedEvidence: true,
  });
  assert.equal(valid.selectedRecipeRunId, 'current-artifacts');
  assert.deepEqual(valid.recordedEvidence?.errors, []);
});
