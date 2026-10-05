import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateRecipeCliInput } from '../src/cli/support.js';
import { writeJsonFile } from '../src/core/json.js';
import {
  findLibraryRecipe,
  listRecipeFiles,
  listRecipeLibraryPlatforms,
  loadRecipeLibraries,
  logRecipeLibraryResolution,
  parseRecipeLibraryPath,
  personalRecipeLibraryRoot,
  resolveRecipeLibrarySources,
} from '../src/core/library.js';
import {
  digestLibraryAdapter,
  digestRecipeLibrary,
  libraryAdapterFiles,
  listLibraryFiles,
  MAX_LIBRARY_ADAPTER_FILES,
  readRecipeLibraryManifest,
} from '../src/core/library-manifest.js';
import { RecipeResolutionError } from '../src/core/resolution-error.js';

const terminalRecipe = (title: string) => ({
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title,
  description: 'Provides a terminal library recipe for resolution tests.',
  workflow: {
    entry: 'done',
    nodes: { done: { action: 'end', status: 'pass' } },
  },
});

test('active custom adapters resolve directory variants and preserve legacy qualified refs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-custom-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, {
    'shared/perps/smoke.recipe.json': terminalRecipe('Shared'),
    'terminal/perps/smoke.recipe.json': terminalRecipe('Terminal'),
  });
  const resolution = await loadRecipeLibraries([{ root }], { adapter: 'terminal' });
  assert.equal(resolution.recipes.get('perps.smoke')?.adapter, 'terminal');
  assert.equal(resolution.recipes.get('perps.smoke')?.document.title, 'Terminal');
  assert.equal(resolution.recipes.get('terminal.perps.smoke')?.document.title, 'Terminal');
});

test('library manifests declare inactive custom platform folders', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-platform-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, {
    'shared/perps/smoke.recipe.json': terminalRecipe('Shared'),
    'terminal/perps/smoke.recipe.json': terminalRecipe('Terminal'),
    'desktop/perps/smoke.recipe.json': terminalRecipe('Desktop'),
  });
  await writeJsonFile(path.join(root, 'recipe-library.json'), {
    platforms: ['terminal', 'desktop'],
  });
  const resolution = await loadRecipeLibraries([{ root }], { adapter: 'mobile' });
  assert.equal(resolution.recipes.get('perps.smoke')?.document.title, 'Shared');
  assert.equal(resolution.recipes.has('terminal.perps.smoke'), false);
  assert.equal(resolution.recipes.has('desktop.perps.smoke'), false);
});

test('a qualified custom reference survives a higher-priority generic recipe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-shadowed-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const high = path.join(root, 'high');
  const low = path.join(root, 'low');
  await createLibrary(high, { 'perps/smoke.recipe.json': terminalRecipe('High generic') });
  await createLibrary(low, { 'terminal/perps/smoke.recipe.json': terminalRecipe('Low terminal') });
  const resolution = await loadRecipeLibraries(
    [
      { name: 'high', root: high },
      { name: 'low', root: low },
    ],
    { adapter: 'terminal' },
  );
  assert.equal(resolution.recipes.get('perps.smoke')?.document.title, 'High generic');
  assert.equal(resolution.recipes.get('terminal.perps.smoke')?.document.title, 'Low terminal');
  assert.equal(resolution.recipes.get('terminal.perps.smoke')?.source, 'low');
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
      { name: 'team', root: '/tmp/team', origin: 'flag' },
      { name: 'personal', root: '/tmp/personal', origin: 'env' },
    ],
  );
});

test('a --library entry replaces the RECIPE_LIBRARY_PATH entry with the same name', async () => {
  assert.deepEqual(
    await resolveRecipeLibrarySources({
      cliEntries: ['team=/tmp/team-local'],
      env: { RECIPE_LIBRARY_PATH: 'team=/tmp/team:other=/tmp/other' },
    }),
    [
      { name: 'team', root: '/tmp/team-local', origin: 'flag', overrides: '/tmp/team' },
      { name: 'other', root: '/tmp/other', origin: 'env' },
    ],
  );
});

