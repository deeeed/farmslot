import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type RecipeActionManifestDocument, validateRecipeDocument } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { validateRecipeCliInput } from '../src/cli/support.js';
import { composeRecipe } from '../src/core/compose.js';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import {
  defaultRecipeLibrarySources,
  loadRecipeLibraries,
  parseRecipeLibraryPath,
  resolveRecipeLibrarySources,
} from '../src/core/library.js';
import { createRecipeRunner as createRawRecipeRunner } from '../src/core/runner.js';
import { RecipeTrustError } from '../src/core/trust-error.js';
import type { RecipeLogger, SummaryDocument } from '../src/core/types.js';

const coreActionManifest: RecipeActionManifestDocument = {
  runner_protocol_version: 1,
  action_registry_version: 1,
  supported_official_actions: [
    'end',
    'wait',
    'command',
    'assert_file',
    'assert_json',
    'assert_exit_code',
    'assert_output',
    'state_read',
    'watch_logs',
    'index_artifacts',
    'call',
    'switch',
    'manual',
  ],
};

function createRecipeRunner(options: Parameters<typeof createRawRecipeRunner>[0]) {
  return createRawRecipeRunner({
    ...options,
    adapters: options.adapters.map((adapter) => ({
      ...adapter,
      source: adapter.source ?? {
        kind: 'bundled',
        trust: 'trusted',
        name: 'recipe library test',
      },
    })),
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'recipe library test' },
  });
}

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'farmslot-recipe-library-'));
}

async function createLibrary(
  root: string,
  options: {
    name?: string;
    flows: Record<string, unknown>;
    catalogFile?: string;
  },
): Promise<void> {
  await mkdir(path.join(root, 'flows'), { recursive: true });
  await writeJsonFile(path.join(root, 'library.json'), {
    kind: 'recipe-library',
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    schema_version: 1,
    ...(options.name ? { name: options.name } : {}),
  });
  await writeJsonFile(path.join(root, 'flows', options.catalogFile ?? 'main.flows.json'), {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    schema_version: 1,
    kind: 'recipe-flow-catalog',
    flows: options.flows,
  });
}

