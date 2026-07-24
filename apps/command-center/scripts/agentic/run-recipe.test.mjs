import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { validateRecipeActionManifestDocument } from '@farmslot/protocol';

import { commandCenterActionManifest, commandCenterRecipeParams } from './run-recipe.mjs';

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
