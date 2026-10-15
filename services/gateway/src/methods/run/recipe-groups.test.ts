import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import '../../runtime/mock-pty.test-support.js';

import { deleteTestRunIfPresent, retainRunFixture } from '../../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../../runs/store.js';

import { runRecipeRunsForRun } from './context.js';

test('stale live-run links preserve retained groups and refuse only timed evidence', async (t) => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'retained-recipe-groups-'));
  const directory = path.join(taskDir, 'artifacts/recipe-runs/new');
  await mkdir(directory, { recursive: true });
  await cp(
    new URL(
      '../../../../../docs/examples/recipes/farmslot/artifacts/provenance-smoke/',
      import.meta.url,
    ),
    directory,
    { recursive: true },
  );
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/new' }),
  );
  const run = createRun({ flowType: 'dev', project: 'test-project', ticketOrPr: 'GROUPS' });
  updateRun(run.id, { taskFile: path.join(taskDir, 'TASK.md'), status: 'done' });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(taskDir, { recursive: true, force: true });
  });
  await retainRunFixture(getRun(run.id)!);
  const result = await runRecipeRunsForRun({
    runId: run.id,
    recipeRunId: 'live-run:previous',
    includeRecordedEvidence: true,
  });
  assert.equal(result.recipeRuns.length, 2);
  assert.equal(
    result.recipeRuns.find((group) => group.id === result.selectedRecipeRunId)?.promoted,
    true,
  );
  assert.equal(result.recordedEvidence?.input, undefined);
  assert.match(result.recordedEvidence?.errors.join(' ') ?? '', /no longer available/);
  const valid = await runRecipeRunsForRun({ runId: run.id, recipeRunId: 'current-artifacts' });
  assert.equal(valid.selectedRecipeRunId, 'current-artifacts');
  assert.deepEqual(valid.recipeRuns, result.recipeRuns);
});
