import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  buildRunDecisionActionRequest,
  digestRecipeDocument,
  isRecord,
  MARK_CLAIM_UNTESTABLE_ACTION,
  type RecipeClaimLedger,
  type ReviewStatus,
  runClaimOverrideSnapshotIdentity,
  type RunDecision,
  type RunOverrideClaimParams,
  type RunRefreshPublishPackageParams,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { createRun, updateRun, getRun, runsDirectory } = await import('../../runs/store.js');
const { runOverrideClaim } = await import('./claim-overrides.js');
const { collectRunGateReadiness } = await import('../../run-engine/gate-prerequisites.js');
const { deleteTestRunIfPresent, makeReadyGatePackage, retainRunFixture } =
  await import('../../run-engine/test-fixtures.js');
const { computeReadyGatePackageHash, computeReadyGateReviewSubjectHash } =
  await import('../../run-completion/ready-gate-package.js');
const { certifyingReview, PASSING_REVIEW_RESULT } =
  await import('../../run-engine/review-claim.test-support.js');

export async function fixture(t: TestContext, minimumReviews = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claim-override-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'artifacts/recipe-runs/attempt');
  await mkdir(directory, { recursive: true });
  const claim = {
    id: 'AC-1',
    claim: 'The external service responds.',
    proofMode: 'state' as const,
  };
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Service proof',
    description: 'Observe a local value while external proof remains missing.',
    proofTargets: [claim],
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'state_read', intent: 'Read local state', next: 'assert' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.count', operator: 'eq', value: 1 },
          proves: ['AC-1'],
          intent: 'Verify service',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const invocation = {
    version: 1,
    recipeDigest: digestRecipeDocument(recipe),
    recipeRunId: 'execution',
    startedAt: '2026-10-13T00:00:00Z',
    params: {},
    redactedPaths: [],
  };
  const claims: RecipeClaimLedger = {
    schemaVersion: 2,
    recipeRunId: invocation.recipeRunId,
    criteria: [
      {
        id: claim.id,
        text: claim.claim,
        kind: 'acceptance',
        proofMode: 'state',
        verdict: 'missing',
        recipeNodes: [],
        assertionIndices: [],
        moments: [],
        evidence: [],
      },
    ],
    recording: { status: 'not-required', segments: [] },
  };
  const documents = {
    'evidence-manifest.json': { version: 1, standalone: [] },
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
        {
          nodeId: 'read',
          action: 'state_read',
          intent: 'Read local state',
          ok: true,
          output: { count: 1 },
        },
        { nodeId: 'done', action: 'end', status: 'pass', ok: true },
      ].map((entry) => ({
        ...entry,
        startedAt: invocation.startedAt,
        endedAt: invocation.startedAt,
        durationMs: 0,
      })),
    },
    'summary.json': {
      recipeRunId: invocation.recipeRunId,
      status: 'pass',
      total: 2,
      passed: 2,
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
  const inventory = [];
  for (const [file, document] of Object.entries(documents)) {
    const bytes = JSON.stringify(document);
    await writeFile(path.join(directory, file), bytes);
    inventory.push({
      path: `artifacts/recipe-runs/attempt/${file}`,
      purpose: file === 'evidence-manifest.json' ? 'evidence-manifest-source' : 'json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const input = (await readRecordedEvidencePackage(directory)).input;
  const validation = validateRecordedEvidencePackage(input);
  assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
  const prepared = makeReadyGatePackage({
    evidenceManifest: inventory,
    selectedEvidenceKeys: [],
    reviewPolicy: { minimumReviews, requestedBy: 'dispatch' },
  });
  prepared.reviewSubjectHash = computeReadyGateReviewSubjectHash(prepared);
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  const run = createRun({
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'UNIT-CLAIM-OVERRIDE',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const decision: RunDecision = {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Review',
    description: 'Test',
    createdAt: invocation.startedAt,
    actions: [],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: 'Finished',
      branch: prepared.branch,
      diffStat: prepared.diffStat,
      prPackage: prepared,
    },
  };
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [decision],
    taskFile: path.join(root, 'TASK.md'),
  });
  await retainRunFixture(getRun(run.id)!, prepared);
  const acceptance = async () => ({
    criteria: [{ id: claim.id, text: claim.claim }],
    ledger: claims,
    issues: [],
  });
  const authorizeEvidenceAttestation = () => ({
    principalId: 'person',
    displayName: 'Reviewer',
    credentialId: 'credential',
  });
  const request = buildRunDecisionActionRequest({
    runId: run.id,
    decision,
    actionId: MARK_CLAIM_UNTESTABLE_ACTION,
    claimId: claim.id,
    recipeRunId: invocation.recipeRunId,
    claimOverrideReason: 'The service is offline.',
  });
  const params = request.params as RunOverrideClaimParams;
  const dependencies = {
    acceptance,
    authorizeEvidenceAttestation,
    refreshPackage: async ({ runId }: RunRefreshPublishPackageParams) => {
      const current = getRun(runId);
      assert.ok(current);
      return { run: current };
    },
  };
  const gateSources = {
    acceptance,
    deterministic: async () => {},
    selectedEvidence: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
  };
  return { run, decision, params, dependencies, gateSources, prepared, directory, input };
}

test('an override refreshes the pending package after its receipt is durable', async (t) => {
  const f = await fixture(t, 1);
  const reviews: ReviewStatus[] = [
    certifyingReview(f.prepared, {
      id: 'current-review',
      reviewerSessionId: 'retained-reviewer',
      retryCount: 0,
    }),
  ];
  const priorReviewState = structuredClone(reviews);
  updateRun(f.run.id, { engineState: { publishGate: { reviews } } });
  let refreshed = 0;
  const dependencies = {
    ...f.dependencies,
    refreshPackage: async (params: RunRefreshPublishPackageParams) => {
      assert.deepEqual(params, { runId: f.run.id, decisionId: f.decision.id });
      const stored: unknown = JSON.parse(
        await readFile(path.join(runsDirectory(), `${f.run.id}.json`), 'utf8'),
      );
      assert.ok(isRecord(stored));
      const current = getRun(f.run.id);
      assert.ok(current);
      const receipt = current.claimOverrideReceipts?.[0];
      assert.ok(receipt);
      assert.deepEqual(stored.claimOverrideReceipts, [receipt]);
      assert.equal(current.decisions[0].resolvedAt, undefined);
      const prPackage = {
        ...f.prepared,
        claimOverrideReceiptIds: [receipt.id],
      };
      prPackage.packageHash = computeReadyGatePackageHash(prPackage);
      const decision = current.decisions.find(({ id }) => id === f.decision.id);
      assert.ok(decision?.payload?.kind === 'ready');
      decision.payload.prPackage = prPackage;
      refreshed++;
      return { run: current };
    },
  };
  const result = await runOverrideClaim(f.params, () => {}, dependencies);
  assert.equal(refreshed, 1);
  assert.equal(result.run.decisions[0].resolvedAt, undefined);
  const payload = result.run.decisions[0].payload;
  assert.ok(payload?.kind === 'ready');
  assert.deepEqual(payload.prPackage?.claimOverrideReceiptIds, [result.receipt.id]);
  assert.deepEqual(result.run.engineState?.publishGate?.reviews, priorReviewState);
  assert.equal(result.run.reviewRoundAdmissions?.length ?? 0, 0);
  const readiness = await collectRunGateReadiness(result.run, payload.prPackage, {
    ...f.gateSources,
    reviewResult: async (_run, relative) =>
      relative === reviews[0].artifactPaths?.[0] ? PASSING_REVIEW_RESULT : undefined,
  });
  assert.equal(readiness.state, 'ready', JSON.stringify(readiness.reasons));
  const retry = await runOverrideClaim(f.params, () => {}, dependencies);
  assert.equal(retry.receipt.id, result.receipt.id);
  assert.equal(refreshed, 1);
  assert.deepEqual(retry.run.engineState?.publishGate?.reviews, priorReviewState);
});

test('an override whose package refresh fails retains its receipt for an idempotent retry', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runOverrideClaim(f.params, () => {}, {
      ...f.dependencies,
      refreshPackage: async () => {
        throw new Error('Source is temporarily unavailable');
      },
    }),
    /Override saved, but package refresh failed: Source is temporarily unavailable/,
  );
  const saved = getRun(f.run.id)?.claimOverrideReceipts;
  assert.equal(saved?.length, 1);
  let refreshed = 0;
  const result = await runOverrideClaim(f.params, () => {}, {
    ...f.dependencies,
    refreshPackage: async (params: RunRefreshPublishPackageParams) => {
      refreshed++;
      return f.dependencies.refreshPackage(params);
    },
  });
  assert.equal(refreshed, 1);
  assert.equal(result.receipt.id, saved?.[0].id);
  assert.equal(result.run.claimOverrideReceipts?.length, 1);
  assert.equal(result.run.decisions[0].resolvedAt, undefined);
});

