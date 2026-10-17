import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recipeRepairId, type RecipeRepairScope } from '@farmslot/protocol';

import { resolveTaskRepairScope } from '../src/harness/repair-scope.js';

const packageHash = 'b'.repeat(64);
const scope: RecipeRepairScope = {
  schemaVersion: 1,
  repairId: recipeRepairId({ runId: 'run-1', packageHash, receiptIds: ['receipt-2'] }),
  runId: 'run-1',
  generation: 0,
  decisionId: 'decision-1',
  packageHash,
  packageHeadSha: 'c'.repeat(40),
  reviewBaseSha: 'd'.repeat(40),
  reviewId: 'review-1',
  workerContextId: 'run-1:dev',
  repairRecipe: 'recipes/visual-repair.json',
  claims: [
    { id: 'AC-1', claim: 'Kept.' },
    { id: 'AC-2', claim: 'Rejected.' },
  ],
  sources: [
    {
      recipeRunId: 'original',
      closureIdentity: `sha256:${'e'.repeat(64)}`,
      artifactRoot: 'artifacts/recipe-runs/original',
      headSha: 'c'.repeat(40),
    },
  ],
  retained: [{ claimId: 'AC-1', recipeRunId: 'original' }],
  rejected: [
    {
      claimId: 'AC-2',
      proofMode: 'visual',
      receiptId: 'receipt-2',
      reason: 'Blank chart.',
      recipeRunId: 'original',
      closureIdentity: `sha256:${'e'.repeat(64)}`,
      reviewedFiles: [],
      moments: [],
    },
  ],
};

async function task(t: test.TestContext, value: unknown = scope) {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'repair-scope-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await mkdir(path.join(taskDir, 'artifacts', 'recipe-runs', 'original'), { recursive: true });
  await mkdir(path.join(taskDir, 'recipes'), { recursive: true });
  await writeFile(path.join(taskDir, 'recipes', 'visual-repair.json'), '{}');
  await writeFile(path.join(taskDir, 'recipe.json'), '{}');
  await writeFile(
    path.join(taskDir, 'artifacts', 'visual-repair-scope.json'),
    JSON.stringify(value),
  );
  return taskDir;
}

test('the scope activates only for its own repair recipe and resolves contained sources', async (t) => {
  const taskDir = await task(t);
  const repair = resolveTaskRepairScope(
    taskDir,
    path.join(taskDir, 'recipes', 'visual-repair.json'),
  );
  assert.ok('repairScope' in repair && repair.repairScope);
  assert.equal(repair.repairScope.scope.repairId, scope.repairId);
  assert.match(repair.repairScope.sourceRoots.original!, /recipe-runs[\\/]original$/u);
  // The main task recipe runs normally and never inherits the scope.
  assert.deepEqual(resolveTaskRepairScope(taskDir, path.join(taskDir, 'recipe.json')), {});
  // No task, or no scope file, is a normal run.
  assert.deepEqual(resolveTaskRepairScope(null, path.join(taskDir, 'recipe.json')), {});
  await rm(path.join(taskDir, 'artifacts', 'visual-repair-scope.json'));
  assert.deepEqual(
    resolveTaskRepairScope(taskDir, path.join(taskDir, 'recipes', 'visual-repair.json')),
    {},
  );
});

test('an invalid scope, absent source or escaping source refuses the repair recipe', async (t) => {
  const repairRecipe = (taskDir: string) => path.join(taskDir, 'recipes', 'visual-repair.json');
  const forged = await task(t, { ...scope, repairId: 'repair-forged' });
  assert.match(
    String(Reflect.get(resolveTaskRepairScope(forged, repairRecipe(forged)), 'refusal')),
    /invalid/u,
  );
  const absent = await task(t, {
    ...scope,
    sources: [{ ...scope.sources[0]!, artifactRoot: 'artifacts/recipe-runs/missing' }],
  });
  assert.match(
    String(Reflect.get(resolveTaskRepairScope(absent, repairRecipe(absent)), 'refusal')),
    /not retained/u,
  );
  const escaping = await task(t, {
    ...scope,
    sources: [{ ...scope.sources[0]!, artifactRoot: 'artifacts/recipe-runs/link' }],
  });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'repair-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { symlink } = await import('node:fs/promises');
  await symlink(outside, path.join(escaping, 'artifacts', 'recipe-runs', 'link'));
  assert.match(
    String(Reflect.get(resolveTaskRepairScope(escaping, repairRecipe(escaping)), 'refusal')),
    /escapes/u,
  );
});
