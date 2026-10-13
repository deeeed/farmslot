import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type EvidenceManifest,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { validateRecordedEvidencePackage } from '../src/evidence/package.js';
import { readRecordedEvidencePackage } from '../src/evidence/read-package.js';
import { JsonArtifactWriter } from '../src/node/writers.js';

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: {
      description: 'Read a value.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'command',
          cmd: 'printf observed',
          intent: 'Read the observed value.',
          next: 'done',
        },
      ],
    },
    assert_output: {
      description: 'Verify a value.',
      schema: {
        type: 'object',
        properties: { source: { type: 'string' }, contains: { type: 'string' } },
        required: ['source', 'contains'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          source: 'read',
          contains: 'observed',
          intent: 'Verify the observed value.',
          next: 'done',
        },
      ],
    },
    index_artifacts: {
      description: 'Retain an artifact.',
      schema: {
        type: 'object',
        properties: { artifacts: { type: 'array', items: { type: 'string' } } },
        required: ['artifacts'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'index_artifacts',
          artifacts: ['proof.png'],
          intent: 'Retain the captured state.',
          next: 'done',
        },
      ],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

for (const capture of [false, true]) {
  test(`a plain recipe produces its publication manifest without author linking code: media=${capture}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'engine-publication-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'proof.png'), 'captured fixture');
    const artifactsDir = path.join(root, 'attempt');
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
      defaultSource: { kind: 'operator', trust: 'trusted' },
    });
    const result = await runner.run({
      projectRoot: root,
      artifactsDir,
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: 'Read and verify a value',
        description: 'Keep the engine-derived claim and captured evidence.',
        proofTargets: [{ id: 'AC-1', claim: 'The value is observed.', proofMode: 'state' }],
        workflow: {
          entry: 'read',
          nodes: {
            read: {
              action: 'command',
              cmd: 'printf observed',
              intent: 'Read the value.',
              next: 'verify',
            },
            verify: {
              action: 'assert_output',
              source: 'read',
              contains: 'observed',
              proves: ['AC-1'],
              intent: 'Verify the value.',
              next: capture ? 'capture' : 'done',
            },
            ...(capture
              ? {
                  capture: {
                    action: 'index_artifacts',
                    artifacts: ['proof.png'],
                    intent: 'Retain the captured value.',
                    next: 'done',
                  },
                }
              : {}),
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.claims?.criteria[0]?.verdict, 'proven');
    const selected: EvidenceManifest = JSON.parse(
      await readFile(path.join(artifactsDir, 'evidence-manifest.json'), 'utf8'),
    );
    assert.deepEqual(
      selected.standalone?.map((entry) => entry.file),
      capture ? ['proof.png'] : [],
    );
    assert.equal(selected.summary, 'AC-1: proven');
    const retained = await readRecordedEvidencePackage(artifactsDir);
    assert(retained.checks.every((check) => check.status === 'pass'));
    assert(retained.input.artifactPaths?.includes('evidence-manifest.json'));
    assert.equal(
      validateRecordedEvidencePackage(retained.input).findings.filter(
        (finding) => finding.severity === 'error',
      ).length,
      0,
    );
  });
}

test('a host cannot register a second publication-manifest producer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owned-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = new JsonArtifactWriter(root);
  writer.register({ path: 'evidence-manifest.json', type: 'json' });
  await assert.rejects(
    writer.writeEvidenceManifest({ schemaVersion: 2, recipeRunId: 'attempt', criteria: [] }),
    /owned by the recipe engine/,
  );
});