test('recipe-library.json keys are optional and declared paths stay inside the library', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, { 'smoke.recipe.json': terminalRecipe('Generic') });
  await writeJsonFile(path.join(root, 'recipe-library.json'), {});
  assert.deepEqual(await readRecipeLibraryManifest(root), {});
  assert.equal((await loadRecipeLibraries([{ root }])).recipes.has('smoke'), true);

  await mkdir(path.join(root, 'plugins'), { recursive: true });
  await writeFile(path.join(root, 'plugins', 'web.mjs'), 'export default {};\n');
  await writeJsonFile(path.join(root, 'actions.json'), { actions: {} });
  await writeJsonFile(path.join(root, 'recipe-library.json'), {
    platforms: ['web'],
    adapters: { web: { module: './plugins/web.mjs', extends: 'browser' } },
    actions: { shared: 'actions.json' },
    requires: { '@farmslot/recipe-cli': '>=0.1.0' },
    review: { ignored: true },
  });
  assert.deepEqual(await readRecipeLibraryManifest(root), {
    platforms: ['web'],
    adapters: { web: { module: './plugins/web.mjs', extends: 'browser' } },
    actions: { shared: 'actions.json' },
    requires: { '@farmslot/recipe-cli': '>=0.1.0' },
  });
  assert.deepEqual(await listRecipeLibraryPlatforms(root), ['core', 'extension', 'mobile', 'web']);

  await writeJsonFile(path.join(root, 'recipe-library.json'), {
    actions: { shared: '../outside.json' },
  });
  await writeJsonFile(path.join(path.dirname(root), 'outside.json'), {});
  t.after(() => rm(path.join(path.dirname(root), 'outside.json'), { force: true }));
  await assert.rejects(readRecipeLibraryManifest(root), /resolves outside its library root/u);

  await writeJsonFile(path.join(root, 'recipe-library.json'), { requires: { x: 'not a range' } });
  await assert.rejects(readRecipeLibraryManifest(root), /must be a semver range/u);
});

test('library digests cover recipes, manifests and actions only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, { 'smoke.recipe.json': terminalRecipe('One') });
  const first = await digestRecipeLibrary(root);
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'notes.md'), 'not part of the digest\n');
  assert.equal(await digestRecipeLibrary(root), first);
  await writeJsonFile(path.join(root, 'recipes', 'smoke.recipe.json'), terminalRecipe('Two'));
  assert.notEqual(await digestRecipeLibrary(root), first);
});

