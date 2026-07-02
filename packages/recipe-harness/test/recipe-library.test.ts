import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type RecipeActionManifestDocument } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { validateRecipeCliInput } from '../src/cli/support.js';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import {
  defaultRecipeLibrarySources,
  loadRecipeLibraries,
  parseRecipeLibraryPath,
  resolveRecipeLibrarySources,
} from '../src/core/library.js';
import { createRecipeRunner } from '../src/core/runner.js';
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
    schema_version: 1,
    ...(options.name ? { name: options.name } : {}),
  });
  await writeJsonFile(path.join(root, 'flows', options.catalogFile ?? 'main.flows.json'), {
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
        { name: 'personal', root: libraryRoot },
        { name: 'team', root: teamRoot },
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

test('loads flow catalogs referenced through symlinks', async () => {
  const tempRoot = await createTempRoot();
  try {
    const sharedCatalog = path.join(tempRoot, 'shared-catalog.flows.json');
    await writeJsonFile(sharedCatalog, {
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: { 'lib.linked': writeTextFlow('linked.txt', 'linked') },
    });
    const libraryRoot = path.join(tempRoot, 'personal');
    await createLibrary(libraryRoot, { flows: {} });
    await rm(path.join(libraryRoot, 'flows', 'main.flows.json'));
    await symlink(sharedCatalog, path.join(libraryRoot, 'flows', 'linked.flows.json'));

    const resolution = await loadRecipeLibraries([{ name: 'personal', root: libraryRoot }]);
    assert.equal(resolution.flows.get('lib.linked')?.source, 'personal');
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
    };
    assert.deepEqual(
      document.sources.map((source) => source.name),
      ['personal'],
    );
    assert.equal(document.flows[0]?.ref, 'lib.write-text');
    assert.equal(document.flows[0]?.source, 'personal');
    assert.ok(document.flows[0]?.description?.includes('from-library.txt'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
