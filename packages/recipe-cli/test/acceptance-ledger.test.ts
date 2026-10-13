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
} from '@farmslot/protocol';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-runner';

import {
  acceptanceIdForProofTarget,
  recordRecipeAcceptance,
} from '../src/harness/acceptance-ledger.js';

const require = createRequire(import.meta.url);
const shared = require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
  setAcceptanceVerdict(taskDir: string, input: Record<string, unknown>): RecipeClaimLedger;
  validateAcceptanceStatusLedger(value: unknown): string[];
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

test('failed actual assertion stays failed and cannot be overwritten manually as proven', async (t) => {
  const run = await execute(t, 'two');
  recordRecipeAcceptance(run.taskDir, run.target, run.result);
  assert.equal(run.result.claims.criteria[0]?.verdict, 'failed');
  assert.throws(
    () => shared.setAcceptanceVerdict(run.taskDir, { id: 'AC-1', verdict: 'proven' }),
    /engine-owned/,
  );
  assert.throws(
    () =>
      shared.setAcceptanceVerdict(run.taskDir, {
        id: 'AC-1',
        verdict: 'untestable',
        note: 'External verification needed.',
      }),
    /verified person/,
  );
  assert.throws(
    () =>
      shared.setAcceptanceVerdict(run.taskDir, {
        id: 'AC-1',
        verdict: 'untestable',
        note: 'External verification needed.',
        actor: 'operator',
      }),
    /verified person/,
  );
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