test('library digests cover each adapter plugin directory, its helper files included', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, { 'smoke.recipe.json': terminalRecipe('One') });
  await mkdir(path.join(root, 'plugins', 'web', 'lib'), { recursive: true });
  await writeFile(
    path.join(root, 'plugins', 'web', 'index.mjs'),
    "export { web } from './lib/web.mjs';\n",
  );
  await writeFile(path.join(root, 'plugins', 'web', 'lib', 'web.mjs'), 'export const web = {};\n');
  await writeFile(path.join(root, 'top.mjs'), 'export default {};\n');
  const web = { module: './plugins/web/index.mjs' };
  await writeJsonFile(path.join(root, 'recipe-library.json'), {
    adapters: { web, top: { module: './top.mjs' } },
  });
  const manifest = await readRecipeLibraryManifest(root);
  await mkdir(path.join(root, 'actions'), { recursive: true });
  await writeFile(path.join(root, 'actions', 'shared.mjs'), 'export const shared = 1;\n');
  assert.deepEqual(await libraryAdapterFiles(root, web), [
    'actions/shared.mjs',
    'plugins/web/index.mjs',
    'plugins/web/lib/web.mjs',
  ]);
  // A module at the library root covers itself (and actions/), not the whole library.
  assert.deepEqual(await libraryAdapterFiles(root, { module: './top.mjs' }), [
    'actions/shared.mjs',
    'top.mjs',
  ]);

  const library = await digestRecipeLibrary(root, manifest);
  const plugin = await digestLibraryAdapter(root, web);
  await writeFile(
    path.join(root, 'plugins', 'web', 'lib', 'web.mjs'),
    'export const web = { changed: 1 };\n',
  );
  assert.notEqual(await digestRecipeLibrary(root, manifest), library);
  assert.notEqual(await digestLibraryAdapter(root, web), plugin);

  // Nothing under the plugin directory is skipped silently: a dot-file counts, and a
  // node_modules or a symlinked directory (inside or outside the root) is refused.
  const before = await digestLibraryAdapter(root, web);
  await writeFile(path.join(root, 'plugins', 'web', '.helper.mjs'), 'export const hidden = 1;\n');
  assert.notEqual(await digestLibraryAdapter(root, web), before);
  await mkdir(path.join(root, 'plugins', 'web', 'node_modules', 'dep'), { recursive: true });
  await assert.rejects(digestLibraryAdapter(root, web), /is a node_modules/u);
  await rm(path.join(root, 'plugins', 'web', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'lib'));
  await symlink('../../lib', path.join(root, 'plugins', 'web', 'shared'));
  await assert.rejects(digestLibraryAdapter(root, web), /is a symlinked directory/u);
  await assert.rejects(digestRecipeLibrary(root, manifest), /is a symlinked directory/u);
  await rm(path.join(root, 'plugins', 'web', 'shared'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, 'plugins', 'web', 'shared'));
  await assert.rejects(digestLibraryAdapter(root, web), /is a symlinked directory/u);
  await rm(path.join(root, 'plugins', 'web', 'shared'));
  // The non-strict walker still skips what it always skipped.
  assert.deepEqual(await listLibraryFiles(root, 'plugins/web'), [
    'plugins/web/index.mjs',
    'plugins/web/lib/web.mjs',
  ]);

  await mkdir(path.join(root, 'plugins', 'big'));
  await writeFile(path.join(root, 'plugins', 'big', 'index.mjs'), 'export default {};\n');
  await Promise.all(
    Array.from({ length: MAX_LIBRARY_ADAPTER_FILES }, (_, index) =>
      writeFile(path.join(root, 'plugins', 'big', `f${index}.mjs`), ''),
    ),
  );
  await assert.rejects(
    digestLibraryAdapter(root, { module: './plugins/big/index.mjs' }),
    /sits in a directory of 1001 files \(at most 1000\)/u,
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
        origin: 'task',
        provenance: { kind: 'task', trust: 'unknown', name: 'task-local' },
      },
      { name: 'team', root: '/tmp/team', origin: 'flag' },
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

