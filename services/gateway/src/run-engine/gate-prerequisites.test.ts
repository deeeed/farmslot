import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  digestRecipeDocument,
  type RecipeClaimLedger,
  type ReviewStatus,
  type RunDecision,
} from '@farmslot/protocol';

import { retainFixtureTask } from '../../../../packages/run-bundle/src/retained.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const { collectRunGateReadiness, gateActionsForReadiness, refreshRunGateReadiness } =
  await import('./gate-prerequisites.js');
const { makeRun, makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('./test-fixtures.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { runBundleStore, retainedRunTaskDirectory } =
  await import('../run-completion/retained-artifacts.js');
const { computeReadyGatePackageHash } = await import('../run-completion/ready-gate-package.js');

const idle = async () => ({ kind: 'idle' as const });
const emptyAcceptance = async () => ({ criteria: [], ledger: null, issues: [] });
const passed = async () => {};

test('artifact-only comparison and reportless output retain their digest fence without a review decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-output-no-decision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'artifacts/result.json'), JSON.stringify({ complete: true }));
  const { captureRunOutput, failRunOutputCapture } = await import('../run-completion/output.js');
  for (const lane of ['comparison', 'production'] as const) {
    const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'OUTPUT-1' });
    t.after(() => deleteTestRunIfPresent(run.id));
    updateRun(run.id, {
      lane,
      completionPolicy: 'artifact-only',
      status: 'completing',
      taskFile: path.join(root, 'TASK.md'),
    });
    await captureRunOutput(run.id, false, true);
    assert.equal(getRun(run.id)?.decisions.length, 0);
    const sources = { deterministic: passed, acceptance: emptyAcceptance, progress: idle };
    assert.equal((await collectRunGateReadiness(getRun(run.id)!, null, sources)).state, 'ready');
    const refused = await collectRunGateReadiness(getRun(run.id)!, null, {
      ...sources,
      progress: async () => {
        failRunOutputCapture(run.id, new Error('Transfer failed'), true);
        return { kind: 'idle' };
      },
    });
    assert.equal(refused.state, 'not-ready');
    assert.ok(refused.reasons.some((reason) => reason.code === 'run-gate-superseded'));
  }
});

test('unassessed criteria cannot offer a ready action even when deterministic steps passed', async () => {
  const criteria = Array.from({ length: 11 }, (_, index) => ({
    id: `AC-${index + 1}`,
    text: `Criterion ${index + 1}`,
  }));
  const readiness = await collectRunGateReadiness(makeRun(), null, {
    deterministic: passed,
    acceptance: async () => ({
      criteria,
      ledger: null,
      issues: ['Registered criteria need verdicts'],
    }),
    progress: idle,
  });
  assert.equal(readiness.state, 'not-ready');
  assert.ok(readiness.reasons.some((reason) => reason.code === 'acceptance-incomplete'));
  assert.deepEqual(
    gateActionsForReadiness([{ id: 'ready' }, { id: 'hold' }, { id: 'request-review' }], readiness),
    [{ id: 'hold' }, { id: 'request-review' }],
  );
});

test('a missing receipt and unreadable registration both remain visible refusals', async () => {
  const readiness = await collectRunGateReadiness(makeRun(), null, {
    deterministic: async () => {
      throw new Error('stale receipt');
    },
    acceptance: async () => ({
      criteria: [],
      ledger: null,
      issues: [],
      error: 'registration unavailable',
    }),
    progress: idle,
  });
  assert.deepEqual(
    readiness.reasons.map((reason) => reason.prerequisite),
    ['deterministic', 'acceptance'],
  );
  assert.equal(readiness.state, 'not-ready');
});

test('unknown operation state cannot turn otherwise complete inputs into a ready gate', async () => {
  const uncertain = await collectRunGateReadiness(makeRun(), null, {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: async () => ({ kind: 'unproven' }),
  });
  assert.equal(uncertain.state, 'not-ready');
  assert.equal(uncertain.reasons[0].code, 'run-progress-unconfirmed');
  const waiting = await collectRunGateReadiness(makeRun(), null, {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: async () => ({ kind: 'awaiting-input' }),
  });
  assert.equal(waiting.state, 'not-ready');
  assert.equal(waiting.reasons[0].code, 'run-progress-unconfirmed');
  const progressing = await collectRunGateReadiness(makeRun(), null, {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: async () => ({ kind: 'making-progress' }),
  });
  assert.equal(progressing.state, 'collecting');
  const complete = await collectRunGateReadiness(makeRun(), null, {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
  });
  assert.equal(complete.state, 'ready');
});

