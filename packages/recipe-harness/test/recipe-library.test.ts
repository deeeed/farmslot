import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { writeJsonFile } from '../src/core/json.js';
import {
  loadRecipeLibraries,
  parseRecipeLibraryPath,
  personalRecipeLibraryRoot,
  resolveRecipeLibrarySources,
} from '../src/core/library.js';

const terminalRecipe = (title: string) => ({
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title,
  description: 'Provides a terminal library recipe for resolution tests.',
  workflow: {
    entry: 'done',
    nodes: { done: { action: 'end', status: 'pass' } },
  },
});

async function createLibrary(
  root: string,
  recipes: Record<string, Record<string, unknown>>,
): Promise<void> {
  await mkdir(path.join(root, 'recipes'), { recursive: true });
  for (const [file, document] of Object.entries(recipes)) {
    const target = path.join(root, 'recipes', file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeJsonFile(target, document);
  }
}

test('parses ordered library sources and resolves the personal default', async () => {
  assert.deepEqual(parseRecipeLibraryPath('team=/tmp/team:/tmp/personal'), [
    { name: 'team', root: '/tmp/team' },
    { root: '/tmp/personal' },
  ]);
  assert.equal(
    personalRecipeLibraryRoot({ FARMSLOT_HOME: '/tmp/farmslot-home' }),
    '/tmp/farmslot-home/recipe-library',
  );
  assert.deepEqual(
    await resolveRecipeLibrarySources({
      cliEntries: ['team=/tmp/team'],
      env: { RECIPE_LIBRARY_PATH: 'personal=/tmp/personal' },
    }),
    [
      { name: 'team', root: '/tmp/team' },
      { name: 'personal', root: '/tmp/personal' },
    ],
  );
});

test('places an adjacent task recipe library before configured sources', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-task-library-'));
  try {
    const taskDir = path.join(tempRoot, 'artifacts');
    const taskLibrary = path.join(taskDir, 'recipe-library');
    await createLibrary(taskLibrary, {});
    const sources = await resolveRecipeLibrarySources({
      recipePath: path.join(taskDir, 'recipe.json'),
      cliEntries: ['team=/tmp/team'],
      env: {},
    });
    assert.deepEqual(sources, [
      {
        name: 'task-local',
        root: taskLibrary,
        provenance: { kind: 'task', trust: 'unknown', name: 'task-local' },
      },
      { name: 'team', root: '/tmp/team' },
    ]);

    const snapshotSources = await resolveRecipeLibrarySources({
      recipePath: path.join(taskDir, 'resolved-recipes', `${'a'.repeat(64)}.recipe.json`),
      cliEntries: ['team=/tmp/team'],
      env: {},
    });
    assert.deepEqual(snapshotSources, sources);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('derives the source name from the configured alias or directory', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-source-'));
  try {
    await mkdir(path.join(tempRoot, 'recipes'), { recursive: true });
    const derived = await loadRecipeLibraries([{ root: tempRoot }]);
    assert.equal(derived.sources[0]?.name, path.basename(tempRoot));
    const named = await loadRecipeLibraries([{ name: 'team', root: tempRoot }]);
    assert.equal(named.sources[0]?.name, 'team');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('indexes recipe files with source precedence, adapter variants, and shadow visibility', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-'));
  try {
    const team = path.join(tempRoot, 'team');
    const personal = path.join(tempRoot, 'personal');
    await createLibrary(team, {
      'perps/smoke.recipe.json': terminalRecipe('Team generic'),
      'perps/smoke.mobile.recipe.json': terminalRecipe('Team mobile'),
    });
    await createLibrary(personal, {
      'perps/smoke.recipe.json': terminalRecipe('Personal generic'),
    });

    const mobile = await loadRecipeLibraries([{ root: team }, { root: personal }], {
      adapter: 'mobile',
    });
    assert.equal(mobile.recipes.size, 1);
    assert.equal(mobile.recipes.get('perps.smoke')?.document.title, 'Team mobile');
    assert.equal(mobile.recipes.get('perps.smoke')?.adapter, 'mobile');
    assert.deepEqual(mobile.recipes.get('perps.smoke')?.shadows, ['personal']);
    assert.deepEqual(
      mobile.sources.map((source) => [source.name, source.recipeCount]),
      [
        ['team', 1],
        ['personal', 1],
      ],
    );

    const extension = await loadRecipeLibraries([{ root: team }], { adapter: 'extension' });
    assert.equal(extension.recipes.size, 1);
    assert.equal(extension.recipes.get('perps.smoke')?.document.title, 'Team generic');
    assert.equal(extension.recipes.get('perps.smoke')?.adapter, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects invalid recipes and recipe symlinks that escape a library', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-invalid-'));
  try {
    const invalid = path.join(tempRoot, 'invalid');
    await createLibrary(invalid, {
      'bad.recipe.json': {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Intentionally invalid graph.',
        workflow: { entry: 'missing', nodes: {} },
      },
    });
    await assert.rejects(loadRecipeLibraries([{ root: invalid }]), /invalid_nodes/u);

    const outside = path.join(tempRoot, 'outside.recipe.json');
    await writeFile(outside, JSON.stringify(terminalRecipe('Outside')));
    const escaped = path.join(tempRoot, 'escaped');
    await createLibrary(escaped, {});
    await symlink(outside, path.join(escaped, 'recipes', 'linked.recipe.json'));
    await assert.rejects(loadRecipeLibraries([{ root: escaped }]), /outside its library root/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects duplicate source names', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-duplicate-'));
  try {
    const first = path.join(tempRoot, 'first');
    const second = path.join(tempRoot, 'second');
    await createLibrary(first, {});
    await createLibrary(second, {});
    await assert.rejects(
      loadRecipeLibraries([
        { name: 'same', root: first },
        { name: 'same', root: second },
      ]),
      /configured more than once/u,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