test('indexes canonical adapter directories without changing recipe ids', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-directories-'));
  try {
    const library = path.join(tempRoot, 'team');
    await createLibrary(library, {
      'alpha/smoke.recipe.json': terminalRecipe('Generic alpha'),
      'perps/smoke.recipe.json': terminalRecipe('Generic'),
      'wallet/ready.recipe.json': terminalRecipe('Generic wallet'),
      'core/perps/smoke.recipe.json': terminalRecipe('Core'),
      'extension/perps/smoke.recipe.json': terminalRecipe('Extension'),
      'mobile/alpha/smoke.recipe.json': terminalRecipe('Mobile alpha'),
      'mobile/perps/smoke.recipe.json': terminalRecipe('Mobile'),
    });

    const extension = await loadRecipeLibraries([{ root: library }], { adapter: 'extension' });
    assert.equal(extension.recipes.get('perps.smoke')?.document.title, 'Extension');
    assert.equal(extension.recipes.get('perps.smoke')?.adapter, 'extension');
    assert.equal(
      extension.recipes.get('perps.smoke')?.file,
      'recipes/extension/perps/smoke.recipe.json',
    );

    const mobile = await loadRecipeLibraries([{ root: library }], { adapter: 'mobile' });
    assert.equal(mobile.recipes.get('alpha.smoke')?.document.title, 'Mobile alpha');
    assert.equal(mobile.recipes.get('alpha.smoke')?.adapter, 'mobile');
    assert.equal(mobile.recipes.get('perps.smoke')?.document.title, 'Mobile');
    assert.equal(mobile.recipes.get('perps.smoke')?.adapter, 'mobile');

    const core = await loadRecipeLibraries([{ root: library }], { adapter: 'core' });
    assert.equal(core.recipes.get('perps.smoke')?.document.title, 'Core');
    assert.equal(core.recipes.get('perps.smoke')?.adapter, 'core');
    assert.equal(core.recipes.get('wallet.ready')?.document.title, 'Generic wallet');
    assert.equal(core.recipes.get('wallet.ready')?.adapter, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects canonical and legacy declarations for the same adapter recipe', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-duplicate-'));
  try {
    await createLibrary(tempRoot, {
      'mobile/perps/smoke.recipe.json': terminalRecipe('Canonical'),
      'perps/smoke.mobile.recipe.json': terminalRecipe('Legacy'),
    });

    await assert.rejects(
      loadRecipeLibraries([{ root: tempRoot }], { adapter: 'mobile' }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeResolutionError);
        assert.equal(error.code, 'RECIPE_LIBRARY_DUPLICATE_RECIPE');
        assert.match(error.message, /recipes\/mobile\/perps\/smoke[.]recipe[.]json/u);
        assert.match(error.message, /recipes\/perps\/smoke[.]mobile[.]recipe[.]json/u);
        return true;
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects an adapter filename without a recipe id', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-without-id-'));
  try {
    await createLibrary(tempRoot, {
      'mobile.recipe.json': terminalRecipe('Missing id'),
    });

    await assert.rejects(
      loadRecipeLibraries([{ root: tempRoot }], { adapter: 'extension' }),
      (error: unknown) => {
        assert.ok(error instanceof RecipeResolutionError);
        assert.equal(error.code, 'RECIPE_LIBRARY_RECIPE_INVALID');
        assert.match(error.message, /declares adapter mobile but has no recipe id/u);
        assert.match(error.userAction, /recipes\/mobile\/<name>[.]recipe[.]json/u);
        return true;
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('reports canonical and legacy variants across sources as shadows', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-shadow-'));
  try {
    const canonical = path.join(tempRoot, 'canonical');
    const legacy = path.join(tempRoot, 'legacy');
    await createLibrary(canonical, {
      'mobile/perps/smoke.recipe.json': terminalRecipe('Canonical'),
    });
    await createLibrary(legacy, {
      'perps/smoke.mobile.recipe.json': terminalRecipe('Legacy'),
    });

    const resolution = await loadRecipeLibraries(
      [
        { name: 'canonical', root: canonical },
        { name: 'legacy', root: legacy },
      ],
      { adapter: 'mobile' },
    );
    assert.equal(resolution.recipes.get('perps.smoke')?.document.title, 'Canonical');
    assert.deepEqual(resolution.recipes.get('perps.smoke')?.shadows, ['legacy']);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects adapter declarations in both the directory and filename', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-adapter-conflict-'));
  try {
    const redundant = path.join(tempRoot, 'redundant');
    const conflicting = path.join(tempRoot, 'conflicting');
    await createLibrary(redundant, {
      'mobile/perps/smoke.mobile.recipe.json': terminalRecipe('Ambiguous'),
    });
    await createLibrary(conflicting, {
      'mobile/perps/smoke.extension.recipe.json': terminalRecipe('Conflicting'),
    });

    for (const library of [redundant, conflicting]) {
      await assert.rejects(
        loadRecipeLibraries([{ root: library }], { adapter: 'mobile' }),
        (error: unknown) => {
          assert.ok(error instanceof RecipeResolutionError);
          assert.equal(error.code, 'RECIPE_LIBRARY_ADAPTER_DECLARATION_CONFLICT');
          assert.match(error.userAction, /recipes\/<adapter>\//u);
          return true;
        },
      );
    }
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

test('loading enforces requires and fails closed on packages the host cannot check', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-requires-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, { 'smoke.recipe.json': terminalRecipe('Smoke') });
  await writeJsonFile(path.join(root, 'recipe-library.json'), {
    requires: { '@farmslot/recipe-cli': '>=0.1.0' },
  });
  await assert.rejects(loadRecipeLibraries([{ name: 'lib', root }]), (error: unknown) => {
    assert.ok(error instanceof RecipeResolutionError);
    assert.equal(error.code, 'RECIPE_LIBRARY_REQUIREMENT_UNSATISFIED');
    assert.match(error.message, /cannot provide or check/u);
    return true;
  });
  const loaded = await loadRecipeLibraries([{ name: 'lib', root }], {
    packageVersions: { '@farmslot/recipe-cli': '0.1.0' },
  });
  assert.equal(loaded.recipes.has('smoke'), true);
  await assert.rejects(
    loadRecipeLibraries([{ name: 'lib', root }], {
      packageVersions: { '@farmslot/recipe-cli': '0.0.9' },
    }),
    /requires @farmslot\/recipe-cli >=0\.1\.0; this host has 0\.0\.9/u,
  );
});

test('invalid recipe-library.json fails with a typed error', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createLibrary(root, {});
  for (const content of [
    'not json',
    '[]',
    '{"platforms":"web"}',
    '{"actions":{"shared":"x.json"}}',
  ]) {
    await writeFile(path.join(root, 'recipe-library.json'), content);
    await assert.rejects(readRecipeLibraryManifest(root), (error: unknown) => {
      assert.ok(error instanceof RecipeResolutionError, content);
      assert.equal(error.code, 'RECIPE_LIBRARY_MANIFEST_INVALID', content);
      return true;
    });
  }
  await mkdir(path.join(root, 'plugins'));
  await writeJsonFile(path.join(root, 'recipe-library.json'), {
    adapters: { web: { module: './plugins' } },
  });
  await assert.rejects(readRecipeLibraryManifest(root), /not a regular file/u);
});

test('one walker serves loading and digesting: skipped entries, symlinks and containment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-walker-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await createLibrary(root, { 'smoke.recipe.json': terminalRecipe('Smoke') });
  const digest = await digestRecipeLibrary(root);

  await writeJsonFile(path.join(root, 'recipes', '.hidden.recipe.json'), terminalRecipe('Hidden'));
  await writeJsonFile(
    path.join(root, 'recipes', 'node_modules', 'nm.recipe.json'),
    terminalRecipe('Module'),
  );
  await mkdir(path.join(root, 'manifests'));
  await symlink('../manifests', path.join(root, 'recipes', 'linked'));
  assert.deepEqual(await listRecipeFiles(root), ['smoke.recipe.json']);
  assert.equal(await digestRecipeLibrary(root), digest);
  assert.deepEqual([...(await loadRecipeLibraries([{ root }])).recipes.keys()], ['smoke']);

  await writeJsonFile(path.join(outside, 'escape.json'), {});
  await symlink(
    path.join(outside, 'escape.json'),
    path.join(root, 'manifests', 'x.action-manifest.json'),
  );
  await assert.rejects(digestRecipeLibrary(root), /resolves outside its library root/u);
  assert.deepEqual(await listLibraryFiles(root, 'recipes'), ['recipes/smoke.recipe.json']);
});

test('library digests ignore CRLF versus LF line endings', async (t) => {
  const lf = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-lf-'));
  const crlf = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-crlf-'));
  t.after(() => rm(lf, { recursive: true, force: true }));
  t.after(() => rm(crlf, { recursive: true, force: true }));
  const text = `${JSON.stringify(terminalRecipe('Same'), null, 2)}\n`;
  for (const [root, content] of [
    [lf, text],
    [crlf, text.replaceAll('\n', '\r\n')],
  ] as const) {
    await mkdir(path.join(root, 'recipes'), { recursive: true });
    await writeFile(path.join(root, 'recipes', 'same.recipe.json'), content);
  }
  assert.equal(await digestRecipeLibrary(crlf), await digestRecipeLibrary(lf));
});

test('findLibraryRecipe resolves refs, platform aliases and shadowed library ids', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-find-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const high = path.join(root, 'high');
  const low = path.join(root, 'low');
  await createLibrary(high, { 'perps/smoke.recipe.json': terminalRecipe('High') });
  await createLibrary(low, {
    'perps/smoke.recipe.json': terminalRecipe('Low'),
    'terminal/perps/smoke.recipe.json': terminalRecipe('Low terminal'),
  });
  const sources = [
    { name: 'high', root: high },
    { name: 'low', root: low },
  ];
  const resolution = await loadRecipeLibraries(sources, { adapter: 'terminal' });
  const byRef = await findLibraryRecipe('perps.smoke', sources, resolution, {
    adapter: 'terminal',
  });
  assert.deepEqual([byRef?.resolvedBy, byRef?.recipe.document.title], ['ref', 'High']);
  const alias = await findLibraryRecipe('terminal.perps.smoke', sources, resolution, {
    adapter: 'terminal',
  });
  assert.deepEqual([alias?.resolvedBy, alias?.recipe.document.title], ['alias', 'Low terminal']);
  const id = await findLibraryRecipe('low.perps.smoke', sources, resolution, {
    adapter: 'terminal',
  });
  assert.deepEqual([id?.resolvedBy, id?.recipe.source], ['id', 'low']);
  assert.equal(await findLibraryRecipe('nope.perps.smoke', sources, resolution), undefined);
});

test('the hello example loads in a host that provides only the harness', async () => {
  const hello = fileURLToPath(new URL('../../../examples/recipe-library-hello', import.meta.url));
  const result = await validateRecipeCliInput({
    recipePath: path.join(hello, 'recipes', 'greet-twice.recipe.json'),
    actionManifestPath: path.join(hello, 'manifests', 'shared.action-manifest.json'),
    librarySources: [{ name: 'hello', root: hello }],
    params: { guest: 'Ada' },
  });
  assert.equal(result.status, 'valid');
  const loaded = await loadRecipeLibraries([{ name: 'hello', root: hello }]);
  assert.equal(loaded.recipes.has('greet-twice'), true);
});

test('a malformed library path entry is a typed error', () => {
  for (const value of ['team=', '=/tmp/team']) {
    assert.throws(
      () => parseRecipeLibraryPath(value),
      (error: unknown) =>
        error instanceof RecipeResolutionError && error.code === 'RECIPE_LIBRARY_PATH_INVALID',
    );
  }
});

test('digestRecipeLibrary rejects declared files outside the library on its own', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-digest-escape-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-digest-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await createLibrary(root, { 'smoke.recipe.json': terminalRecipe('Smoke') });
  await writeJsonFile(path.join(outside, 'actions.json'), { actions: {} });
  await symlink(path.join(outside, 'actions.json'), path.join(root, 'linked.json'));
  // No reader validation first: the digest helper must refuse by itself.
  await assert.rejects(
    digestRecipeLibrary(root, { actions: { shared: 'linked.json' } }),
    /resolves outside its library root/u,
  );
});

test('run logging reports shadows only for the refs it uses', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-library-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const high = path.join(root, 'high');
  const low = path.join(root, 'low');
  await createLibrary(high, {
    'used.recipe.json': terminalRecipe('H'),
    'other.recipe.json': terminalRecipe('H'),
  });
  await createLibrary(low, {
    'used.recipe.json': terminalRecipe('L'),
    'other.recipe.json': terminalRecipe('L'),
  });
  const resolution = await loadRecipeLibraries([
    { name: 'high', root: high },
    { name: 'low', root: low },
  ]);
  const warnings: string[] = [];
  const logger = { info() {}, warn: (line: string) => void warnings.push(line), error() {} };
  logRecipeLibraryResolution(logger, resolution, new Set(['used']));
  assert.deepEqual(warnings, ['Recipe used resolves from high and shadows low.']);
});