test('review overrides waive only their owning review policy, never checks or live work', () => {
  const actions = [{ id: 'approve-publish' }, { id: 'approve-publish-unresolved' }, { id: 'hold' }];
  const readiness = {
    state: 'not-ready' as const,
    identity: { runId: 'run', generation: 1 },
    reasons: [
      {
        code: 'review-result-required',
        prerequisite: 'review' as const,
        message: 'Review required',
        allowedReviewOverrides: ['approve-publish-unresolved'],
      },
    ],
  };
  assert.deepEqual(gateActionsForReadiness(actions, readiness), actions.slice(1));
  for (const prerequisite of ['deterministic', 'evidence', 'lifecycle'] as const) {
    assert.deepEqual(
      gateActionsForReadiness(actions, {
        ...readiness,
        reasons: [
          ...readiness.reasons,
          { code: 'missing', prerequisite, message: 'Missing prerequisite' },
        ],
      }),
      [{ id: 'hold' }],
    );
  }
});

test('a passing fix/review loop consumes its final artifact and rejects a missing final result', async () => {
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
  const paths = [
    'artifacts/review-1/loop-1/review-result.json',
    'artifacts/review-1/loop-2/review-result.json',
  ];
  const review: ReviewStatus = {
    id: 'review-1',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    reviewerSessionId: 'session-1',
    reviewedHeadSha: prepared.headSha,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    reviewSnapshot: prepared.reviewSnapshot,
    verdict: 'pass',
    unresolvedCount: 0,
    artifactPaths: paths,
    attempts: [
      {
        mode: 'cold',
        loopNumber: 1,
        verdict: 'issues',
        unresolvedCount: 1,
        artifactPaths: [paths[0]],
      },
      {
        mode: 'cold',
        loopNumber: 2,
        verdict: 'pass',
        unresolvedCount: 0,
        artifactPaths: [paths[1]],
      },
    ],
  };
  const run = makeRun({ engineState: { publishGate: { reviews: [review] } } });
  const requested: string[] = [];
  const inputs = {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
  };
  const ready = await collectRunGateReadiness(run, prepared, {
    ...inputs,
    reviewResult: async (_run, relative) => {
      requested.push(relative);
      return JSON.stringify({ schemaVersion: 1, verdict: 'pass', issues: [] });
    },
  });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(requested, [paths[1]]);
  const missing = await collectRunGateReadiness(run, prepared, {
    ...inputs,
    reviewResult: async () => undefined,
  });
  assert.equal(missing.state, 'not-ready');
  assert.ok(missing.reasons.some((reason) => reason.code === 'review-result-invalid'));
  const optional = await collectRunGateReadiness(
    run,
    {
      ...prepared,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    },
    { ...inputs, reviewResult: async () => undefined },
  );
  assert.equal(optional.state, 'ready');
});

function pendingReadyDecision(): RunDecision {
  return {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Ready gate',
    description: '',
    createdAt: '2026-10-12T00:00:00.000Z',
    actions: [
      { id: 'ready', label: 'Ready', style: 'primary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: 'done',
      branch: 'feature',
      diffStat: { files: 0, additions: 0, deletions: 0 },
    },
  };
}

test('late runner observations remove advancement and a later idle receipt restores the original action', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'GATE-REFRESH' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { status: 'human-gating', decisions: [pendingReadyDecision()] });
  const inputs = { deterministic: passed, acceptance: emptyAcceptance };
  const active = await refreshRunGateReadiness(run, {
    ...inputs,
    progress: async () => ({ kind: 'making-progress', activeRole: 'primary' }),
  });
  assert.equal(active.status, 'monitoring');
  assert.deepEqual(
    active.decisions[0].actions.map((action) => action.id),
    ['hold'],
  );
  const settled = await refreshRunGateReadiness(active, { ...inputs, progress: idle });
  assert.equal(settled.status, 'human-gating');
  assert.deepEqual(
    settled.decisions[0].actions.map((action) => action.id),
    ['ready', 'hold'],
  );
});