test('verified receipt is durable, idempotent and satisfies both binding and verdict after refresh', async (t) => {
  const f = await fixture(t);
  const original = await readFile(path.join(f.directory, 'acceptance-status.json'));
  const result = await runOverrideClaim(f.params, () => {}, f.dependencies);
  assert.equal(result.receipt.priorVerdict, 'missing');
  assert.equal(result.run.decisions[0].resolvedAt, undefined);
  assert.deepEqual(await readFile(path.join(f.directory, 'acceptance-status.json')), original);
  const stored = JSON.parse(await readFile(path.join(runsDirectory(), `${f.run.id}.json`), 'utf8'));
  assert.equal(stored.claimOverrideReceipts[0].id, result.receipt.id);
  assert.equal(
    (await runOverrideClaim(f.params, () => {}, f.dependencies)).receipt.id,
    result.receipt.id,
  );
  const second = await runOverrideClaim(
    { ...f.params, reason: 'Still unavailable.' },
    () => {},
    f.dependencies,
  );
  assert.equal(second.receipt.priorVerdict, 'untestable');
  assert.equal(getRun(f.run.id)?.claimOverrideReceipts?.length, 2);
  const stale = await collectRunGateReadiness(f.run, f.prepared, f.gateSources);
  assert.ok(stale.reasons.some(({ code }) => code === 'evidence-override-refresh-required'));
  f.prepared.claimOverrideReceiptIds = [result.receipt.id, second.receipt.id].sort();
  f.prepared.packageHash = computeReadyGatePackageHash(f.prepared);
  assert.equal(
    (await runOverrideClaim(f.params, () => {}, f.dependencies)).receipt.id,
    result.receipt.id,
  );
  const current = await collectRunGateReadiness(f.run, f.prepared, f.gateSources);
  assert.equal(current.state, 'ready', JSON.stringify(current.reasons));
  const denied = await collectRunGateReadiness(f.run, f.prepared, {
    ...f.gateSources,
    deterministic: async () => {
      throw new Error('Required test failed');
    },
  });
  assert.ok(denied.reasons.some(({ prerequisite }) => prerequisite === 'deterministic'));
});

