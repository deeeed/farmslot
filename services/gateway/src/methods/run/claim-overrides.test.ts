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
  MARK_CLAIM_UNTESTABLE_ACTION,
  type RecipeClaimLedger,
  runClaimOverrideSnapshotIdentity,
  type RunDecision,
  type RunOverrideClaimParams,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { createRun, updateRun, getRun, runsDirectory } = await import('../../runs/store.js');
const { runOverrideClaim } = await import('./claim-overrides.js');
const { collectRunGateReadiness } = await import('../../run-engine/gate-prerequisites.js');
const { deleteTestRunIfPresent, makeReadyGatePackage } =
  await import('../../run-engine/test-fixtures.js');
const { computeReadyGatePackageHash } = await import('../../run-completion/ready-gate-package.js');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claim-override-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'artifacts/proof');
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
      path: `artifacts/proof/${file}`,
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
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
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
  const dependencies = { acceptance, authorizeEvidenceAttestation };
  const gateSources = {
    acceptance,
    deterministic: async () => {},
    selectedEvidence: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
  };
  return { run, decision, params, dependencies, gateSources, prepared, directory, input };
}

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