test('cancellation while readiness refresh awaits leaves the decision and terminal status intact', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'GATE-REFRESH-CANCEL' });
  t.after(() => deleteTestRunIfPresent(run.id));
  const original = pendingReadyDecision();
  updateRun(run.id, { status: 'human-gating', decisions: [original] });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const refresh = refreshRunGateReadiness(run, {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: async () => {
      await waiting;
      return { kind: 'idle' };
    },
  });
  updateRun(run.id, { status: 'cancelled' });
  release();
  await refresh;
  assert.equal(getRun(run.id)!.status, 'cancelled');
  assert.deepEqual(getRun(run.id)!.decisions, [original]);
});

test('the owner input is validated canonically and unreadable closure stays a typed refusal', async () => {
  const sources = {
    deterministic: passed,
    progress: idle,
    acceptance: async () => ({
      criteria: [{ id: 'AC-1', text: 'Required proof' }],
      ledger: null,
      issues: [],
    }),
  };
  const invalid = await collectRunGateReadiness(makeRun(), null, {
    ...sources,
    recordedEvidence: async () => [{ summary: null, artifactDigests: {}, timelines: {} }],
  });
  assert.ok(invalid.reasons.some((reason) => reason.code === 'evidence-invalid'));
  assert.deepEqual(
    gateActionsForReadiness([{ id: 'approve-publish-evidence-attested' }], invalid),
    [],
  );
  const unavailable = await collectRunGateReadiness(makeRun(), null, {
    ...sources,
    recordedEvidence: async () => {
      throw new Error('Frozen artifact is unreadable');
    },
  });
  assert.ok(
    unavailable.reasons.some((reason) => reason.code === 'evidence-validation-unavailable'),
  );
  assert.deepEqual(
    gateActionsForReadiness([{ id: 'approve-publish-evidence-attested' }], unavailable),
    [],
  );
  // Retained producer shape from the chart run: a stored criterion lacks moments.
  // The independent validator repair may turn the exception into an invalid result;
  // either outcome remains non-bypassable here.
  const missingMoments = await collectRunGateReadiness(makeRun(), null, {
    ...sources,
    recordedEvidence: async () => [
      JSON.parse(
        JSON.stringify({
          summary: { status: 'pass' },
          artifactDigests: {},
          timelines: {},
          claims: {
            schemaVersion: 2,
            recipeRunId: 'retained',
            recording: { status: 'complete' },
            criteria: [{ id: 'AC-1', verdict: 'proven', proofMode: 'visual' }],
          },
        }),
      ),
    ],
  });
  assert.ok(
    missingMoments.reasons.some((reason) =>
      ['evidence-invalid', 'evidence-validation-unavailable'].includes(reason.code),
    ),
  );
  assert.deepEqual(
    gateActionsForReadiness([{ id: 'approve-publish-evidence-attested' }], missingMoments),
    [],
  );
});

