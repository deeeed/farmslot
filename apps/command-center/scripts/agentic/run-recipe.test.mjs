import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateRecipeActionManifestDocument } from '@farmslot/protocol';
import { createRecipeRunner } from '@farmslot/recipe-runner';
import { createStandardCoreAdapters } from '@farmslot/recipe-runner/adapters/core';

import {
  COMMAND_CENTER_RECIPE_SOURCE,
  commandCenterActionManifest,
  commandCenterRecipeParams,
  recipeGraphUsesAnyAction,
  recipeUsesAnyAction,
  runCommandCenterTaskRecipe,
  selectCommandCenterTarget,
} from './run-recipe.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  acceptanceContractIssues,
} = require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs');

test('task recipes transport only the selected successful engine verdicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-task-recipe-'));
  const taskDir = path.join(root, 'task');
  const artifacts = path.join(taskDir, 'artifacts');
  const claim = 'The command observes one.';
  try {
    await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
    await mkdir(path.join(artifacts, 'recipe-runs'), { recursive: true });
    await writeFile(
      path.join(taskDir, 'inputs/handoff.json'),
      JSON.stringify({
        task: { acceptanceCriteria: [claim] },
      }),
    );
    const source = JSON.parse(
      await readFile(
        path.join(repoRoot, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
        'utf8',
      ),
    );
    const runner = createRecipeRunner({
      defaultSource: COMMAND_CENTER_RECIPE_SOURCE,
      actionManifest: commandCenterActionManifest(
        source,
        new Set(['command', 'assert_output', 'end']),
      ),
      adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output', 'end'] }),
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Prove the registered task through an executed output assertion.',
      proofTargets: [{ id: 'AC-1', claim, proofMode: 'state' }],
      workflow: {
        entry: 'read',
        nodes: {
          read: { action: 'command', intent: 'Observe output', cmd: 'printf one', next: 'assert' },
          assert: {
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
    const invoke = (recipeDocument, artifactsDir) =>
      runCommandCenterTaskRecipe(
        runner,
        {
          recipeDocument,
          adapter: 'core',
          artifactsDir,
          projectRoot: root,
        },
        'task',
      );
    const result = await invoke(recipe, path.join(artifacts, 'recipe-runs/first'));
    assert.equal(result.status, 'pass');
    const ledgerFile = path.join(artifacts, 'acceptance-status.json');
    const pointerFile = path.join(artifacts, 'latest-valid-recipe-run.json');
    const ledgerBytes = await readFile(ledgerFile, 'utf8');
    const pointerBytes = await readFile(pointerFile, 'utf8');
    const ledger = JSON.parse(ledgerBytes);
    assert.equal(ledger.recipeRunId, result.claims.recipeRunId);
    assert.equal(ledger.criteria[0].verdict, 'proven');
    assert.ok(
      ledger.criteria[0].evidence.every((file) => file.startsWith('artifacts/recipe-runs/first/')),
    );
    assert.deepEqual(acceptanceContractIssues(taskDir), []);
    assert.deepEqual(JSON.parse(await readFile(result.claimsPath, 'utf8')), result.claims);

    const failed = structuredClone(recipe);
    failed.workflow.nodes.assert.contains = 'two';
    assert.equal((await invoke(failed, path.join(artifacts, 'recipe-runs/failed'))).status, 'fail');
    assert.equal((await invoke(recipe, path.join(root, 'diagnostic'))).status, 'pass');
    assert.equal(await readFile(ledgerFile, 'utf8'), ledgerBytes);
    assert.equal(await readFile(pointerFile, 'utf8'), pointerBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recipe authentication and HUD stay on the configured UI origin', () => {
  const unrelated = { id: 'unrelated', type: 'page', url: 'https://example.com/#prs' };
  const board = { id: 'board', type: 'page', url: 'http://localhost:5175/#prs' };
  const fleet = { id: 'fleet', type: 'page', url: 'http://localhost:5175/#fleet' };
  assert.equal(
    selectCommandCenterTarget([unrelated, board], 'http://localhost:5175', '').id,
    'board',
  );
  assert.equal(
    selectCommandCenterTarget([unrelated, fleet, board], 'http://localhost:5175', '#prs').id,
    'board',
  );
  assert.throws(
    () => selectCommandCenterTarget([unrelated], 'http://localhost:5175', '#prs'),
    /No Command Center tab/,
  );
});

test('Command Center derives a strict manifest for only its implemented actions', async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
      'utf8',
    ),
  );
  const filtered = commandCenterActionManifest(
    { ...manifest, pre_conditions: [{ id: 'removed-v1-field' }] },
    new Set(['ui.navigate', 'ui.wait_for', 'end']),
  );

  assert.equal(validateRecipeActionManifestDocument(filtered).status, 'valid');
  assert.deepEqual(Object.keys(filtered.actions), ['end', 'ui.navigate', 'ui.wait_for']);
  assert.ok(
    filtered.observers.every((observer) =>
      observer.default_for.every((action) =>
        new Set(['ui.navigate', 'ui.wait_for', 'end']).has(action),
      ),
    ),
  );
  assert.equal(Object.hasOwn(filtered, 'pre_conditions'), false);
});

test('Command Center passes declared runtime values through canonical recipe params', () => {
  const recipe = {
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cdp_port: { type: 'number' },
        slot_id: { type: 'string' },
        run_id: { type: 'string' },
      },
    },
  };
  assert.deepEqual(
    commandCenterRecipeParams(
      recipe,
      { cdp_port: 9323, slot_id: 'slot-runtime', undeclared: 'ignored' },
      { slot_id: 'slot-explicit', run_id: 'run-123' },
    ),
    { cdp_port: 9323, slot_id: 'slot-explicit', run_id: 'run-123' },
  );
});

test('Command Center state-only recipes do not require a browser HUD', () => {
  const uiActions = new Set(['app.hud', 'ui.navigate', 'ui.screenshot']);
  assert.equal(
    recipeUsesAnyAction(
      { workflow: { nodes: { check: { action: 'command' }, done: { action: 'end' } } } },
      uiActions,
    ),
    false,
  );
  assert.equal(
    recipeUsesAnyAction({ workflow: { nodes: { visit: { action: 'ui.navigate' } } } }, uiActions),
    true,
  );
});

test('Command Center detects UI actions reachable only through called recipes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-command-center-ui-graph-'));
  const library = path.join(root, 'recipe-library');
  try {
    await mkdir(path.join(library, 'recipes', 'task'), { recursive: true });
    await writeFile(
      path.join(library, 'recipes', 'task', 'ui-child.recipe.json'),
      `${JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Navigates the Command Center from a called recipe.',
        workflow: {
          entry: 'visit',
          nodes: {
            visit: {
              action: 'ui.navigate',
              intent: 'Open the task surface.',
              url: '#/tasks',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      })}\n`,
    );
    const recipe = {
      workflow: {
        entry: 'call',
        nodes: {
          call: { action: 'call', ref: 'task.ui-child', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    };
    const uiActions = new Set(['app.hud', 'ui.navigate', 'ui.screenshot']);

    assert.equal(recipeUsesAnyAction(recipe, uiActions), false);
    assert.equal(
      await recipeGraphUsesAnyAction(recipe, uiActions, [{ name: 'task-local', root: library }]),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Command Center runs an adjacent task recipe library without manual configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-command-center-task-recipe-'));
  const artifacts = path.join(root, 'artifacts');
  const library = path.join(artifacts, 'recipe-library');
  try {
    await mkdir(path.join(library, 'recipes', 'task'), { recursive: true });
    await writeFile(
      path.join(library, 'recipes', 'task', 'write.recipe.json'),
      `${JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Writes a task-local proof marker.',
        paramsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['marker'],
          properties: { marker: { type: 'string' } },
        },
        workflow: {
          entry: 'write',
          nodes: {
            write: {
              action: 'command',
              intent: 'Write the requested proof marker.',
              cmd: 'touch {{params.marker}}',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      })}\n`,
    );
    const recipePath = path.join(artifacts, 'recipe.json');
    const manifestPath = path.join(root, 'action-manifest.json');
    const sourceManifest = JSON.parse(
      await readFile(
        path.join(repoRoot, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
        'utf8',
      ),
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        commandCenterActionManifest(sourceManifest, new Set(['command', 'end'])),
      )}\n`,
    );
    await writeFile(
      recipePath,
      `${JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Calls a task-local proof recipe.',
        paramsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['marker'],
          properties: { marker: { type: 'string' } },
        },
        workflow: {
          entry: 'call',
          nodes: {
            call: {
              action: 'call',
              intent: 'Reuse the task-local proof boundary.',
              ref: 'task.write',
              params: { marker: '{{params.marker}}' },
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      })}\n`,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'apps/command-center/scripts/agentic/run-recipe.mjs'),
        recipePath,
        '--project-root',
        root,
        '--artifacts-dir',
        path.join(artifacts, 'recipe-run'),
        '--action-manifest',
        manifestPath,
        '--input',
        'marker=command-center-proof.txt',
        '--cdp-port',
        '1',
        '--json',
      ],
      { cwd: repoRoot },
    );
    assert.match(stdout, /"status": "pass"/u);
    assert.equal(await readFile(path.join(root, 'command-center-proof.txt'), 'utf8'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Command Center rejects gestures not declared for the web adapter before CDP access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-command-center-adapter-'));
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, 'apps/companion/scripts/agentic/recipe/action-manifest.json'),
        'utf8',
      ),
    );
    const manifestPath = path.join(root, 'action-manifest.json');
    const recipePath = path.join(root, 'recipe.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(commandCenterActionManifest(manifest, new Set(['end', 'ui.pan'])))}\n`,
    );
    await writeFile(
      recipePath,
      `${JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Reject a gesture unavailable through the active web adapter.',
        workflow: {
          entry: 'gesture',
          nodes: {
            gesture: {
              action: 'ui.pan',
              intent: 'Move the requested surface.',
              target: 'gesture-surface',
              delta: { x: 20, y: 0 },
              duration_ms: 300,
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      })}\n`,
    );

    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          path.join(repoRoot, 'apps/command-center/scripts/agentic/run-recipe.mjs'),
          recipePath,
          '--project-root',
          root,
          '--artifacts-dir',
          path.join(root, 'artifacts'),
          '--action-manifest',
          manifestPath,
          '--cdp-port',
          '1',
          '--json',
        ]),
      /Adapter web does not support recipe action ui\.pan\. Supporting adapters: android, ios\./u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
