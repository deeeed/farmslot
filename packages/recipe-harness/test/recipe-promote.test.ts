import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type RecipeActionManifestDocument } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import { promoteRecipeFlow } from '../src/core/promote.js';
import { createRecipeRunner } from '../src/core/runner.js';
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

test('stamps lastVerified only from a passing run summary', async () => {
  const tempRoot = await createTempRoot();
  try {
    const recipePath = path.join(tempRoot, 'recipe.json');
    await writePerChangeRecipe(recipePath, { 'demo.write-marker': markerFlow() });
    const targetRoot = path.join(tempRoot, 'library');

    const passDir = path.join(tempRoot, 'pass-artifacts');
    await writeJsonFile(path.join(passDir, 'summary.json'), {
      status: 'pass',
      endedAt: '2026-07-01T10:00:00.000Z',
    });
    const promoted = await promoteRecipeFlow({
      recipePath,
      flowRef: 'demo.write-marker',
      targetRoot,
      targetName: 'personal',
      runArtifactsDir: passDir,
    });
    assert.equal(promoted.lastVerified, '2026-07-01');
    const catalog = (await readJsonFile(promoted.catalogPath)) as {
      flows: Record<string, { provenance?: { lastVerified?: { date?: string } } }>;
    };
    assert.equal(catalog.flows['demo.write-marker']?.provenance?.lastVerified?.date, '2026-07-01');

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
      librarySources: [{ name: 'personal', root: targetRoot }],
    });
    assert.equal(result.status, 'pass');
    assert.equal(await readFile(path.join(tempRoot, 'marker.txt'), 'utf-8'), 'promoted-ok');
    const summary = (await readJsonFile(result.summaryPath)) as SummaryDocument;
    assert.equal(summary.flowResolution?.used[0]?.ref, 'demo.write-marker');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