test('the shared reader accepts a frozen required claim and refuses changed or unreadable inputs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'artifacts/proof');
  await mkdir(directory, { recursive: true });
  const declaration = { id: 'AC-1', claim: 'The counter is one.', proofMode: 'state' as const };
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Counter proof',
    description: 'Observe the counter and verify its value.',
    proofTargets: [declaration],
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
    recipeRunId: 'counter-proof',
    startedAt: '2026-10-12T00:00:00Z',
    params: {},
    redactedPaths: [],
  };
  const claims: RecipeClaimLedger = {
    schemaVersion: 2,
    recipeRunId: invocation.recipeRunId,
    criteria: [
      {
        id: declaration.id,
        text: declaration.claim,
        kind: 'acceptance',
        proofMode: 'state',
        verdict: 'proven',
        recipeNodes: ['assert'],
        assertionIndices: [1],
        moments: [],
        evidence: [],
      },
    ],
    recording: { status: 'not-required', segments: [] },
  };
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
        {
          nodeId: 'read',
          action: 'state_read',
          intent: 'Read counter',
          ok: true,
          output: { count: 1 },
        },
        {
          nodeId: 'assert',
          action: 'assert_output',
          intent: 'Verify counter',
          ok: true,
          output: { matched: true },
        },
        { nodeId: 'done', action: 'end', ok: true, status: 'pass' },
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
  const evidenceManifest = [];
  for (const [file, document] of Object.entries(documents)) {
    const bytes = JSON.stringify(document);
    await writeFile(path.join(directory, file), bytes);
    evidenceManifest.push({
      path: `artifacts/proof/${file}`,
      purpose: 'json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const prepared: ReturnType<typeof makeReadyGatePackage> = JSON.parse(
    JSON.stringify(
      makeReadyGatePackage({
        evidenceManifest,
        selectedEvidenceKeys: [],
        reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
      }),
    ),
  );
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  const run = makeRun({ id: randomUUID(), taskFile: path.join(root, 'TASK.md') });
  await retainFixtureTask(root, run, await runBundleStore(true));
  prepared.artifactBundle = run.artifactBundle;
  prepared.packageHash = computeReadyGatePackageHash(prepared);
  const pinnedDecision = pendingReadyDecision();
  if (pinnedDecision.payload?.kind === 'ready') pinnedDecision.payload.prPackage = prepared;
  run.decisions.push(pinnedDecision);
  const sources = {
    deterministic: passed,
    progress: idle,
    selectedEvidence: passed,
    acceptance: async () => ({
      criteria: [{ id: declaration.id, text: declaration.claim }],
      ledger: claims,
      issues: [],
    }),
  };
  const check = () => collectRunGateReadiness(run, prepared, sources);
  const owner = validateRecordedEvidencePackage(
    (await readRecordedEvidencePackage(directory)).input,
  );
  assert.equal(owner.status, 'valid', JSON.stringify(owner.findings));
  const valid = await check();
  assert.equal(valid.state, 'ready', JSON.stringify(valid.reasons));
  const retained = (await readRecordedEvidencePackage(directory)).input;
  const staleLedger = await collectRunGateReadiness(run, prepared, {
    ...sources,
    acceptance: async () => ({
      criteria: [{ id: declaration.id, text: declaration.claim }],
      ledger: { ...claims, recipeRunId: 'different-attempt' },
      issues: [],
    }),
    recordedEvidence: async () => [retained],
  });
  assert.ok(staleLedger.reasons.some((reason) => reason.code === 'evidence-execution-mismatch'));
  assert.deepEqual(
    gateActionsForReadiness(
      [{ id: 'approve-publish' }, { id: 'approve-publish-evidence-attested' }, { id: 'hold' }],
      staleLedger,
    ),
    [{ id: 'hold' }],
  );
  // Retained schema-1 task verdicts remain display only. A current gate must not
  // use them to bypass engine execution identity, even with a policy attestation.
  const legacy = {
    ...retained,
    claims: undefined,
    summary: { ...documents['summary.json'], recipeRunId: undefined },
    manifest: {
      ...documents['artifact-manifest.json'],
      artifacts: documents['artifact-manifest.json'].artifacts.filter(
        (file) => file.path !== 'acceptance-status.json',
      ),
    },
  };
  assert.equal(validateRecordedEvidencePackage(legacy).status, 'valid');
  const legacyGate = await collectRunGateReadiness(run, prepared, {
    ...sources,
    acceptance: async () => ({
      criteria: [{ id: declaration.id, text: declaration.claim }],
      ledger: {
        schemaVersion: 1,
        criteria: [
          {
            id: declaration.id,
            text: declaration.claim,
            verdict: 'proven',
            proofMode: 'state',
            recipeNodes: [],
            evidence: ['artifacts/proof/trace.json'],
            updatedAt: invocation.startedAt,
          },
        ],
      },
      issues: [],
    }),
    recordedEvidence: async () => [legacy],
  });
  assert.deepEqual(
    legacyGate.reasons.map((reason) => reason.code),
    ['evidence-execution-mismatch'],
  );
  assert.deepEqual(
    gateActionsForReadiness([{ id: 'approve-publish-evidence-attested' }], legacyGate),
    [],
  );
  const partial = {
    ...retained,
    summary: { ...documents['summary.json'], total: 2, passed: 2, stopAfterNode: 'assert' },
    trace: { entries: documents['trace.json'].entries.slice(0, 2) },
  };
  const partialValidation = validateRecordedEvidencePackage(partial);
  assert.equal(partialValidation.status, 'valid', JSON.stringify(partialValidation.findings));
  const partialGate = await collectRunGateReadiness(run, prepared, {
    ...sources,
    recordedEvidence: async () => [partial],
  });
  assert.ok(partialGate.reasons.some((reason) => reason.evidencePolicy === 'execution-verdict'));
  assert.deepEqual(
    gateActionsForReadiness(
      [{ id: 'approve-publish-evidence-attested' }, { id: 'approve-publish' }],
      partialGate,
    ),
    [{ id: 'approve-publish-evidence-attested' }],
  );

  await writeFile(path.join(root, prepared.artifactPath), JSON.stringify(prepared));
  await retainFixtureTask(root, run, await runBundleStore(true));
  const recoveredRun = {
    ...run,
    engineState: { publishGate: { packageId: prepared.id, packageHash: prepared.packageHash } },
  };
  const recovered = await collectRunGateReadiness(recoveredRun, null, sources);
  assert.equal(recovered.state, 'ready', JSON.stringify(recovered.reasons));
  assert.equal(recovered.identity.packageHash, prepared.packageHash);
  const stale = await collectRunGateReadiness(
    {
      ...recoveredRun,
      engineState: { publishGate: { packageId: prepared.id, packageHash: 'substituted-package' } },
    },
    null,
    sources,
  );
  assert.equal(stale.state, 'not-ready');
  assert.ok(stale.reasons.some((reason) => reason.message.includes('gate identity')));

  const foreign = await collectRunGateReadiness(run, prepared, {
    ...sources,
    acceptance: async () => ({
      criteria: [{ id: declaration.id, text: 'A different task requirement' }],
      ledger: claims,
      issues: [],
    }),
  });
  assert.ok(foreign.reasons.some((reason) => reason.evidencePolicy === 'criterion-binding'));

  const qaRun = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'QA-OUTPUT' });
  t.after(() => deleteTestRunIfPresent(qaRun.id));
  const qaCriterion = { id: declaration.id, text: declaration.claim };
  const qaLedger = {
    ...claims,
    criteria: [{ ...claims.criteria[0]!, evidence: ['artifacts/proof/trace.json'] }],
  };
  await writeFile(path.join(root, 'artifacts/acceptance-status.json'), JSON.stringify(qaLedger));
  await writeFile(
    path.join(root, 'artifacts/discovery.json'),
    JSON.stringify({ provider: 'configured' }),
  );
  await writeFile(path.join(root, 'artifacts/qa-report.md'), '# Retained QA output\n');
  updateRun(qaRun.id, {
    flowType: 'qa',
    status: 'completing',
    completionPolicy: 'artifact-only',
    taskFile: run.taskFile,
  });
  const { captureRunOutput, failRunOutputCapture } = await import('../run-completion/output.js');
  await captureRunOutput(qaRun.id, false, true);
  const qaSources = {
    deterministic: passed,
    progress: idle,
    qaCompletion: async () => ({
      packages: [{ path: 'proof', digest: digestRecipeDocument(recipe) }],
      headSha: 'a'.repeat(40),
    }),
    acceptance: async () => ({ criteria: [qaCriterion], ledger: qaLedger, issues: [] }),
  };
  const qaCheck = () => collectRunGateReadiness(getRun(qaRun.id)!, null, qaSources);
  const qaReady = await qaCheck();
  assert.equal(qaReady.state, 'ready', JSON.stringify(qaReady.reasons));
  assert.equal(getRun(qaRun.id)?.decisions.at(-1)?.payload?.kind, 'output-review');
  // Valid retained packages may carry task state ACs with no executed prover,
  // as in launch/doctor/CI criteria beside a successful smoke execution.
  const missingTargets = [1, 4, 5].map((index) => ({
    id: `AC-${index}`,
    claim: `External task check ${index}`,
    proofMode: 'state' as const,
  }));
  const smokeTarget = { ...declaration, id: 'smoke' };
  const unresolvedRecipe = {
    ...recipe,
    proofTargets: [smokeTarget],
    workflow: {
      ...recipe.workflow,
      nodes: {
        ...recipe.workflow.nodes,
        assert: { ...recipe.workflow.nodes.assert, proves: ['smoke'] },
      },
    },
  };
  const unresolvedInvocation = {
    ...invocation,
    recipeDigest: digestRecipeDocument(unresolvedRecipe),
    claims: [smokeTarget, ...missingTargets],
  };
  const unresolvedClaims: RecipeClaimLedger = {
    ...claims,
    criteria: [
      { ...claims.criteria[0]!, id: 'smoke' },
      ...missingTargets.map((target) => ({
        id: target.id,
        text: target.claim,
        kind: 'acceptance' as const,
        proofMode: target.proofMode,
        verdict: 'missing' as const,
        recipeNodes: [],
        assertionIndices: [],
        moments: [],
        evidence: [],
      })),
    ],
  };
  const unresolvedDirectory = path.join(root, 'artifacts/unresolved');
  await mkdir(unresolvedDirectory);
  for (const [name, value] of Object.entries({
    ...documents,
    'recipe.json': unresolvedRecipe,
    'recipe-invocation.json': unresolvedInvocation,
    'summary.json': {
      ...documents['summary.json'],
      invocationDigest: digestRecipeDocument(unresolvedInvocation),
    },
    'recipe-resolution.json': {
      ...documents['recipe-resolution.json'],
      root: { ref: '$root', digest: digestRecipeDocument(unresolvedRecipe) },
    },
    'acceptance-status.json': unresolvedClaims,
  }))
    await writeFile(path.join(unresolvedDirectory, name), JSON.stringify(value));
  const unresolvedRead = await readRecordedEvidencePackage(unresolvedDirectory);
  assert.ok(unresolvedRead.checks.every(({ status }) => status === 'pass'));
  assert.equal(
    validateRecordedEvidencePackage(unresolvedRead.input).status,
    'valid',
    JSON.stringify(validateRecordedEvidencePackage(unresolvedRead.input).findings),
  );
  const unresolvedSources = {
    ...qaSources,
    acceptance: async () => ({
      criteria: [
        { id: smokeTarget.id, text: smokeTarget.claim },
        ...missingTargets.map(({ id, claim }) => ({ id, text: claim })),
      ],
      ledger: unresolvedClaims,
      issues: [],
    }),
    recordedEvidence: async () => [unresolvedRead.input],
  };
  await captureRunOutput(qaRun.id, false, true);
  const gaps = await collectRunGateReadiness(getRun(qaRun.id)!, null, unresolvedSources);
  assert.equal(gaps.state, 'not-ready');
  assert.deepEqual(
    gaps.reasons.map(({ code, evidencePolicy }) => ({ code, evidencePolicy })),
    [{ code: 'evidence-policy-unsatisfied', evidencePolicy: 'claim-verdict' }],
  );
  assert.deepEqual(
    gateActionsForReadiness(
      [{ id: 'approve-publish' }, { id: 'close-run' }, { id: 'mark-reviewed' }],
      gaps,
    ),
    [{ id: 'close-run' }, { id: 'mark-reviewed' }],
  );
  assert.deepEqual(
    unresolvedRead.input.claims?.criteria.slice(1).map(({ verdict }) => verdict),
    ['missing', 'missing', 'missing'],
  );
  const changedRegistration = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...unresolvedSources,
    acceptance: async () => ({
      ...(await unresolvedSources.acceptance()),
      criteria: [{ id: 'AC-4', text: 'A different requirement' }],
    }),
  });
  assert.ok(changedRegistration.reasons.some(({ code }) => code === 'evidence-invalid'));
  const wrongExecution = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    acceptance: async () => ({
      criteria: [qaCriterion],
      ledger: { ...qaLedger, recipeRunId: 'unselected-corrected-attempt' },
      issues: [],
    }),
  });
  assert.ok(wrongExecution.reasons.some((reason) => reason.code === 'evidence-execution-mismatch'));
  const untestableLedger = {
    ...qaLedger,
    criteria: [
      {
        ...qaLedger.criteria[0],
        verdict: 'untestable' as const,
        evidence: [],
        note: 'Launching would replace the borrowed runtime.',
      },
    ],
  };
  await writeFile(
    path.join(root, 'artifacts/acceptance-status.json'),
    JSON.stringify(untestableLedger),
  );
  await captureRunOutput(qaRun.id, false, true);
  const untestable = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    acceptance: async () => ({ criteria: [qaCriterion], ledger: untestableLedger, issues: [] }),
  });
  assert.equal(untestable.state, 'not-ready');
  assert.ok(untestable.reasons.some((reason) => reason.code === 'evidence-invalid'));
  const mixedLedger = {
    ...qaLedger,
    criteria: [{ ...qaLedger.criteria[0], proofMode: 'mixed' as const }],
  };
  await writeFile(path.join(root, 'artifacts/acceptance-status.json'), JSON.stringify(mixedLedger));
  await captureRunOutput(qaRun.id, false, true);
  const missingVisual = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    acceptance: async () => ({ criteria: [qaCriterion], ledger: mixedLedger, issues: [] }),
  });
  assert.equal(missingVisual.state, 'ready', JSON.stringify(missingVisual.reasons)); // Engine mode owns proof; task transport cannot change it.
  await writeFile(path.join(root, 'artifacts/acceptance-status.json'), JSON.stringify(qaLedger));
  await captureRunOutput(qaRun.id, false, true);
  const refreshedDuringProgress = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    progress: async () => {
      await writeFile(
        path.join(root, 'artifacts/late-output.json'),
        JSON.stringify({ arrived: true }),
      );
      await captureRunOutput(qaRun.id, false, true);
      return { kind: 'idle' };
    },
  });
  assert.ok(
    refreshedDuringProgress.reasons.some((reason) => reason.code === 'run-gate-superseded'),
  );
  assert.equal((await qaCheck()).state, 'ready');
  const failedRefresh = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    progress: async () => {
      failRunOutputCapture(qaRun.id, new Error('Artifact transfer failed'), true);
      return { kind: 'idle' };
    },
  });
  assert.equal(failedRefresh.state, 'not-ready');
  assert.ok(failedRefresh.reasons.some((reason) => reason.code === 'run-gate-superseded'));
  await captureRunOutput(qaRun.id, false, true);
  assert.equal((await qaCheck()).state, 'ready');
  const absentCase = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    qaCompletion: async () => ({
      packages: [{ path: 'missing', digest: digestRecipeDocument(recipe) }],
      headSha: 'a'.repeat(40),
    }),
  });
  assert.ok(absentCase.reasons.some((reason) => reason.message.includes('required QA case')));
  const failedCase = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    qaCompletion: async () => {
      throw new Error('QA suite has a failing case');
    },
  });
  assert.ok(failedCase.reasons.some((reason) => reason.message.includes('failing case')));
  await writeFile(
    path.join(root, 'artifacts/discovery.json'),
    JSON.stringify({ provider: 'changed' }),
  );
  const pinnedOutput = structuredClone(getRun(qaRun.id)!.output?.artifactBundle);
  assert.equal((await qaCheck()).state, 'ready');
  assert.deepEqual(getRun(qaRun.id)!.output?.artifactBundle, pinnedOutput);
  await captureRunOutput(qaRun.id, false, true);
  assert.equal((await qaCheck()).state, 'ready');
  const missingStateEvidence = {
    ...qaLedger,
    criteria: [{ ...qaLedger.criteria[0], evidence: ['artifacts/not-captured.json'] }],
  };
  await writeFile(
    path.join(root, 'artifacts/acceptance-status.json'),
    JSON.stringify(missingStateEvidence),
  );
  await captureRunOutput(qaRun.id, false, true);
  const uncaptured = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    acceptance: async () => ({ criteria: [qaCriterion], ledger: missingStateEvidence, issues: [] }),
  });
  assert.equal(uncaptured.state, 'ready', JSON.stringify(uncaptured.reasons)); // Canonical frozen engine evidence is authoritative.
  const changedLedger = await collectRunGateReadiness(getRun(qaRun.id)!, null, {
    ...qaSources,
    acceptance: async () => ({
      criteria: [qaCriterion],
      ledger: { schemaVersion: 1, criteria: [] },
      issues: [],
    }),
  });
  assert.ok(changedLedger.reasons.some((reason) => reason.code === 'evidence-execution-mismatch'));

  await writeFile(
    path.join(directory, 'recipe-invocation.json'),
    JSON.stringify({ ...invocation, params: { substituted: true } }),
  );
  const afterLiveMutation = await check();
  assert.equal(afterLiveMutation.state, 'ready', JSON.stringify(afterLiveMutation.reasons));
  const retainedInvocation = path.join(
    await retainedRunTaskDirectory(run, prepared.artifactBundle),
    'artifacts/proof/recipe-invocation.json',
  );
  await chmod(retainedInvocation, 0o600);
  await writeFile(
    retainedInvocation,
    JSON.stringify({ ...invocation, params: { substituted: true } }),
  );
  assert.ok(
    (await check()).reasons.some((reason) => reason.code === 'evidence-validation-unavailable'),
  );
  await writeFile(retainedInvocation, '{');
  const unreadable = await check();
  assert.ok(unreadable.reasons.some((reason) => reason.code === 'evidence-validation-unavailable'));
  assert.ok(unreadable.reasons.some((reason) => reason.message.includes('recipe-invocation.json')));
  const unavailable = await collectRunGateReadiness(run, null, sources);
  assert.ok(
    unavailable.reasons.some((reason) => reason.message.includes('prepared evidence package')),
  );
});

