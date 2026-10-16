import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createRecipeRunner } from '../src/core/runner.js';
import {
  deriveReviewedRecipeClaims,
  recordedClaimSources,
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '../src/evidence/package.js';
import { readRecordedEvidencePackage } from '../src/evidence/read-package.js';

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
  { id: 'AC-3', claim: 'The order is stored.' },
];

/** Each proved claim gets its own assertion; `failing` claims assert text that is absent. */
function recipe(proves: string[], failing: string[] = []) {
  const nodes: Record<string, unknown> = {
    read: {
      action: 'command',
      cmd: 'printf stored',
      intent: 'Read the stored fixture.',
      next: proves.length ? `verify-${proves[0]}` : 'done',
    },
    done: { action: 'end', status: 'pass' },
  };
  proves.forEach((claim, index) => {
    nodes[`verify-${claim}`] = {
      action: 'assert_output',
      source: 'read',
      contains: failing.includes(claim) ? 'absent' : 'stored',
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

function createRunner() {
  return createRecipeRunner({
    actionManifest: manifest,
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
  });
}

const noRecording = { recordVideo: false, recordingReason: 'Fixture has no recorder.' } as const;

async function originalFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repair-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = createRunner();
  const originalDir = path.join(root, 'artifacts', 'recipe-runs', 'original');
  const original = await runner.run({
    recipeDocument: recipe(['AC-1', 'AC-2', 'AC-3']),
    projectRoot: root,
    artifactsDir: originalDir,
    claims,
    ...noRecording,
  });
  const read = await readRecordedEvidencePackage(originalDir);
  const recipeRunId = original.claims.recipeRunId;
  const closureIdentity = recordedEvidenceClosureIdentity(read.input);
  const packageHash = 'b'.repeat(64);
  const scope: RecipeRepairScope = {
    schemaVersion: 1,
    repairId: recipeRepairId({ runId: 'run-1', packageHash, receiptIds: ['receipt-2'] }),
    runId: 'run-1',
    generation: 0,
    decisionId: 'decision-1',
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
    retained: [
      { claimId: 'AC-1', recipeRunId },
      { claimId: 'AC-3', recipeRunId },
    ],
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
  return { root, runner, originalDir, recipeRunId, scope };
}

test('a repair re-proves the rejected criterion and selects retained siblings by engine rule', async (t) => {
  const { root, runner, originalDir, recipeRunId, scope } = await originalFixture(t);
  const originalManifest = await readFile(path.join(originalDir, 'artifact-manifest.json'));
  const repairDir = path.join(root, 'artifacts', 'recipe-runs', 'repair');
  const result = await runner.run({
    recipeDocument: recipe(['AC-2']),
    projectRoot: root,
    artifactsDir: repairDir,
    claims,
    repairScope: { scope, sourceRoots: { [recipeRunId]: originalDir } },
    ...noRecording,
  });
  assert.equal(result.status, 'pass');
  // The fresh execution keeps the full registration; unexecuted siblings stay missing there.
  assert.deepEqual(
    result.claims.criteria.map(({ id, verdict }) => [id, verdict]),
    [
      ['AC-1', 'missing'],
      ['AC-2', 'proven'],
      ['AC-3', 'missing'],
    ],
  );
  const read = await readRecordedEvidencePackage(repairDir);
  assert.ok(
    read.checks.every((check) => check.status === 'pass'),
    JSON.stringify(read.checks),
  );
  const validation = validateRecordedEvidencePackage(read.input);
  assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
  assert.deepEqual(
    recordedClaimSources(read.input).map((source) => [source.claimId, source.artifactRoot]),
    [
      ['AC-1', `comparison-dependencies/${recipeRunId}`],
      ['AC-2', undefined],
      ['AC-3', `comparison-dependencies/${recipeRunId}`],
    ],
  );
  const selected = selectedRecipeClaims(read.input);
  assert.deepEqual(
    selected.map(({ id, verdict }) => [id, verdict]),
    [
      ['AC-1', 'proven'],
      ['AC-2', 'proven'],
      ['AC-3', 'proven'],
    ],
  );
  // Retained rows name their original execution, so their moments stay valid in the task ledger.
  assert.deepEqual(
    selected.map(({ id, retainedFrom }) => [id, retainedFrom]),
    [
      ['AC-1', recipeRunId],
      ['AC-2', undefined],
      ['AC-3', recipeRunId],
    ],
  );
  assert.deepEqual(
    deriveReviewedRecipeClaims(read.input).map(({ id, verdict, retainedFrom }) => [
      id,
      verdict,
      retainedFrom,
    ]),
    selected.map(({ id, verdict, retainedFrom }) => [id, verdict, retainedFrom]),
  );
  // Original bytes are never rewritten.
  assert.deepEqual(
    await readFile(path.join(originalDir, 'artifact-manifest.json')),
    originalManifest,
  );
  // A relabelled selection cannot clear the rejected criterion with old proof.
  const selectionPath = path.join(repairDir, 'repair-selection.json');
  const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
  selection.claims[1] = {
    claimId: 'AC-2',
    source: 'retained',
    recipeRunId,
    closureIdentity: scope.sources[0]!.closureIdentity,
  };
  await writeFile(selectionPath, JSON.stringify(selection));
  const tampered = await readRecordedEvidencePackage(repairDir);
  assert.equal(validateRecordedEvidencePackage(tampered.input).status, 'invalid');
});

test('a fresh sibling failure is selected and older proof cannot hide it', async (t) => {
  const { root, runner, originalDir, recipeRunId, scope } = await originalFixture(t);
  const repairDir = path.join(root, 'artifacts', 'recipe-runs', 'repair');
  const result = await runner.run({
    recipeDocument: recipe(['AC-1', 'AC-2'], ['AC-1']),
    projectRoot: root,
    artifactsDir: repairDir,
    claims,
    repairScope: { scope, sourceRoots: { [recipeRunId]: originalDir } },
    ...noRecording,
  });
  assert.equal(result.status, 'fail');
  const read = await readRecordedEvidencePackage(repairDir);
  assert.equal(validateRecordedEvidencePackage(read.input).status, 'valid');
  const selected = selectedRecipeClaims(read.input);
  assert.equal(selected.find(({ id }) => id === 'AC-1')?.verdict, 'failed');
  assert.equal(recordedClaimSources(read.input)[0]?.artifactRoot, undefined);
});

test('a repair refuses partial runs, changed registration, absent or changed sources and weaker proof', async (t) => {
  const { root, runner, originalDir, recipeRunId, scope } = await originalFixture(t);
  const base = {
    recipeDocument: recipe(['AC-2']),
    projectRoot: root,
    claims,
    ...noRecording,
  };
  const attempt = (name: string) => path.join(root, 'artifacts', 'recipe-runs', name);
  const sourceRoots = { [recipeRunId]: originalDir };
  await assert.rejects(
    runner.run({
      ...base,
      artifactsDir: attempt('partial'),
      stopAfterNode: 'read',
      repairScope: { scope, sourceRoots },
    }),
    /complete graph/u,
  );
  await assert.rejects(
    runner.run({
      ...base,
      artifactsDir: attempt('registration'),
      claims: claims.slice(0, 2),
      repairScope: { scope, sourceRoots },
    }),
    /full task registration/u,
  );
  await assert.rejects(
    runner.run({
      ...base,
      artifactsDir: attempt('absent'),
      repairScope: { scope, sourceRoots: {} },
    }),
    /not available/u,
  );
  const weaker: RecipeRepairScope = {
    ...scope,
    rejected: [{ ...scope.rejected[0]!, proofMode: 'visual' }],
  };
  await assert.rejects(
    runner.run({
      ...base,
      artifactsDir: attempt('weaker'),
      repairScope: { scope: weaker, sourceRoots },
    }),
    /proof mode|proofMode/u,
  );
  await writeFile(path.join(originalDir, 'summary.json'), '{"changed":true}');
  await assert.rejects(
    runner.run({ ...base, artifactsDir: attempt('changed'), repairScope: { scope, sourceRoots } }),
    /invalid|no longer matches/u,
  );
});
