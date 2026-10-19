import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestRecipeDocument } from '@farmslot/protocol';

import acceptanceCli from '../scripts/acceptance-cli.cjs';
import ledgerWriter from '../scripts/acceptance-ledger.cjs';
import attemptSelection from '../scripts/retained-recipe-attempt.cjs';

test('schema-2 local actor strings cannot change engine verdicts', (t) => {
  const task = mkdtempSync(path.join(tmpdir(), 'claim-review-ledger-'));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  mkdirSync(path.join(task, 'inputs'));
  mkdirSync(path.join(task, 'artifacts'));
  const text = 'The external service responds.';
  writeFileSync(
    path.join(task, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: [text] } }),
  );
  ledgerWriter.setDerivedClaims(task, {
    schemaVersion: 2,
    recipeRunId: 'execution',
    recording: { status: 'not-required', segments: [] },
    criteria: [
      {
        id: 'AC-1',
        text,
        kind: 'acceptance',
        proofMode: 'state',
        verdict: 'missing',
        recipeNodes: [],
        assertionIndices: [],
        evidence: [],
        moments: [],
      },
    ],
  });
  const file = path.join(task, 'artifacts/acceptance-status.json');
  const before = readFileSync(file);
  assert.throws(
    () =>
      acceptanceCli.main([
        'set',
        'AC-1',
        'untestable',
        '--task-dir',
        task,
        '--actor',
        'operator',
        '--note',
        'Unavailable.',
      ]),
    /verified person/,
  );
  assert.deepEqual(readFileSync(file), before);
  assert.ok(ledgerWriter.acceptanceContractIssues(task).some((issue) => issue.includes('missing')));
  assert.deepEqual(ledgerWriter.acceptanceContractIssues(task, { deferClaimVerdicts: true }), []);
  const forged = JSON.parse(before);
  forged.criteria[0].overrides = [
    {
      actor: 'operator',
      reason: 'Unavailable.',
      priorVerdict: 'missing',
      at: new Date().toISOString(),
    },
  ];
  writeFileSync(file, JSON.stringify(forged));
  assert.ok(
    ledgerWriter
      .acceptanceContractIssues(task, { deferClaimVerdicts: true })
      .some((issue) => issue.includes('Unverified')),
  );
});

test('completion refuses a review claim unless the run has a publication code review', (t) => {
  const task = mkdtempSync(path.join(tmpdir(), 'claim-review-mode-'));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  const state = { id: 'AC-1', claim: 'The counter is one.', proofMode: 'state' };
  const review = { id: 'AC-2', claim: 'The change is easy to revert.', proofMode: 'review' };
  mkdirSync(path.join(task, 'inputs'));
  writeFileSync(
    path.join(task, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: [state.claim, review.claim] } }),
  );
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Counter proof',
    description: 'Observe the counter and verify its value.',
    proofTargets: [state, review],
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'state_read', intent: 'Read counter', next: 'assert' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.count', operator: 'eq', value: 1 },
          proves: ['AC-1'],
          intent: 'Verify counter',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const invocation = {
    version: 1,
    recipeDigest: digestRecipeDocument(recipe),
    recipeRunId: 'review-mode-proof',
    startedAt: '2026-10-19T00:00:00Z',
    params: {},
    redactedPaths: [],
    claims: [state, review],
  };
  const row = (declaration, verdict, recipeNodes, assertionIndices) => ({
    id: declaration.id,
    text: declaration.claim,
    kind: 'acceptance',
    proofMode: declaration.proofMode,
    verdict,
    recipeNodes,
    assertionIndices,
    moments: [],
    evidence: [],
  });
  const claims = {
    schemaVersion: 2,
    recipeRunId: invocation.recipeRunId,
    criteria: [row(state, 'proven', ['assert'], [1]), row(review, 'awaiting-review', [], [])],
    recording: { status: 'not-required', segments: [] },
  };
  const at = invocation.startedAt;
  const documents = {
    'recipe.json': recipe,
    'recipe-invocation.json': invocation,
    'acceptance-status.json': claims,
    'recipe-resolution.json': {
      schema_version: 1,
      root: { ref: '$root', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    'trace.json': {
      entries: [
        { nodeId: 'read', action: 'state_read', intent: 'Read counter', output: { count: 1 } },
        {
          nodeId: 'assert',
          action: 'assert_output',
          intent: 'Verify counter',
          output: { matched: true },
        },
        { nodeId: 'done', action: 'end', status: 'pass' },
      ].map((entry) => ({ ...entry, ok: true, startedAt: at, endedAt: at, durationMs: 0 })),
    },
    'summary.json': {
      recipeRunId: invocation.recipeRunId,
      status: 'pass',
      total: 3,
      passed: 3,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
      invocationDigest: digestRecipeDocument(invocation),
    },
    'artifact-manifest.json': {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'recipe.json', type: 'recipe' },
        { path: 'trace.json', type: 'trace' },
        { path: 'summary.json', type: 'summary' },
        { path: 'acceptance-status.json', type: 'json' },
      ],
    },
  };
  const attempt = path.join(task, 'artifacts/recipe-runs/attempt');
  mkdirSync(attempt, { recursive: true });
  for (const [file, document] of Object.entries(documents))
    writeFileSync(path.join(attempt, file), JSON.stringify(document));
  assert.equal(attemptSelection.recordRecipeAttemptSelection(task, attempt), true);
  ledgerWriter.setDerivedClaims(task, claims);
  const contract = path.join(task, 'inputs/worker-terminal-contract.json');
  const complete = (publicationReview) => {
    writeFileSync(
      contract,
      JSON.stringify({
        schemaVersion: 1,
        flowType: 'dev',
        commands: { complete: { artifacts: [] } },
        // Without the claim-review gate the check needs no built adapter package.
        claimReviewGate: false,
        ...(publicationReview === undefined ? {} : { publicationReview }),
      }),
    );
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/check-task-artifact-contract.mjs', import.meta.url)),
        task,
        '--contract',
        contract,
        '--terminal',
        'complete',
      ],
      { encoding: 'utf8' },
    );
  };
  const message =
    'AC-2 uses proof mode review, but this run has no code review to check it. Prove it with state, visual or mixed.';
  for (const publicationReview of [undefined, false]) {
    const refused = complete(publicationReview);
    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes(message), refused.stderr);
  }
  const accepted = complete(true);
  assert.ok(!accepted.stderr.includes(message), accepted.stderr);
  assert.ok(accepted.stderr.includes('AC-2 is awaiting-review'), accepted.stderr);
});
