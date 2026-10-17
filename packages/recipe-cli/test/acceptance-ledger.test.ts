import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
  type RecipeClaimLedger,
  recipeRepairId,
  type RecipeRepairScope,
  recordedEvidenceClosureIdentity,
} from '@farmslot/protocol';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
  readRecordedEvidencePackage,
} from '@farmslot/recipe-runner';

import {
  acceptanceIdForProofTarget,
  recordRecipeAcceptance,
} from '../src/harness/acceptance-ledger.js';

const require = createRequire(import.meta.url);
const shared = require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
  validateAcceptanceStatusLedger(value: unknown): string[];
};
const acceptanceCli = require('@farmslot/agent-runtime/scripts/acceptance-cli.cjs') as {
  main(argv: string[]): void;
};
const attemptSelection = require('@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs') as {
  recordRecipeAttemptSelection(taskDir: string, artifactDir: string): boolean;
};
const criteria = ['The command observes one.', 'A second expectation is required.'];
const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    command: {
      description: 'Read command output.',
      schema: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
        additionalProperties: false,
      },
      examples: [
        { action: 'command', cmd: 'printf one', intent: 'Read the command result.', next: 'done' },
      ],
    },
    assert_output: {
      description: 'Check observed output.',
      schema: {
        type: 'object',
        properties: { source: { type: 'string' }, contains: { type: 'string' } },
        required: ['source', 'contains'],
        additionalProperties: false,
      },
      examples: [
        {
          action: 'assert_output',
          source: 'observe',
          contains: 'one',
          intent: 'The command result must be one.',
          next: 'done',
        },
      ],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

async function execute(t: test.TestContext, expected = 'one') {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-task-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const taskDir = path.join(target, 'task');
  fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: criteria } }),
  );
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output', 'end'] }),
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'test' },
  });
  const result = await runner.run({
    projectRoot: target,
    artifactsDir: path.join(taskDir, 'artifacts/recipe'),
    claims: criteria.map((claim, index) => ({ id: `AC-${index + 1}`, claim })),
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      proofTargets: [{ id: 'AC1', claim: criteria[0], proofMode: 'state' }],
      workflow: {
        entry: 'observe',
        nodes: {
          observe: {
            action: 'command',
            cmd: 'printf one',
            intent: 'Read the actual command result.',
            next: 'check',
          },
          check: {
            action: 'assert_output',
            source: 'observe',
            contains: expected,
            proves: ['AC1'],
            intent: 'The observed result must be one.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  return { target, taskDir, result };
}

test('real execution derives all registered claims and task transport preserves the engine facts', async (t) => {
  const run = await execute(t);
  assert.deepEqual(
    run.result.claims.criteria.map((claim) => claim.verdict),
    ['proven', 'missing'],
  );
  const record = recordRecipeAcceptance(run.taskDir, run.target, run.result);
  const stored = JSON.parse(
    fs.readFileSync(path.join(run.taskDir, 'artifacts/acceptance-status.json'), 'utf8'),
  ) as RecipeClaimLedger;
  assert.deepEqual(shared.validateAcceptanceStatusLedger(stored), []);
  assert.equal(stored.recipeRunId, run.result.claims.recipeRunId);
  assert.deepEqual(
    stored.criteria.map((claim) => claim.verdict),
    ['proven', 'missing'],
  );
  assert.equal(record.recorded[0]?.evidence[0], 'artifacts/recipe/trace.json');
});

test('a repair row keeps moments only from the execution it names as retained', async (t) => {
  const run = await execute(t);
  recordRecipeAcceptance(run.taskDir, run.target, run.result);
  const stored = JSON.parse(
    fs.readFileSync(path.join(run.taskDir, 'artifacts/acceptance-status.json'), 'utf8'),
  ) as RecipeClaimLedger;
  const moment = {
    recipeRunId: 'original-execution',
    videoDigest: `sha256:${'a'.repeat(64)}`,
    traceIndex: 0,
  };
  const withRow = (row: RecipeClaimLedger['criteria'][number]): RecipeClaimLedger => ({
    ...stored,
    criteria: [row, ...stored.criteria.slice(1)],
  });
  const [first] = stored.criteria;
  assert.ok(first);
  assert.deepEqual(
    shared.validateAcceptanceStatusLedger(
      withRow({ ...first, moments: [moment], retainedFrom: 'original-execution' }),
    ),
    [],
  );
  assert.deepEqual(
    shared.validateAcceptanceStatusLedger(withRow({ ...first, moments: [moment] })),
    ['acceptance ledger criteria[0].moments: invalid moment references'],
  );
  assert.deepEqual(
    shared.validateAcceptanceStatusLedger(withRow({ ...first, moments: [], retainedFrom: '' })),
    ['acceptance ledger criteria[0].retainedFrom: expected the retained execution id'],
  );
});

test('a repair ledger passes the evidence review terminal gate with its retained row', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-task-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const taskDir = path.join(target, 'task');
  fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: criteria } }),
  );
  const claims = criteria.map((claim, index) => ({ id: `AC-${index + 1}`, claim }));
  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: ['command', 'assert_output', 'end'] }),
    defaultSource: { kind: 'operator', trust: 'trusted', name: 'test' },
  });
  const recipe = (proves: string[]) => ({
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    proofTargets: claims.filter(({ id }) => proves.includes(id)),
    workflow: {
      entry: 'observe',
      nodes: {
        observe: {
          action: 'command',
          cmd: 'printf one',
          intent: 'Read the actual command result.',
          next: `check-${proves[0]}`,
        },
        ...Object.fromEntries(
          proves.map((id, index) => [
            `check-${id}`,
            {
              action: 'assert_output',
              source: 'observe',
              contains: 'one',
              proves: [id],
              intent: `The observed result proves ${id}.`,
              next: proves[index + 1] ? `check-${proves[index + 1]}` : 'done',
            },
          ]),
        ),
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  const originalDir = path.join(taskDir, 'artifacts/recipe-runs/original');
  const original = await runner.run({
    projectRoot: target,
    artifactsDir: originalDir,
    claims,
    recipeDocument: recipe(['AC-1', 'AC-2']),
  });
  const recipeRunId = original.claims.recipeRunId;
  const closureIdentity = recordedEvidenceClosureIdentity(
    (await readRecordedEvidencePackage(originalDir)).input,
  );
  const packageHash = 'b'.repeat(64);
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
        reason: 'The second expectation is wrong.',
        recipeRunId,
        closureIdentity,
        reviewedFiles: [],
        moments: [],
      },
    ],
  };
  const repairDir = path.join(taskDir, 'artifacts/recipe-runs/repair');
  const repaired = await runner.run({
    projectRoot: target,
    artifactsDir: repairDir,
    claims,
    recipeDocument: recipe(['AC-2']),
    repairScope: { scope, sourceRoots: { [recipeRunId]: originalDir } },
  });
  assert.ok(attemptSelection.recordRecipeAttemptSelection(taskDir, repairDir));
  recordRecipeAcceptance(taskDir, target, repaired);
  const ledger = JSON.parse(
    fs.readFileSync(path.join(taskDir, 'artifacts/acceptance-status.json'), 'utf8'),
  ) as RecipeClaimLedger;
  assert.deepEqual(
    ledger.criteria.map(({ id, verdict, retainedFrom }) => [id, verdict, retainedFrom]),
    [
      ['AC-1', 'proven', recipeRunId],
      ['AC-2', 'proven', undefined],
    ],
  );
  // The worker's terminal check binds each task row to the engine's selected row.
  const gatePath = require.resolve('@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs');
  const gate = (await import(path.join(path.dirname(gatePath), 'claim-review-gate.mjs'))) as {
    pendingClaimReviewIssues(taskDir: string, ledger: RecipeClaimLedger): Promise<string[]>;
  };
  assert.deepEqual(await gate.pendingClaimReviewIssues(taskDir, ledger), []);
  // A retained row cannot pose as the fresh execution's own proof.
  const unbound = structuredClone(ledger);
  Reflect.deleteProperty(unbound.criteria[0]!, 'retainedFrom');
  assert.deepEqual(await gate.pendingClaimReviewIssues(taskDir, unbound), [
    'Task claim AC-1 differs from its selected engine claim.',
  ]);
});

