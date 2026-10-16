import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
  type RecipeClaimDeclaration,
  recipeRepairId,
  type RecipeRepairScope,
  recordedEvidenceClosureIdentity,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../../recipe-runner/src/adapters/core.js';
import { createRecipeRunner } from '../../recipe-runner/src/core/runner.js';
import { readRecordedEvidencePackage } from '../../recipe-runner/src/evidence/read-package.js';
import { createEvidenceReviewModel } from '../src/evidence.js';

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: {
      description: 'Read the fixture.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        { action: 'command', cmd: 'printf ok', intent: 'Read the fixture.', next: 'done' },
      ],
    },
    assert_output: {
      description: 'Verify the fixture.',
      schema: {
        type: 'object',
        properties: { source: { type: 'string' }, contains: { type: 'string' } },
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          source: 'read',
          contains: 'ok',
          intent: 'Verify the fixture.',
          next: 'done',
        },
      ],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

const claims: RecipeClaimDeclaration[] = [
  { id: 'AC-1', claim: 'The header is stored.' },
  { id: 'AC-2', claim: 'The chart is stored.' },
];

function recipe(proves: string[]) {
  const nodes: Record<string, unknown> = {
    read: {
      action: 'command',
      cmd: 'printf stored',
      intent: 'Read the stored fixture.',
      next: `verify-${proves[0]}`,
    },
    done: { action: 'end', status: 'pass' },
  };
  proves.forEach((claim, index) => {
    nodes[`verify-${claim}`] = {
      action: 'assert_output',
      source: 'read',
      contains: 'stored',
      proves: [claim],
      intent: `Confirm ${claim}.`,
      next: proves[index + 1] ? `verify-${proves[index + 1]}` : 'done',
    };
  });
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Store the criteria',
    description: 'Prove the stored criteria.',
    proofTargets: claims.filter(({ id }) => proves.includes(id)),
    workflow: { entry: 'read', nodes },
  };
}

test('a repair package presents retained criteria from their original execution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-review-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
  });
  const noRecording = { recordVideo: false, recordingReason: 'Fixture has no recorder.' } as const;
  const originalDir = path.join(root, 'artifacts', 'recipe-runs', 'original');
  const original = await runner.run({
    recipeDocument: recipe(['AC-1', 'AC-2']),
    projectRoot: root,
    artifactsDir: originalDir,
    claims,
    ...noRecording,
  });
  const recipeRunId = original.claims.recipeRunId;
  const closureIdentity = recordedEvidenceClosureIdentity(
    (await readRecordedEvidencePackage(originalDir)).input,
  );
  const packageHash = `sha256:${'b'.repeat(64)}`;
  const scope: RecipeRepairScope = {
    schemaVersion: 1,
    repairId: recipeRepairId({ runId: 'run-1', packageHash, receiptIds: ['receipt-2'] }),
    runId: 'run-1',
    generation: 0,
    decisionId: 'gate',
    packageHash,
    packageHeadSha: 'c'.repeat(40),
    reviewBaseSha: 'd'.repeat(40),
    reviewId: 'review-1',
    workerContextId: 'run-1:dev',
    repairRecipe: 'recipes/visual-repair.json',
    claims,
    sources: [
      {
        recipeRunId,
        closureIdentity,
        artifactRoot: 'artifacts/recipe-runs/original',
        headSha: 'c'.repeat(40),
      },
    ],
    retained: [{ claimId: 'AC-1', recipeRunId }],
    rejected: [
      {
        claimId: 'AC-2',
        proofMode: 'state',
        receiptId: 'receipt-2',
        reason: 'The chart value is wrong.',
        recipeRunId,
        closureIdentity,
        reviewedFiles: [],
        moments: [],
      },
    ],
  };
  const repairDir = path.join(root, 'artifacts', 'recipe-runs', 'repair');
  await runner.run({
    recipeDocument: recipe(['AC-2']),
    projectRoot: root,
    artifactsDir: repairDir,
    claims,
    repairScope: { scope, sourceRoots: { [recipeRunId]: originalDir } },
    ...noRecording,
  });
  const model = createEvidenceReviewModel({
    package: (await readRecordedEvidencePackage(repairDir)).input,
    artifactPrefix: 'artifacts/recipe-runs/repair/',
  });
  assert.deepEqual(model.errors, []);
  const retained = model.claims.find(({ id }) => id === 'AC-1')!;
  const fresh = model.claims.find(({ id }) => id === 'AC-2')!;
  assert.deepEqual(retained.retained, { recipeRunId, revision: 'c'.repeat(40) });
  assert.equal(retained.status?.verdict, 'proven');
  assert.ok(
    retained.evidence.every(({ artifactPath }) =>
      artifactPath.startsWith(
        `artifacts/recipe-runs/repair/comparison-dependencies/${recipeRunId}/`,
      ),
    ),
    JSON.stringify(retained.evidence),
  );
  // Retained assertion indices belong to the original trace, never the fresh one.
  assert.deepEqual(retained.occurrences, []);
  assert.equal(fresh.retained, undefined);
  assert.equal(fresh.status?.verdict, 'proven');
  assert.ok(fresh.occurrences.length > 0);
});
