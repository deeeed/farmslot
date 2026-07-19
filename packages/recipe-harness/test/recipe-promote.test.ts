import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type RecipeActionManifestDocument } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { runRecipeHarnessCli } from '../src/cli/index.js';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import { loadRecipeLibraries } from '../src/core/library.js';
import { promoteRecipeFlow } from '../src/core/promote.js';
import { createRecipeRunner as createRawRecipeRunner } from '../src/core/runner.js';
import type { SummaryDocument } from '../src/core/types.js';

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
        name: 'recipe promote test',
      },
    })),
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'recipe promote test' },
  });
}

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'farmslot-recipe-promote-'));
}

function markerFlow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    description: 'Write a marker file as reusable proof setup.',
    paramsSchema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    postcondition: { path: '$.outputs.write.exitCode', operator: 'eq', value: 0 },
    workflow: {
      entry: 'write',
      nodes: {
        write: {
          action: 'command',
          intent: 'Write the marker file from the promoted flow',
          cmd: "node -e \"require('fs').writeFileSync('marker.txt','{{params.text}}')\"",
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
    ...overrides,
  };
}

async function writePerChangeRecipe(
  recipePath: string,
  flows: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(recipePath, {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    schema_version: 1,
    title: 'Per-change proof recipe',
    description: 'Throwaway proof recipe carrying a reusable inline flow.',
    flows,
    validate: {
      workflow: {
        entry: 'call-flow',
        nodes: {
          'call-flow': {
            action: 'call',
            intent: 'Exercise the inline flow before promotion',
            ref: Object.keys(flows)[0]!,
            params: { text: 'proof-ok' },
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
}

test('promotes an inline flow into a new personal library with provenance', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'personal-library');

    const result = await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
    });

    assert.equal(result.createdLibrary, true);
    assert.equal(result.catalogPath, path.join(targetRoot, 'flows', 'demo.flows.json'));
    const manifest = (await readJsonFile(path.join(targetRoot, 'library.json'))) as {
      kind: string;
      name: string;
    };
    assert.equal(manifest.kind, 'recipe-library');
    assert.equal(manifest.name, 'personal');
    const catalog = (await readJsonFile(result.catalogPath)) as {
      kind: string;
      flows: Record<string, { provenance?: { promotedFrom?: { recipe?: string } } }>;
    };
    assert.equal(catalog.kind, 'recipe-flow-catalog');
    assert.equal(
      catalog.flows['demo.write-marker']?.provenance?.promotedFrom?.recipe,
      'Per-change proof recipe',
    );

    await assert.rejects(
      promoteRecipeFlow({
        recipePath,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
      }),
      /already exists .* pass --force/s,
    );
    await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
      force: true,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('stamps lastVerified only from a passing run that exercised the flow', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'library');

    // Real run of the per-change recipe: its artifacts are the evidence.
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const runArtifactsDir = path.join(tempRoot, 'run-artifacts');
    const runResult = await runner.run({
      recipePath,
      artifactsDir: runArtifactsDir,
      projectRoot: tempRoot,
    });
    assert.equal(runResult.status, 'pass');

    const promoted = await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
      runArtifactsDir,
    });
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(promoted.lastVerified, today);
    const catalog = (await readJsonFile(promoted.catalogPath)) as {
      flows: Record<string, { provenance?: { lastVerified?: { date?: string } } }>;
    };
    assert.equal(catalog.flows['demo.write-marker']?.provenance?.lastVerified?.date, today);

    // A hand-written passing summary is not evidence: the run must have
    // exercised the flow.
    const spoofedDir = path.join(tempRoot, 'spoofed-artifacts');
    await writeJsonFile(path.join(spoofedDir, 'summary.json'), {
      status: 'pass',
      endedAt: '2026-07-01T10:00:00.000Z',
    });
    await assert.rejects(
      promoteRecipeFlow({
        recipePath,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
        runArtifactsDir: spoofedDir,
        force: true,
      }),
      /no readable recipe\.json/,
    );

    // Artifacts of a run that never called the flow are rejected even when the
    // recipe files match.
    const uncalledRecipePath = path.join(tempRoot, 'uncalled.json');
    await writeJsonFile(uncalledRecipePath, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Uncalled flow recipe',
      description: 'Declares the flow inline but never calls it.',
      flows: { 'demo.write-marker': markerFlow() },
      validate: {
        workflow: {
          entry: 'done',
          nodes: { done: { action: 'end', status: 'pass' } },
        },
      },
    });
    const uncalledArtifactsDir = path.join(tempRoot, 'uncalled-artifacts');
    const uncalledResult = await runner.run({
      recipePath: uncalledRecipePath,
      artifactsDir: uncalledArtifactsDir,
      projectRoot: tempRoot,
    });
    assert.equal(uncalledResult.status, 'pass');
    await assert.rejects(
      promoteRecipeFlow({
        recipePath: uncalledRecipePath,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
        runArtifactsDir: uncalledArtifactsDir,
        force: true,
      }),
      /never calls the flow/,
    );

    const failDir = path.join(tempRoot, 'fail-artifacts');
    await writeJsonFile(path.join(failDir, 'summary.json'), { status: 'fail' });
    await assert.rejects(
      promoteRecipeFlow({
        recipePath,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
        runArtifactsDir: failDir,
        force: true,
      }),
      /only passing runs can stamp lastVerified/,
    );

    const noEndedAtDir = path.join(tempRoot, 'no-endedat-artifacts');
    await writeJsonFile(path.join(noEndedAtDir, 'summary.json'), { status: 'pass' });
    await assert.rejects(
      promoteRecipeFlow({
        recipePath,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
        runArtifactsDir: noEndedAtDir,
        force: true,
      }),
      /no parseable endedAt/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('re-verifies a library-resolved flow from the run resolution report', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'library');
    await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
    });

    // Composed run resolving the flow from the library.
    const composedPath = path.join(tempRoot, 'composed.json');
    await writeJsonFile(composedPath, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Composed re-verify recipe',
      description: 'Calls the promoted flow from the library.',
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Re-verify the promoted flow from the library',
              ref: 'demo.write-marker',
              params: { text: 'reverify-ok' },
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const composedArtifactsDir = path.join(tempRoot, 'composed-artifacts');
    const composedResult = await runner.run({
      recipePath: composedPath,
      artifactsDir: composedArtifactsDir,
      projectRoot: tempRoot,
      librarySources: [
        {
          name: 'personal',
          root: targetRoot,
          provenance: { kind: 'operator', trust: 'trusted' },
        },
      ],
    });
    assert.equal(composedResult.status, 'pass');

    // The composed recipe has no inline flow; flowResolution.used is the evidence.
    const restamped = await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
      runArtifactsDir: composedArtifactsDir,
      force: true,
    });
    assert.equal(restamped.lastVerified, new Date().toISOString().slice(0, 10));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('never declares the same ref in two catalogs of one library', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'library');

    const first = await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
      domain: 'custom',
    });
    assert.equal(path.basename(first.catalogPath), 'custom.flows.json');

    // Same ref, default stem: rejected without --force, naming the file that
    // already declares it.
    await assert.rejects(
      promoteRecipeFlow({
        recipePath,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
      }),
      /custom\.flows\.json.*--force/s,
    );

    // With --force the flow is overwritten where it lives, not duplicated.
    const forced = await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
      force: true,
    });
    assert.equal(path.basename(forced.catalogPath), 'custom.flows.json');
    const defaultStemPath = path.join(targetRoot, 'flows', 'demo.flows.json');
    await assert.rejects(readFile(defaultStemPath), /ENOENT/);

    // The library still loads — exactly one declaration exists.
    const resolution = await loadRecipeLibraries([{ name: 'personal', root: targetRoot }]);
    assert.equal(resolution.flows.get('demo.write-marker')?.source, 'personal');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('rejects flows that do not meet the library contract', async () => {
  const tempRoot = await createTempRoot();
  try {
    const targetRoot = path.join(tempRoot, 'library');

    const noDescription = path.join(tempRoot, 'no-description.json');
    await writePerChangeRecipe(noDescription, {
      'demo.write-marker': markerFlow({ description: undefined }),
    });
    await assert.rejects(
      promoteRecipeFlow({
        recipePath: noDescription,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
      }),
      /needs a description/,
    );

    const ensureWithout = path.join(tempRoot, 'ensure-without.json');
    await writePerChangeRecipe(ensureWithout, {
      'demo.ensure_marker': markerFlow({ postcondition: undefined }),
    });
    await assert.rejects(
      promoteRecipeFlow({
        recipePath: ensureWithout,
        flowRef: 'demo.ensure_marker',
        targetRoot,
        targetName: 'personal',
      }),
      /must declare a postcondition/,
    );

    const missingFlow = path.join(tempRoot, 'missing.json');
    await writePerChangeRecipe(missingFlow, { 'demo.other': markerFlow() });
    await assert.rejects(
      promoteRecipeFlow({
        recipePath: missingFlow,
        flowRef: 'demo.write-marker',
        targetRoot,
        targetName: 'personal',
      }),
      /not declared inline .* available: demo\.other/s,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a promoted flow is immediately composable from the library by a new recipe', async () => {
  const tempRoot = await createTempRoot();
  try {
    const sourceRecipePath = path.join(tempRoot, 'per-change.json');
    await writePerChangeRecipe(sourceRecipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'personal-library');
    await promoteRecipeFlow({
      recipePath: sourceRecipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
    });

    const composedRecipePath = path.join(tempRoot, 'composed.json');
    await writeJsonFile(composedRecipePath, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Composed from library',
      description: 'Calls the promoted flow without declaring it.',
      validate: {
        workflow: {
          entry: 'call-flow',
          nodes: {
            'call-flow': {
              action: 'call',
              intent: 'Set up state via the promoted library flow',
              ref: 'demo.write-marker',
              params: { text: 'promoted-ok' },
              next: 'assert',
            },
            assert: {
              action: 'assert_file',
              intent: 'Verify the promoted flow produced the marker',
              path: 'marker.txt',
              contains: 'promoted-ok',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    });
    const runner = createRecipeRunner({
      actionManifest: coreActionManifest,
      adapters: createStandardCoreAdapters(),
    });
    const result = await runner.run({
      recipePath: composedRecipePath,
      artifactsDir: path.join(tempRoot, 'artifacts'),
      projectRoot: tempRoot,
      librarySources: [
        {
          name: 'personal',
          root: targetRoot,
          provenance: { kind: 'operator', trust: 'trusted' },
        },
      ],
    });
    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'marker.txt'), 'utf-8'), 'promoted-ok');
    const summary = (await readJsonFile(result.summaryPath)) as SummaryDocument;
    assert.equal(summary.flowResolution?.used[0]?.ref, 'demo.write-marker');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('flows promote --to resolves a bare-path source by its manifest name', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    // Existing team library whose name lives only in its library.json manifest.
    const teamRoot = path.join(tempRoot, 'team-library');
    await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot: teamRoot,
      targetName: 'team-perps',
    });

    const secondRecipePath = path.join(tempRoot, 'second.json');
    await writePerChangeRecipe(secondRecipePath, { 'demo.second-marker': markerFlow() });
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => {
      lines.push(values.map((value) => String(value)).join(' '));
    };
    try {
      await runRecipeHarnessCli([
        'flows',
        'promote',
        '--from',
        secondRecipePath,
        '--flow',
        'demo.second-marker',
        '--to',
        'team-perps',
        '--library',
        teamRoot,
      ]);
    } finally {
      console.log = originalLog;
    }
    assert.ok(lines.some((line) => line.startsWith('Promoted demo.second-marker')));
    const catalog = (await readJsonFile(path.join(teamRoot, 'flows', 'demo.flows.json'))) as {
      flows: Record<string, unknown>;
    };
    assert.ok(catalog.flows['demo.second-marker']);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('refuses to promote into a library already corrupted by a duplicate ref', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'library');
    await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
    });
    // Pre-existing corruption (from before promote scanned the whole library):
    // the same ref declared in a second catalog file.
    await writeJsonFile(path.join(targetRoot, 'flows', 'custom.flows.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      kind: 'recipe-flow-catalog',
      flows: { 'demo.write-marker': markerFlow() },
    });

    // Overwriting only one declaration would leave the library unloadable, so
    // promote fails loudly naming every offending catalog — with or without
    // --force.
    for (const force of [false, true]) {
      await assert.rejects(
        promoteRecipeFlow({
          recipePath,
          flowRef: 'demo.write-marker',
          targetRoot,
          targetName: 'personal',
          force,
        }),
        /2 catalogs \(custom\.flows\.json, demo\.flows\.json\).*Remove the stale duplicate/s,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
