import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RecipeClaimLedger } from '@farmslot/protocol';

import { runExpoRecipeDocument } from '../src/runner.js';

test('native host transports only successful selected task claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-native-task-recipe-'));
  const taskDir = path.join(root, 'task');
  const appRoot = path.join(root, 'app');
  const artifacts = path.join(taskDir, 'artifacts');
  const recipePath = path.join(root, 'recipe.json');
  const manifestPath = fileURLToPath(
    new URL('../templates/scripts/agentic/recipe/action-manifest.json', import.meta.url),
  );
  const previousTask = process.env.RECIPE_TASK_DIR;
  const previousPlatform = process.env.PLATFORM;
  const claim = 'The command observes one.';
  process.env.RECIPE_TASK_DIR = taskDir;
  process.env.PLATFORM = 'web';
  try {
    await mkdir(appRoot);
    await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
    await mkdir(path.join(artifacts, 'recipe-runs'), { recursive: true });
    await writeFile(
      path.join(taskDir, 'inputs/handoff.json'),
      JSON.stringify({ task: { acceptanceCriteria: [claim] } }),
    );
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Prove a registered task criterion through an executed output assertion.',
      proofTargets: [{ id: 'AC-1', claim, proofMode: 'state' }],
      workflow: {
        entry: 'read',
        nodes: {
          read: { action: 'command', intent: 'Observe output', cmd: 'printf one', next: 'check' },
          check: {
            action: 'assert_output',
            intent: 'Check output',
            source: 'read',
            contains: 'one',
            proves: ['AC-1'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    await writeFile(recipePath, JSON.stringify(recipe));
    const invoke = (artifactsDir: string) =>
      runExpoRecipeDocument(recipePath, { projectRoot: appRoot, manifestPath, artifactsDir });
    const result = await invoke(path.join(artifacts, 'recipe-runs/first'));
    assert.equal(result.status, 'pass');
    const ledgerFile = path.join(artifacts, 'acceptance-status.json');
    const pointerFile = path.join(artifacts, 'latest-valid-recipe-run.json');
    const ledgerBytes = await readFile(ledgerFile, 'utf8');
    const pointerBytes = await readFile(pointerFile, 'utf8');
    const ledger = JSON.parse(ledgerBytes) as RecipeClaimLedger;
    assert.equal(ledger.recipeRunId, result.claims.recipeRunId);
    assert.equal(ledger.criteria[0].verdict, 'proven');
    assert.ok(
      ledger.criteria[0].evidence.every((file) => file.startsWith('artifacts/recipe-runs/first/')),
    );
    assert.deepEqual(JSON.parse(await readFile(result.claimsPath, 'utf8')), result.claims);

    recipe.workflow.nodes.check.contains = 'two';
    await writeFile(recipePath, JSON.stringify(recipe));
    assert.equal((await invoke(path.join(artifacts, 'recipe-runs/failed'))).status, 'fail');
    recipe.workflow.nodes.check.contains = 'one';
    await writeFile(recipePath, JSON.stringify(recipe));
    assert.equal((await invoke(path.join(root, 'diagnostic'))).status, 'pass');
    assert.equal(await readFile(ledgerFile, 'utf8'), ledgerBytes);
    assert.equal(await readFile(pointerFile, 'utf8'), pointerBytes);
  } finally {
    if (previousTask === undefined) delete process.env.RECIPE_TASK_DIR;
    else process.env.RECIPE_TASK_DIR = previousTask;
    if (previousPlatform === undefined) delete process.env.PLATFORM;
    else process.env.PLATFORM = previousPlatform;
    await rm(root, { recursive: true, force: true });
  }
});