function writeTextFlow(fileName: string, text: string): Record<string, unknown> {
  return {
    description: `Write ${text} to ${fileName}.`,
    paramsSchema: { type: 'object' },
    workflow: {
      entry: 'write',
      nodes: {
        write: {
          action: 'command',
          intent: `Write ${text} for the library flow test`,
          cmd: `node -e "require('fs').writeFileSync('${fileName}','${text}')"`,
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

function collectingLogger(): RecipeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info(message: string) {
      lines.push(`info ${message}`);
    },
    warn(message: string) {
      lines.push(`warn ${message}`);
    },
    error(message: string) {
      lines.push(`error ${message}`);
    },
  };
}

test('parseRecipeLibraryPath parses ordered name=path and bare path entries', () => {
  const sources = parseRecipeLibraryPath('personal=/tmp/personal:/tmp/team-library');
  assert.deepEqual(sources, [
    { name: 'personal', root: '/tmp/personal' },
    { root: '/tmp/team-library' },
  ]);
  assert.throws(() => parseRecipeLibraryPath('=/tmp/broken'), /name=path or path/);
});

test('resolveRecipeLibrarySources prefers CLI entries, then env, then the personal default', async () => {
  const tempRoot = await createTempRoot();
  try {
    const farmslotHomeDir = path.join(tempRoot, 'farmslot-home');
    await createLibrary(path.join(farmslotHomeDir, 'recipe-library'), {
      flows: { 'lib.noop': writeTextFlow('noop.txt', 'noop') },
    });

    const explicit = await resolveRecipeLibrarySources({
      cliEntries: ['mine=/tmp/mine'],
      env: { RECIPE_LIBRARY_PATH: 'team=/tmp/team', FARMSLOT_HOME: farmslotHomeDir },
    });
    assert.deepEqual(explicit, [
      { name: 'mine', root: '/tmp/mine' },
      { name: 'team', root: '/tmp/team' },
    ]);

    const defaults = await resolveRecipeLibrarySources({
      env: { FARMSLOT_HOME: farmslotHomeDir },
    });
    assert.deepEqual(defaults, [
      { name: 'personal', root: path.join(farmslotHomeDir, 'recipe-library') },
    ]);

    const none = await defaultRecipeLibrarySources({
      FARMSLOT_HOME: path.join(tempRoot, 'missing-home'),
    });
    assert.deepEqual(none, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('loadRecipeLibraries merges ordered sources and records shadowing loudly', async () => {
  const tempRoot = await createTempRoot();
  try {
    const personalRoot = path.join(tempRoot, 'personal');
    const teamRoot = path.join(tempRoot, 'team');
    await createLibrary(personalRoot, {
      flows: { 'lib.write-text': writeTextFlow('personal.txt', 'personal') },
    });
    await createLibrary(teamRoot, {
      name: 'team-named',
      flows: {
        'lib.write-text': writeTextFlow('team.txt', 'team'),
        'lib.team-only': writeTextFlow('team-only.txt', 'team-only'),
      },
    });

    const logger = collectingLogger();
    const resolution = await loadRecipeLibraries(
      [{ name: 'personal', root: personalRoot }, { root: teamRoot }],
      logger,
    );

    assert.deepEqual(
      resolution.sources.map((source) => [source.name, source.flowCount]),
      [
        ['personal', 1],
        ['team-named', 2],
      ],
    );
    const winner = resolution.flows.get('lib.write-text');
    assert.equal(winner?.source, 'personal');
    assert.deepEqual(winner?.shadows, ['team-named']);
    assert.equal(resolution.flows.get('lib.team-only')?.source, 'team-named');
    assert.ok(
      logger.lines.some((line) =>
        line.includes('warn Flow lib.write-text resolves from personal and shadows team-named'),
      ),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('composeRecipe inlines library flows into a self-contained recipe', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libRoot = path.join(tempRoot, 'lib');
    await createLibrary(libRoot, {
      flows: {
        'lib.write-text': writeTextFlow('out.txt', 'hi'),
        // An unrelated library flow the recipe never calls; it must NOT be inlined.
        'lib.unused': writeTextFlow('unused.txt', 'nope'),
      },
    });

    const recipe = {
      schema_version: 1,
      title: 'Library composed',
      description: 'Calls a flow resolved from a library source.',
      uses: [],
      validate: {
        workflow: {
          entry: 'call-lib',
          nodes: {
            'call-lib': {
              action: 'call',
              intent: 'Run a library flow',
              ref: 'lib.write-text',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };

    const { resolved, flowCount } = await composeRecipe(recipe, {
      projectRoot: tempRoot,
      recipeDir: tempRoot,
      librarySources: [{ root: libRoot }],
    });
    assert.equal(flowCount, 1);
    const resolvedRecipe = resolved as { flows: Record<string, unknown>; uses?: unknown };
    // Only the reachable flow is inlined — never the whole library.
    assert.deepEqual(Object.keys(resolvedRecipe.flows), ['lib.write-text']);
    // `uses` is dropped so the recipe resolves purely from inline `flows`.
    assert.ok(!('uses' in resolvedRecipe));

    // The composed recipe is self-contained: full validation resolves the call.ref
    // without any library context.
    assert.equal(validateRecipeDocument(resolved).status, 'valid');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('composeRecipe follows transitive calls and drops unreachable inline flows', async () => {
  const tempRoot = await createTempRoot();
  try {
    const callFlow = (ref: string): Record<string, unknown> => ({
      workflow: {
        entry: 'call',
        nodes: {
          call: { action: 'call', intent: `Call ${ref}`, ref, next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    const libRoot = path.join(tempRoot, 'lib');
    await createLibrary(libRoot, {
      flows: {
        'lib.a': callFlow('lib.b'), // reachable via the recipe, and calls lib.b
        'lib.b': writeTextFlow('b.txt', 'b'), // reachable transitively through lib.a
        'lib.unused': writeTextFlow('u.txt', 'u'), // never called — must be excluded
      },
    });

    const recipe = {
      schema_version: 1,
      title: 'Transitive composition',
      description: 'Reaches lib.a -> lib.b; an unreachable inline flow has an unresolved call.',
      flows: {
        // Never called by the workflow; it references a missing flow, so keeping it
        // would fail full validation once `uses` is dropped. It must be excluded.
        'inline.dead': {
          entry: 'x',
          nodes: {
            x: { action: 'call', intent: 'Dead call', ref: 'missing.ref', next: 'done' },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
      validate: {
        workflow: {
          entry: 'go',
          nodes: {
            go: { action: 'call', intent: 'Run lib.a', ref: 'lib.a', next: 'done' },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };

    const { resolved, flowCount } = await composeRecipe(recipe, {
      projectRoot: tempRoot,
      recipeDir: tempRoot,
      librarySources: [{ root: libRoot }],
    });
    const resolvedRecipe = resolved as { flows: Record<string, unknown> };
    assert.equal(flowCount, 2);
    assert.deepEqual(Object.keys(resolvedRecipe.flows).sort(), ['lib.a', 'lib.b']);
    // Unreachable inline flow with an unresolved call was dropped, so it validates.
    assert.equal(validateRecipeDocument(resolved).status, 'valid');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('loadRecipeLibraries rejects non-libraries and duplicate refs within one source', async () => {
  const tempRoot = await createTempRoot();
  try {
    await mkdir(path.join(tempRoot, 'not-a-library'), { recursive: true });
    await assert.rejects(
      loadRecipeLibraries([{ root: path.join(tempRoot, 'not-a-library') }]),
      /is not a recipe library/,
    );

    const duplicated = path.join(tempRoot, 'duplicated');
    await createLibrary(duplicated, {
      flows: { 'lib.write-text': writeTextFlow('a.txt', 'a') },
    });
    await writeJsonFile(path.join(duplicated, 'flows', 'other.flows.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: { 'lib.write-text': writeTextFlow('b.txt', 'b') },
    });
    await assert.rejects(
      loadRecipeLibraries([{ name: 'dup', root: duplicated }]),
      /declared more than once in library dup/,
    );

    const badCatalog = path.join(tempRoot, 'bad-catalog');
    await createLibrary(badCatalog, { flows: {} });
    await writeJsonFile(path.join(badCatalog, 'flows', 'bad.flows.json'), { flows: {} });
    await assert.rejects(
      loadRecipeLibraries([{ root: badCatalog }]),
      /must declare kind "recipe-flow-catalog"/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('runs a recipe composed from a library flow and reports the resolution in evidence', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, {
      flows: { 'lib.write-text': writeTextFlow('from-library.txt', 'library-ok') },
    });
    const teamRoot = path.join(tempRoot, 'team');
    await createLibrary(teamRoot, {
      flows: { 'lib.write-text': writeTextFlow('from-team.txt', 'team') },
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Library call recipe',
      description: 'Calls a flow resolved from a configured recipe library.',
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Run the library flow without declaring it in the recipe',
              ref: 'lib.write-text',
              next: 'assert-flow-output',
            },
            'assert-flow-output': {
              action: 'assert_file',
              intent: 'Verify the library flow wrote its output',
              path: 'from-library.txt',
              contains: 'library-ok',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writeJsonFile(recipePath, recipe);
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const artifactsDir = path.join(tempRoot, 'artifacts');
    const result = await runner.run({
      recipePath,
      artifactsDir,
      projectRoot: tempRoot,
      librarySources: [
        {
          name: 'personal',
          root: libraryRoot,
          provenance: { kind: 'library', trust: 'trusted', name: 'personal' },
        },
        {
          name: 'team',
          root: teamRoot,
          provenance: { kind: 'library', trust: 'trusted', name: 'team' },
        },
      ],
    });
    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'from-library.txt'), 'utf-8'), 'library-ok');

    const summary = (await readJsonFile(result.summaryPath)) as SummaryDocument;
    assert.deepEqual(
      summary.flowResolution?.sources.map((source) => [source.name, source.flowCount]),
      [
        ['personal', 1],
        ['team', 1],
      ],
    );
    assert.deepEqual(
      summary.flowResolution?.used.map((entry) => [entry.ref, entry.source, entry.file]),
      [['lib.write-text', 'personal', path.join('flows', 'main.flows.json')]],
    );
    assert.deepEqual(summary.flowResolution?.overrides, []);
    assert.deepEqual(summary.flowResolution?.shadowed, [
      {
        ref: 'lib.write-text',
        source: 'personal',
        file: path.join('flows', 'main.flows.json'),
        shadows: ['team'],
      },
    ]);

    const resolvedFlows = (await readJsonFile(path.join(artifactsDir, 'resolved-flows.json'))) as {
      kind: string;
      flows: Record<string, { source: string }>;
      shadowed: Array<{ ref: string; shadows: string[] }>;
    };
    assert.equal(resolvedFlows.kind, 'recipe-resolved-flows');
    assert.equal(resolvedFlows.flows['lib.write-text']?.source, 'personal');
    assert.deepEqual(
      resolvedFlows.shadowed.map((entry) => [entry.ref, entry.shadows]),
      [['lib.write-text', ['team']]],
    );

    const artifactManifest = (await readJsonFile(result.artifactManifestPath)) as {
      artifacts: Array<{ path: string }>;
    };
    assert.ok(
      artifactManifest.artifacts.some((entry) => entry.path === 'resolved-flows.json'),
      'resolved-flows.json must be registered in the artifact manifest',
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('recipe-local flows win over library flows and the override is logged', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, {
      flows: { 'lib.write-text': writeTextFlow('from-library.txt', 'library') },
    });
    const recipe = {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Recipe-local override recipe',
      description: 'Declares a flow inline that also exists in a library source.',
      flows: { 'lib.write-text': writeTextFlow('from-recipe.txt', 'recipe-local') },
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Run the recipe-local flow declaration',
              ref: 'lib.write-text',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    };
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writeJsonFile(recipePath, recipe);
    const logger = collectingLogger();
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
      logger,
    });
    const result = await runner.run({
      recipePath,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      librarySources: [{ name: 'personal', root: libraryRoot }],
    });
    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'from-recipe.txt'), 'utf-8'), 'recipe-local');
    assert.ok(
      logger.lines.some((line) =>
        line.includes(
          'warn Flow lib.write-text is declared by the recipe and overrides the personal library declaration',
        ),
      ),
    );
    const summary = (await readJsonFile(result.summaryPath)) as SummaryDocument;
    assert.deepEqual(summary.flowResolution?.used, []);
    assert.deepEqual(summary.flowResolution?.overrides, [
      { ref: 'lib.write-text', source: 'personal' },
    ]);

    // Even with every library flow overridden, the resolution activity is
    // still evidence: resolved-flows.json records the overrides.
    const resolvedFlows = (await readJsonFile(
      path.join(tempRoot, 'artifacts', 'resolved-flows.json'),
    )) as {
      kind: string;
      flows: Record<string, unknown>;
      overrides: Array<{ ref: string; source: string }>;
    };
    assert.equal(resolvedFlows.kind, 'recipe-resolved-flows');
    assert.deepEqual(resolvedFlows.flows, {});
    assert.deepEqual(resolvedFlows.overrides, [{ ref: 'lib.write-text', source: 'personal' }]);
    const artifactManifest = (await readJsonFile(result.artifactManifestPath)) as {
      artifacts: Array<{ path: string }>;
    };
    assert.ok(
      artifactManifest.artifacts.some((entry) => entry.path === 'resolved-flows.json'),
      'resolved-flows.json must be registered even when every library flow is overridden',
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('validate accepts library-resolved call refs only when sources are configured', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, {
      flows: { 'lib.write-text': writeTextFlow('from-library.txt', 'library-ok') },
    });
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writeJsonFile(recipePath, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Library call recipe',
      description: 'Calls a flow resolved from a configured recipe library.',
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Run the library flow without declaring it in the recipe',
              ref: 'lib.write-text',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    });
    const without = await validateRecipeCliInput({ recipePath });
    assert.equal(without.status, 'invalid');
    assert.ok(without.findings.some((finding) => finding.code === 'workflow.unresolved_call_ref'));

    const withLibrary = await validateRecipeCliInput({
      recipePath,
      librarySources: [{ name: 'personal', root: libraryRoot }],
    });
    assert.equal(withLibrary.status, 'valid');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects library flow catalogs symlinked outside the declared source root', async () => {
  const tempRoot = await createTempRoot();
  try {
    const sharedCatalog = path.join(tempRoot, 'shared-catalog.flows.json');
    await writeJsonFile(sharedCatalog, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: { 'lib.linked': writeTextFlow('linked.txt', 'linked') },
    });
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, { flows: {} });
    await rm(path.join(libraryRoot, 'flows', 'main.flows.json'));
    await symlink(sharedCatalog, path.join(libraryRoot, 'flows', 'linked.flows.json'));

    await assert.rejects(
      loadRecipeLibraries([{ name: 'personal', root: libraryRoot }]),
      (error: unknown) => {
        assert.ok(error instanceof RecipeTrustError);
        assert.equal(error.code, 'RECIPE_SOURCE_INVALID');
        assert.equal(error.message.includes(tempRoot), false);
        assert.match(error.message, /flows[/\\]linked\.flows\.json/);
        return true;
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('flows list without any configured source fails loudly', async () => {
  const previousExitCode = process.exitCode;
  const previousLibraryPath = process.env.RECIPE_LIBRARY_PATH;
  const previousHome = process.env.FARMSLOT_HOME;
  const tempRoot = await createTempRoot();
  const originalError = console.error;
  try {
    delete process.env.RECIPE_LIBRARY_PATH;
    process.env.FARMSLOT_HOME = path.join(tempRoot, 'empty-home');
    const errors: string[] = [];
    console.error = (...values: unknown[]) => {
      errors.push(values.map((value) => String(value)).join(' '));
    };
    await runRecipeHarnessCli(['flows', 'list']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('No recipe library sources configured')));
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
    if (previousLibraryPath === undefined) delete process.env.RECIPE_LIBRARY_PATH;
    else process.env.RECIPE_LIBRARY_PATH = previousLibraryPath;
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('flows list prints library flows with source and precedence details', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, {
      flows: { 'lib.write-text': writeTextFlow('from-library.txt', 'library-ok') },
    });
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(' '));
    };
    try {
      await runRecipeHarnessCli([
        'flows',
        'list',
        '--library',
        `personal=${libraryRoot}`,
        '--json',
      ]);
    } finally {
      console.log = originalLog;
    }
    const document = JSON.parse(lines.join('\n')) as {
      sources: Array<{ name: string }>;
      flows: Array<{ ref: string; source: string; description?: string }>;
      nextCommand?: string;
    };
    assert.deepEqual(
      document.sources.map((source) => source.name),
      ['personal'],
    );
    assert.equal(document.flows[0]?.ref, 'lib.write-text');
    assert.equal(document.flows[0]?.source, 'personal');
    assert.ok(document.flows[0]?.description?.includes('from-library.txt'));
    assert.equal(
      document.nextCommand,
      `farmslot-recipe flows describe lib.write-text --library personal=${libraryRoot} --json`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('flows describe returns the resolved definition, provenance, parameters, and authored call node', async () => {
  const tempRoot = await createTempRoot();
  try {
    const personalRoot = path.join(tempRoot, 'personal');
    const teamRoot = path.join(tempRoot, 'team');
    const flow = {
      description: 'Write a requested marker.',
      paramsSchema: {
        type: 'object',
        required: ['marker'],
        properties: {
          marker: { type: 'string' },
          suffix: { type: 'string', default: '.txt' },
        },
      },
      workflow: {
        entry: 'done',
        nodes: { done: { action: 'end', status: 'pass' } },
      },
      examples: [
        {
          description: 'Write the demo marker',
          node: {
            action: 'call',
            ref: 'lib.marker',
            params: { marker: 'demo' },
            intent: 'Write the demo marker',
          },
        },
      ],
    };
    await createLibrary(personalRoot, { flows: { 'lib.marker': flow } });
    await createLibrary(teamRoot, { flows: { 'lib.marker': flow } });

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(' '));
    };
    try {
      await runRecipeHarnessCli([
        'flows',
        'describe',
        'lib.marker',
        '--library',
        `personal=${personalRoot}`,
        '--library',
        `team=${teamRoot}`,
        '--json',
      ]);
    } finally {
      console.log = originalLog;
    }

    const document = JSON.parse(lines.join('\n')) as {
      schemaVersion: number;
      command: string;
      status: string;
      flow: {
        ref: string;
        source: string;
        sourceRoot: string;
        sourcePrecedence: number;
        file: string;
        path: string;
        parameters: { required: string[]; defaults: Record<string, unknown> };
        shadows: Array<{ name: string; root: string; precedence: number }>;
        definition: Record<string, unknown>;
        callNode: Record<string, unknown>;
        callNodeSource: string;
      };
      nextCommand: string;
    };
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.command, 'flows describe');
    assert.equal(document.status, 'pass');
    assert.equal(document.flow.ref, 'lib.marker');
    assert.equal(document.flow.source, 'personal');
    assert.equal(document.flow.sourceRoot, personalRoot);
    assert.equal(document.flow.sourcePrecedence, 1);
    assert.equal(document.flow.path, path.join(personalRoot, document.flow.file));
    assert.deepEqual(document.flow.parameters.required, ['marker']);
    assert.deepEqual(document.flow.parameters.defaults, { suffix: '.txt' });
    assert.deepEqual(document.flow.shadows, [{ name: 'team', root: teamRoot, precedence: 2 }]);
    assert.deepEqual(document.flow.definition, flow);
    assert.deepEqual(document.flow.callNode, flow.examples[0]?.node);
    assert.equal(document.flow.callNodeSource, 'authored-example');
    assert.equal(
      document.nextCommand,
      `farmslot-recipe flows describe lib.marker --library personal=${personalRoot} --library team=${teamRoot} --json`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('flows describe teaches recovery when the ref is unavailable', async () => {
  const previousExitCode = process.exitCode;
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, {
      flows: { 'lib.available': writeTextFlow('available.txt', 'available') },
    });
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(' '));
    };
    try {
      await runRecipeHarnessCli(
        ['flows', 'describe', 'lib.missing', '--library', `personal=${libraryRoot}`, '--json'],
        { commandName: 'project-recipe' },
      );
    } finally {
      console.log = originalLog;
    }
    const document = JSON.parse(lines.join('\n')) as {
      status: string;
      exitCode: number;
      error: { code: string; userAction: string };
      availableFlows: string[];
    };
    assert.equal(process.exitCode, 1);
    assert.equal(document.status, 'error');
    assert.equal(document.exitCode, 1);
    assert.equal(document.error.code, 'FLOW_NOT_FOUND');
    assert.equal(
      document.error.userAction,
      `Run project-recipe flows list --library personal=${libraryRoot} --json to inspect 1 available flow(s).`,
    );
    assert.deepEqual(document.availableFlows, ['lib.available']);
  } finally {
    process.exitCode = previousExitCode;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('flows describe labels a generated call node as a template', async () => {
  const tempRoot = await createTempRoot();
  try {
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, {
      flows: { 'lib.available': writeTextFlow('available.txt', 'available') },
    });
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(' '));
    };
    try {
      await runRecipeHarnessCli([
        'flows',
        'describe',
        'lib.available',
        '--library',
        `personal=${libraryRoot}`,
        '--json',
      ]);
    } finally {
      console.log = originalLog;
    }
    const document = JSON.parse(lines.join('\n')) as {
      flow: { callNodeSource: string };
    };
    assert.equal(document.flow.callNodeSource, 'generated-template');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