test('unverified authority, wrong execution, stale snapshot and reader failure leave no receipt', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runOverrideClaim(f.params, () => {}),
    /credential-backed/,
  );
  for (const patch of [{ reason: ' ' }, { recipeRunId: 'other' }, { snapshotIdentity: 'stale' }])
    await assert.rejects(runOverrideClaim({ ...f.params, ...patch }, () => {}, f.dependencies));
  await assert.rejects(
    runOverrideClaim(f.params, () => {}, {
      ...f.dependencies,
      authorizeEvidenceAttestation: () => {
        throw new Error('Credential revoked');
      },
    }),
    /revoked/,
  );
  await assert.rejects(
    runOverrideClaim(f.params, () => {}, {
      ...f.dependencies,
      evidence: async () => {
        throw new Error('Reader failed');
      },
    }),
    /Reader failed/,
  );
  await assert.rejects(
    runOverrideClaim(f.params, () => {}, {
      ...f.dependencies,
      acceptance: async () => {
        f.decision.resolvedAt = new Date().toISOString();
        return f.dependencies.acceptance();
      },
    }),
    /gate changed/,
  );
  assert.equal(getRun(f.run.id)?.claimOverrideReceipts, undefined);
});

test('a QA case row binds the override to the case execution it came from', async (t) => {
  const f = await fixture(t);
  const { ledger, ...read } = await f.dependencies.acceptance();
  // A merged QA ledger: a later case was projected last, this row is the fixture's case.
  const caseRow = (recipeRunId: string) => async () => ({
    ...read,
    ledger: {
      ...ledger,
      recipeRunId: 'later-case',
      criteria: ledger.criteria.map((row) => ({ ...row, recipeRunId })),
    },
  });
  await assert.rejects(
    runOverrideClaim(f.params, () => {}, {
      ...f.dependencies,
      acceptance: caseRow('other-case'),
    }),
    /does not match the registered task execution/,
  );
  assert.equal(getRun(f.run.id)?.claimOverrideReceipts, undefined);
  const result = await runOverrideClaim(f.params, () => {}, {
    ...f.dependencies,
    acceptance: caseRow(f.params.recipeRunId),
  });
  assert.equal(result.receipt.recipeRunId, f.params.recipeRunId);
});

test('failed durable receipt storage exposes no effective override', async (t) => {
  const f = await fixture(t);
  const write = fsPromises.writeFile;
  const handle = t.mock.method(fsPromises, 'writeFile', (...args: Parameters<typeof write>) => {
    if (String(args[0]).includes(`${f.run.id}.json.tmp`)) throw new Error('Receipt storage failed');
    return write(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    handle.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    runOverrideClaim(f.params, () => {}, f.dependencies),
    /storage failed/,
  );
  assert.equal(getRun(f.run.id)?.claimOverrideReceipts, undefined);
  assert.equal(getRun(f.run.id)?.decisions[0]?.resolvedAt, undefined);
});

test('an output override changes confirmation identity and preserves the frozen report', async (t) => {
  const f = await fixture(t);
  f.decision.type = 'engine_output_review';
  f.decision.payload = {
    kind: 'output-review',
    reportPath: 'artifacts/report.html',
    manifestDigest: 'frozen-output',
  };
  const before = runClaimOverrideSnapshotIdentity(f.decision);
  const params = { ...f.params, snapshotIdentity: before };
  const dependencies = { ...f.dependencies, evidence: async () => [f.input] };
  const result = await runOverrideClaim(params, () => {}, dependencies);
  const decision = result.run.decisions[0];
  assert.equal(decision.resolvedAt, undefined);
  assert.notEqual(runClaimOverrideSnapshotIdentity(decision), before);
  assert.deepEqual(decision.payload, {
    kind: 'output-review',
    reportPath: 'artifacts/report.html',
    manifestDigest: 'frozen-output',
    claimOverrideReceiptIds: [result.receipt.id],
  });
  assert.equal(
    (await runOverrideClaim(params, () => {}, dependencies)).receipt.id,
    result.receipt.id,
  );
  await assert.rejects(
    runOverrideClaim({ ...params, reason: 'Another reason.' }, () => {}, dependencies),
    /snapshot changed/,
  );
});
