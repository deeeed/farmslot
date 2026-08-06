import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateRecipeActionManifestDocument } from '@farmslot/protocol';

import {
  commandCenterActionManifest,
  commandCenterRecipeParams,
  recipeGraphUsesAnyAction,
  recipeUsesAnyAction,
} from './run-recipe.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const execFileAsync = promisify(execFile);

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