test('unresolved approval requires real current-head review inputs and cannot waive changed inputs', async () => {
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
  const review: ReviewStatus = {
    id: 'native-current',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    reviewerSessionId: 'native-session',
    reviewedHeadSha: prepared.headSha,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    reviewSnapshot: prepared.reviewSnapshot,
    verdict: 'issues',
    unresolvedCount: 1,
    artifactPaths: ['artifacts/native-current/review-result.json'],
  };
  const actions = [{ id: 'approve-publish-unresolved' }, { id: 'hold' }];
  const exhaustedRun = {
    ...makeRun(),
    reviewRoundAdmissions: ['one', 'two', 'three', 'four', 'five'],
  };
  const inputs = {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
    reviewedInputsAwaitingReview: async () => null,
    reviewResult: async () =>
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'issues',
        issues: [{ file: 'src/example.ts', severity: 'warning', description: 'Remaining finding' }],
      }),
  };
  for (const reviews of [[], [{ ...review, reviewedHeadSha: 'old-head' }], [review]]) {
    const readiness = await collectRunGateReadiness(
      makeRun({ engineState: { publishGate: { reviews } } }),
      prepared,
      inputs,
    );
    assert.deepEqual(
      gateActionsForReadiness(actions, readiness),
      reviews[0] === review ? actions : actions.slice(1),
    );
    assert.match(
      readiness.reasons.find((reason) => reason.prerequisite === 'review')!.message,
      /current-head.*native.*request|current-head.*native.*Request/i,
    );
  }
  const exhausted = await collectRunGateReadiness(exhaustedRun, prepared, inputs);
  assert.match(
    exhausted.reasons.find((reason) => reason.prerequisite === 'review')!.message,
    /Review budget 5\/5.*extend-review-budget/,
  );
  assert.deepEqual(gateActionsForReadiness(actions, exhausted), actions.slice(1));
  const run = makeRun({ engineState: { publishGate: { reviews: [review] } } });
  const missing = await collectRunGateReadiness(run, prepared, {
    ...inputs,
    reviewResult: async () => undefined,
  });
  assert.deepEqual(gateActionsForReadiness(actions, missing), actions.slice(1));
  const changed = await collectRunGateReadiness(run, prepared, {
    ...inputs,
    reviewedInputsAwaitingReview: async () => 'new-fingerprint',
  });
  assert.ok(changed.reasons.some((reason) => reason.code === 'review-inputs-awaiting-review'));
  assert.deepEqual(gateActionsForReadiness(actions, changed), actions.slice(1));
});

test('zero-review publication policy still refuses changed reviewed inputs before approval', async () => {
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  const readiness = await collectRunGateReadiness(makeRun(), prepared, {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
    reviewedInputsAwaitingReview: async () => 'changed-proof',
  });
  const reason = readiness.reasons.find((entry) => entry.code === 'review-inputs-awaiting-review');
  assert.ok(reason);
  assert.match(reason.message, /Source or evidence changed after review.*Request reviews/);
  assert.deepEqual(
    gateActionsForReadiness(
      [{ id: 'approve-publish' }, { id: 'approve-publish-unresolved' }, { id: 'hold' }],
      readiness,
    ),
    [{ id: 'hold' }],
  );
});