test('failed actual assertion stays failed and cannot be overwritten manually as proven', async (t) => {
  const run = await execute(t, 'two');
  recordRecipeAcceptance(run.taskDir, run.target, run.result);
  assert.equal(run.result.claims.criteria[0]?.verdict, 'failed');
  for (const verdict of ['proven', 'untestable']) {
    assert.throws(
      () =>
        acceptanceCli.main([
          'set',
          'AC-1',
          verdict,
          '--task-dir',
          run.taskDir,
          '--actor',
          'operator',
        ]),
      /engine-owned.*verified person/,
    );
  }
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(run.taskDir, 'artifacts/acceptance-status.json'), 'utf8'))
      .criteria[0].verdict,
    'failed',
  );
});

test('transport refuses a mismatched task and symlinked outside evidence is omitted', async (t) => {
  const run = await execute(t);
  const outside = path.join(run.target, 'outside.json');
  fs.writeFileSync(outside, '{}');
  const link = path.join(path.dirname(run.result.claimsPath), 'outside.json');
  fs.symlinkSync(outside, link);
  const claims = {
    ...run.result.claims,
    criteria: run.result.claims.criteria.map((claim) => ({ ...claim, evidence: ['outside.json'] })),
  };
  fs.writeFileSync(run.result.claimsPath, JSON.stringify(claims));
  assert.deepEqual(
    recordRecipeAcceptance(run.taskDir, run.target, run.result).recorded[0]?.evidence,
    ['artifacts/recipe/trace.json'],
  );
  fs.writeFileSync(
    path.join(run.taskDir, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: ['Changed task.'] } }),
  );
  assert.throws(
    () => recordRecipeAcceptance(run.taskDir, run.target, run.result),
    /registered task/,
  );
});

test('an absent engine package fails clearly rather than deriving action success', () => {
  assert.throws(
    () =>
      recordRecipeAcceptance('/task', '/checkout', {
        recipePath: '/recipe.json',
        tracePath: '/trace.json',
      }),
    /no derived claim package/,
  );
  assert.equal(acceptanceIdForProofTarget('ac1'), 'AC-1');
  assert.equal(acceptanceIdForProofTarget('case-one'), null);
});
