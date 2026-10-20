import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceStatusLedger,
  digestRecipeDocument,
  gateActionsForReadiness,
  isEvidencePolicyReason,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
  type RecipeClaimLedger,
  type RecordedEvidencePackageInput,
  type ReviewStatus,
  type RunDecision,
} from '@farmslot/protocol';

import { retainFixtureTask } from '../../../../packages/run-bundle/src/retained.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const { collectRunGateAssessment, collectRunGateReadiness, refreshRunGateReadiness } =
  await import('./gate-prerequisites.js');
const { makeRun, makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('./test-fixtures.js');
const { certifyingReview, openFindingAtHead, PASSING_REVIEW_RESULT, writeReviewClaimPackage } =
  await import('./review-claim.test-support.js');
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
    findings: [{ reviewId: 'review', file: 'src/example.ts', description: 'Open finding' }],
    findingsDigest: 'sha256:findings',
  };
  assert.deepEqual(gateActionsForReadiness(actions, readiness), actions.slice(1));
  // Accepting findings needs the head's checked findings, not only the override.
  assert.deepEqual(
    gateActionsForReadiness(actions, {
      ...readiness,
      findings: undefined,
      findingsDigest: undefined,
    }),
    [{ id: 'hold' }],
  );
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

test('a passing fix/review loop consumes its final artifact and rejects a missing final result', async (t) => {
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

  // Tmux pipeline results must also pass through the real retained-artifact reader.
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-pipeline-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pipelinePath = 'artifacts/pipeline-review-loop-2/review-result.json';
  await mkdir(path.dirname(path.join(root, pipelinePath)), { recursive: true });
  await writeFile(
    path.join(root, pipelinePath),
    JSON.stringify({ schemaVersion: 1, verdict: 'pass', issues: [] }),
  );
  const pipeline: ReviewStatus = {
    ...review,
    source: 'pipeline',
    runner: 'claude',
    artifactPaths: [pipelinePath],
    attempts: [{ ...review.attempts![1], artifactPaths: [pipelinePath] }],
  };
  const retained = makeRun({
    id: randomUUID(),
    taskFile: path.join(root, 'TASK.md'),
    engineState: { publishGate: { reviews: [pipeline] } },
  });
  await retainFixtureTask(root, retained, await runBundleStore(true));
  const fromBundle = await collectRunGateReadiness(retained, prepared, inputs);
  assert.equal(fromBundle.state, 'ready');
  assert.deepEqual(
    gateActionsForReadiness([{ id: 'approve-publish' }, { id: 'hold' }], fromBundle),
    [{ id: 'approve-publish' }, { id: 'hold' }],
  );
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
  // One package per QA case: each case proves its own criterion, and the task
  // ledger binds every row to the case execution it came from.
  const secondDeclaration: RecipeClaimDeclaration = {
    id: 'AC-2',
    claim: 'The second case reads the counter.',
    proofMode: 'state',
  };
  const caseCriteria = [qaCriterion, { id: secondDeclaration.id, text: secondDeclaration.claim }];
  const writeCase = async (name: string, proves: RecipeClaimDeclaration[]) => {
    const registered = [declaration, secondDeclaration].map(
      (target) => proves.find(({ id }) => id === target.id) ?? target,
    );
    const caseRecipe = {
      ...recipe,
      proofTargets: proves,
      workflow: {
        ...recipe.workflow,
        nodes: {
          ...recipe.workflow.nodes,
          assert: { ...recipe.workflow.nodes.assert, proves: proves.map(({ id }) => id) },
        },
      },
    };
    const caseInvocation = {
      ...invocation,
      recipeRunId: name,
      recipeDigest: digestRecipeDocument(caseRecipe),
      claims: registered,
    };
    const caseClaims: RecipeClaimLedger = {
      ...claims,
      recipeRunId: name,
      criteria: registered.map((target): RecipeClaimEvidence => {
        const proof = proves.find(({ id }) => id === target.id);
        const proofMode = target.proofMode ?? 'state';
        return {
          id: target.id,
          text: target.claim,
          kind: 'acceptance',
          proofMode,
          verdict: !proof ? 'missing' : proofMode === 'state' ? 'proven' : 'weak',
          recipeNodes: proof ? ['assert'] : [],
          assertionIndices: proof ? [1] : [],
          moments: [],
          evidence: [],
          ...(proof && proofMode !== 'state' ? { timing: 'outside-recording' } : {}),
        };
      }),
    };
    const caseDirectory = path.join(root, 'artifacts/recipe-runs', name);
    await mkdir(caseDirectory, { recursive: true });
    for (const [file, value] of Object.entries({
      ...documents,
      'recipe.json': caseRecipe,
      'recipe-invocation.json': caseInvocation,
      'summary.json': {
        ...documents['summary.json'],
        recipeRunId: name,
        invocationDigest: digestRecipeDocument(caseInvocation),
      },
      'recipe-resolution.json': {
        ...documents['recipe-resolution.json'],
        root: { ref: '$root', digest: digestRecipeDocument(caseRecipe) },
      },
      'acceptance-status.json': caseClaims,
    }))
      await writeFile(path.join(caseDirectory, file), JSON.stringify(value));
    const read = await readRecordedEvidencePackage(caseDirectory);
    const validation = validateRecordedEvidencePackage(read.input);
    assert.equal(validation.status, 'valid', JSON.stringify(validation.findings));
    return { input: read.input, claims: caseClaims };
  };
  const caseA = await writeCase('case-a', [declaration]);
  const caseB = await writeCase('case-b', [secondDeclaration]);
  const caseGate = (
    ledger: AcceptanceStatusLedger,
    inputs: RecordedEvidencePackageInput[] = [caseA.input, caseB.input],
  ) =>
    collectRunGateReadiness(getRun(qaRun.id)!, null, {
      ...qaSources,
      acceptance: async () => ({ criteria: caseCriteria, ledger, issues: [] }),
      recordedEvidence: async () => inputs,
    });
  const mergedLedger: AcceptanceStatusLedger = {
    ...caseB.claims,
    criteria: [
      { ...caseA.claims.criteria[0]!, recipeRunId: 'case-a' },
      { ...caseB.claims.criteria[1]!, recipeRunId: 'case-b' },
    ],
  };
  await captureRunOutput(qaRun.id, false, true);
  const merged = await caseGate(mergedLedger);
  assert.equal(merged.state, 'ready', JSON.stringify(merged.reasons));
  // The overwrite this replaces: the last case's copy leaves AC-1 missing.
  const overwritten = await caseGate(caseB.claims);
  assert.deepEqual(
    overwritten.reasons.map(({ code, evidencePolicy }) => ({ code, evidencePolicy })),
    [{ code: 'evidence-policy-unsatisfied', evidencePolicy: 'claim-verdict' }],
  );
  // A row whose case execution is no longer selected cannot bind.
  const superseded = await caseGate({
    ...mergedLedger,
    criteria: [{ ...mergedLedger.criteria[0]!, recipeRunId: 'case-a-superseded' }],
  });
  assert.ok(superseded.reasons.some(({ code }) => code === 'evidence-execution-mismatch'));
  // Another case's proof never hides a case that addresses the criterion weakly.
  const weakCase = await writeCase('case-a-visual', [
    declaration,
    { ...secondDeclaration, proofMode: 'visual' },
  ]);
  assert.equal(weakCase.claims.criteria[1]!.verdict, 'weak');
  const hidden = await caseGate(
    {
      ...mergedLedger,
      criteria: [
        { ...weakCase.claims.criteria[0]!, recipeRunId: 'case-a-visual' },
        mergedLedger.criteria[1]!,
      ],
    },
    [weakCase.input, caseB.input],
  );
  assert.deepEqual(
    hidden.reasons.map(({ evidencePolicy }) => evidencePolicy),
    ['claim-verdict'],
  );
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

test('publication findings do not become a QA output or review-posting prerequisite', async () => {
  for (const flowType of ['qa', 'review-pr'] as const) {
    const run = makeRun({
      flowType,
      completionPolicy: 'artifact-only',
      engineState: {
        publishGate: {
          reviews: [
            {
              id: 'rv',
              source: 'pipeline',
              mode: 'cold',
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 1,
            },
          ],
        },
      },
    });
    const readiness = await collectRunGateReadiness(run, null, {
      deterministic: passed,
      acceptance: emptyAcceptance,
      progress: idle,
    });
    assert.ok(!readiness.reasons.some((reason) => reason.code === 'review-fix-required'));
  }
});

test('optional reviews still withhold approval for ISSUES with no pending decision until the fixed head passes', async () => {
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  const review: ReviewStatus = {
    id: 'rv3',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 3,
    verdict: 'issues',
    unresolvedCount: 1,
    issues: [{ file: 'icon.service.ts', description: 'Exponential parsing' }],
    reviewedHeadSha: 'before-fix-head',
    feedbackSent: false,
    recoveryContinuationPending: true,
  };
  const sources = {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
    reviewedInputsAwaitingReview: async () => null,
    reviewResult: async () => undefined,
  };
  const actions = [
    { id: 'approve-publish' },
    { id: 'approve-publish-unresolved' },
    { id: 'approve-publish-evidence-attested' },
    { id: 'hold' },
  ];
  const run = makeRun({
    status: 'human-gating',
    decisions: [],
    engineState: { publishGate: { reviews: [review] } },
  });
  for (const status of ['human-gating', 'fixing'] as const) {
    const readiness = await collectRunGateReadiness({ ...run, status }, prepared, sources);
    assert.equal(readiness.state, 'not-ready');
    assert.match(
      readiness.reasons[0].message,
      status === 'fixing' ? /fix in progress/ : /Review found 1 issue/,
    );
    assert.deepEqual(gateActionsForReadiness(actions, readiness), [{ id: 'hold' }]);
  }
  const failedContinuation: ReviewStatus = {
    ...review,
    verdict: 'failed',
    feedbackSent: true,
    attempts: [
      { mode: 'cold', loopNumber: 1, verdict: 'issues', unresolvedCount: 1, issues: review.issues },
      { mode: 'warm', loopNumber: 2, verdict: 'failed', unresolvedCount: 1 },
    ],
  };
  const failed = await collectRunGateReadiness(
    { ...run, engineState: { publishGate: { reviews: [failedContinuation] } } },
    prepared,
    sources,
  );
  assert.deepEqual(gateActionsForReadiness(actions, failed), [{ id: 'hold' }]);
  const activeFix = await collectRunGateReadiness(
    {
      ...run,
      agentContexts: [
        {
          id: 'review-fix',
          role: 'review-fix',
          label: 'Fix',
          status: 'working',
          slotId: run.slotId!,
          runId: run.id,
        },
      ],
    },
    prepared,
    sources,
  );
  assert.match(activeFix.reasons[0].message, /fix in progress/);
  assert.deepEqual(gateActionsForReadiness(actions, activeFix), [{ id: 'hold' }]);
  const pass: ReviewStatus = {
    ...review,
    id: 'rv4',
    reviewedHeadSha: prepared.headSha,
    verdict: 'pass',
    unresolvedCount: 0,
    issues: [],
  };
  const ready = await collectRunGateReadiness(
    { ...run, engineState: { publishGate: { reviews: [review, pass] } } },
    prepared,
    sources,
  );
  assert.equal(ready.state, 'ready');
  assert.deepEqual(gateActionsForReadiness(actions.slice(0, 1), ready), actions.slice(0, 1));
  const stale = await collectRunGateReadiness(
    {
      ...run,
      engineState: { publishGate: { reviews: [review, { ...pass, reviewedHeadSha: 'old-head' }] } },
    },
    prepared,
    sources,
  );
  assert.equal(stale.state, 'not-ready');
  const replacedPass = {
    ...pass,
    attempts: [
      {
        mode: 'cold' as const,
        loopNumber: 1,
        verdict: 'issues' as const,
        unresolvedCount: 1,
        issues: review.issues,
      },
      {
        mode: 'warm' as const,
        loopNumber: 2,
        verdict: 'pass' as const,
        unresolvedCount: 0,
        reviewSnapshot: prepared.reviewSnapshot,
      },
    ],
  };
  const replaced = await collectRunGateReadiness(
    { ...run, engineState: { publishGate: { reviews: [replacedPass] } } },
    prepared,
    sources,
  );
  assert.equal(replaced.state, 'ready');
  const staleReplaced = await collectRunGateReadiness(
    {
      ...run,
      engineState: {
        publishGate: {
          reviews: [
            {
              ...replacedPass,
              reviewedHeadSha: 'old-head',
              attempts: replacedPass.attempts.map((attempt) => ({
                ...attempt,
                reviewSnapshot: undefined,
              })),
            },
          ],
        },
      },
    },
    prepared,
    sources,
  );
  assert.equal(staleReplaced.state, 'not-ready');
});

test('a different reviewer PASS cannot clear findings on the unchanged head at any review minimum', async () => {
  for (const minimumReviews of [0, 1, 2]) {
    const prepared = makeReadyGatePackage({
      reviewPolicy: { minimumReviews, requestedBy: 'dispatch' },
    });
    const issues: ReviewStatus = {
      id: 'review-a',
      source: 'human-gate',
      mode: 'cold',
      loopNumber: 1,
      verdict: 'issues',
      unresolvedCount: 1,
      issues: [{ file: 'icon.service.ts', description: 'Exponential parsing' }],
      reviewerSessionId: 'session-a',
      reviewedHeadSha: prepared.headSha,
      reviewedReviewSubjectHash: prepared.reviewSubjectHash,
      reviewSnapshot: prepared.reviewSnapshot,
      artifactPaths: ['artifacts/review-a/review-result.json'],
      maxRetriesExhausted: true,
    };
    const pass: ReviewStatus = {
      ...issues,
      id: 'review-b',
      reviewerSessionId: 'session-b',
      verdict: 'pass',
      unresolvedCount: 0,
      issues: [],
      artifactPaths: ['artifacts/review-b/review-result.json'],
    };
    const readiness = await collectRunGateReadiness(
      makeRun({ engineState: { publishGate: { reviews: [issues, pass] } } }),
      prepared,
      {
        deterministic: passed,
        acceptance: emptyAcceptance,
        progress: idle,
        selectedEvidence: passed,
        reviewedInputsAwaitingReview: async () => null,
        reviewResult: async (_run, relative) =>
          JSON.stringify({
            schemaVersion: 1,
            verdict: relative.includes('review-a') ? 'issues' : 'pass',
            issues: relative.includes('review-a')
              ? [
                  {
                    file: 'icon.service.ts',
                    severity: 'warning',
                    description: 'Exponential parsing',
                  },
                ]
              : [],
          }),
      },
    );
    assert.ok(readiness.reasons.some((reason) => reason.code === 'review-fix-required'));
    // Only an explicit acceptance publishes the finding (ADR-065 Amendment 8).
    assert.deepEqual(
      gateActionsForReadiness(
        [{ id: 'approve-publish' }, { id: 'approve-publish-unresolved' }, { id: 'hold' }],
        readiness,
      ),
      [{ id: 'approve-publish-unresolved' }, { id: 'hold' }],
    );
    assert.deepEqual(readiness.findings, [
      { reviewId: 'review-a', file: 'icon.service.ts', description: 'Exponential parsing' },
    ]);
  }
});

test('unresolved approval accepts valid head findings, never missing reviews or changed inputs', async () => {
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
      reviews.length
        ? /Review found 1 issue|passing review of the current head/
        : /current-head.*structured.*request/i,
    );
  }
  const exhausted = await collectRunGateReadiness(exhaustedRun, prepared, inputs);
  assert.match(
    exhausted.reasons.find((reason) => reason.prerequisite === 'review')!.message,
    /Review budget 5\/5.*extend-review-budget/,
  );
  // TAT-4006 7721a02b: open findings with every round spent. No fix can run, so the
  // review-fix reason says so and points at Hold instead of "Fix and pass review".
  const fixReason = async (reviewRoundAdmissions: string[]) =>
    (
      await collectRunGateReadiness(
        {
          ...makeRun({ engineState: { publishGate: { reviews: [review] } } }),
          reviewRoundAdmissions,
        },
        prepared,
        inputs,
      )
    ).reasons.find((reason) => reason.code === 'review-fix-required');
  assert.deepEqual(
    await fixReason(['one', 'two', 'three', 'four', 'five']).then((reason) => ({
      message: reason?.message,
      actionId: reason?.actionId,
    })),
    { message: 'Review rounds spent: 1 issue open', actionId: 'hold' },
  );
  // The same gate offers accepting the finding, bound to its digest (ADR-065 Amendment 8).
  const spent = await collectRunGateReadiness(
    {
      ...makeRun({ engineState: { publishGate: { reviews: [review] } } }),
      reviewRoundAdmissions: ['one', 'two', 'three', 'four', 'five'],
    },
    prepared,
    inputs,
  );
  assert.deepEqual(gateActionsForReadiness(actions, spent), actions);
  assert.deepEqual(spent.findings, [
    { reviewId: 'native-current', file: 'src/example.ts', description: 'Remaining finding' },
  ]);
  assert.match(spent.findingsDigest ?? '', /^sha256:[0-9a-f]{64}$/);
  // A fix in progress, or an invalid result at the head, withholds it.
  const fixing = await collectRunGateReadiness(
    makeRun({ status: 'fixing', engineState: { publishGate: { reviews: [review] } } }),
    prepared,
    inputs,
  );
  assert.deepEqual(gateActionsForReadiness(actions, fixing), actions.slice(1));
  assert.equal(fixing.findings, undefined);
  assert.deepEqual(
    await fixReason([]).then((reason) => ({
      message: reason?.message,
      actionId: reason?.actionId,
    })),
    {
      message: 'Review found 1 issue. Fix and pass review before publishing.',
      actionId: 'continue-review-fix',
    },
  );
  assert.deepEqual(gateActionsForReadiness(actions, exhausted), actions.slice(1));
  // A published run cannot be extended, so its gate says so instead of naming the command.
  const published = await collectRunGateReadiness(
    { ...exhaustedRun, engineState: { publishGate: { publicationStatus: 'published_ready' } } },
    prepared,
    inputs,
  );
  const publishedMessage = published.reasons.find(
    (reason) => reason.prerequisite === 'review',
  )!.message;
  assert.match(
    publishedMessage,
    /this run is already published; only the unpublished dev or fix-bug/,
  );
  assert.doesNotMatch(publishedMessage, /extend-review-budget/);
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

test('accepting findings takes every finding the block counts at the head, each from its own valid result', async () => {
  const { publicationGateDecisionActions } = await import('./gate-policy.js');
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
  const atHead = {
    reviewedHeadSha: prepared.headSha,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    reviewSnapshot: prepared.reviewSnapshot,
  };
  const f1 = { file: 'src/a.ts', line: 3, description: 'Owner decision' };
  const f2 = { file: 'src/b.ts', description: 'Second finding' };
  const results: Record<string, unknown> = {
    'artifacts/r1/loop-1/review-result.json': {
      schemaVersion: 1,
      verdict: 'issues',
      issues: [f1, f2],
    },
    'artifacts/r1/loop-2/review-result.json': { schemaVersion: 1, verdict: 'issues', issues: [f1] },
    'artifacts/r2/review-result.json': { schemaVersion: 1, verdict: 'pass', issues: [] },
  };
  const attempt = (loopNumber: number, issues: (typeof f1 | typeof f2)[]) => ({
    mode: 'cold' as const,
    loopNumber,
    verdict: 'issues' as const,
    unresolvedCount: issues.length,
    issues,
    reviewSnapshot: prepared.reviewSnapshot,
    artifactPaths: [`artifacts/r1/loop-${loopNumber}/review-result.json`],
  });
  // A re-review on unchanged code narrowed F1+F2 to F1; the block still counts both.
  const narrowed: ReviewStatus = {
    id: 'r1',
    source: 'pipeline',
    mode: 'cold',
    loopNumber: 2,
    reviewerSessionId: 'session-1',
    ...atHead,
    verdict: 'issues',
    unresolvedCount: 1,
    issues: [f1],
    attempts: [attempt(1, [f1, f2]), attempt(2, [f1])],
    artifactPaths: ['artifacts/r1/loop-2/review-result.json'],
  };
  const pass: ReviewStatus = {
    id: 'r2',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    reviewerSessionId: 'session-2',
    ...atHead,
    verdict: 'pass',
    unresolvedCount: 0,
    artifactPaths: ['artifacts/r2/review-result.json'],
  };
  const inputs = {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
    reviewedInputsAwaitingReview: async () => null,
    reviewResult: async (_run: unknown, relative: string) =>
      results[relative] ? JSON.stringify(results[relative]) : undefined,
  };
  const readiness = (reviews: ReviewStatus[]) =>
    collectRunGateReadiness(
      makeRun({ engineState: { publishGate: { reviews } } }),
      prepared,
      inputs,
    );
  const offered = await readiness([narrowed]);
  assert.deepEqual(offered.findings, [
    { reviewId: 'r1', ...f1 },
    { reviewId: 'r1', ...f2 },
  ]);
  // Another reviewer passing the unchanged head keeps the finding open, and Accept defined.
  const definitions = publicationGateDecisionActions({
    reviewSatisfied: true,
    preparedPackage: prepared,
    reviews: [narrowed, pass],
  });
  const withPass = await readiness([narrowed, pass]);
  assert.deepEqual(
    gateActionsForReadiness(definitions, withPass)
      .map((action) => action.id)
      .filter((id) => id.startsWith('approve-publish')),
    ['approve-publish-unresolved'],
  );
  // A worker that blocked after the first review leaves the row failed; its finding stays acceptable.
  const blocked = { ...narrowed, verdict: 'failed' as const, attempts: [attempt(1, [f1, f2])] };
  assert.equal((await readiness([blocked, pass])).findings?.length, 2);
  // A review of another subject, a counted entry without its own valid result, or a review
  // still running, withholds it.
  assert.equal(
    (await readiness([{ ...narrowed, reviewedReviewSubjectHash: 'other-subject' }])).findings,
    undefined,
  );
  delete results['artifacts/r1/loop-1/review-result.json'];
  assert.equal((await readiness([narrowed])).findings, undefined);
  results['artifacts/r1/loop-1/review-result.json'] = {
    schemaVersion: 1,
    verdict: 'issues',
    issues: [f1, f2],
  };
  const pending: ReviewStatus = {
    ...pass,
    id: 'r3',
    reviewerSessionId: 'session-3',
    verdict: 'pending',
  };
  assert.equal((await readiness([narrowed, pending])).findings, undefined);
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

test('a review claim is satisfied only by the gate review prerequisite at the package head', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-review-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { claims } = await writeReviewClaimPackage(root);
  const input = (await readRecordedEvidencePackage(root)).input;
  const owner = validateRecordedEvidencePackage(input);
  assert.equal(owner.status, 'valid', JSON.stringify(owner.findings));

  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
  });
  const pass = certifyingReview(prepared);
  const sources = {
    deterministic: passed,
    progress: idle,
    selectedEvidence: passed,
    acceptance: async () => ({
      criteria: claims.criteria.map(({ id, text }) => ({ id, text })),
      ledger: claims,
      issues: [],
    }),
    recordedEvidence: async () => [input],
    reviewResult: async () => PASSING_REVIEW_RESULT,
  };
  const gate = (reviews: ReviewStatus[], overrides = {}) =>
    collectRunGateAssessment(makeRun({ engineState: { publishGate: { reviews } } }), prepared, {
      ...sources,
      ...overrides,
    });
  const claimVerdictBlocked = (readiness: { reasons: { evidencePolicy?: string }[] }) =>
    readiness.reasons.some((reason) => reason.evidencePolicy === 'claim-verdict');

  const clean = await gate([pass]);
  assert.equal(clean.readiness.state, 'ready', JSON.stringify(clean.readiness.reasons));
  // The projection carries the satisfied claim; the engine verdict stays visible.
  const projected = clean.acceptance?.criteria.find(({ id }) => id === 'AC-2');
  assert.equal(projected?.verdict, 'proven');
  assert.equal(projected?.engineVerdict, 'awaiting-review');
  assert.equal(clean.acceptance?.criteria[0]?.engineVerdict, undefined);

  assert.ok(claimVerdictBlocked((await gate([])).readiness), 'before any review');
  assert.ok(
    claimVerdictBlocked(
      (await gate([{ ...pass, reviewedHeadSha: 'other-head', reviewSnapshot: undefined }]))
        .readiness,
    ),
    'a pass at a different head',
  );
  assert.ok(
    claimVerdictBlocked((await gate([pass], { reviewResult: async () => undefined })).readiness),
    'a pass without a valid structured result',
  );
  assert.ok(
    claimVerdictBlocked((await gate([pass, openFindingAtHead(prepared)])).readiness),
    'an open finding at the head',
  );
});

// TAT-4145 bda11b1a gate 5bc9ef11 read ready with no reasons; publication then refused the
// package for secret values. The gate runs the same scan, so approval is never offered.
test('a package publication would refuse for secret values is not ready for approval', async () => {
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  const inputs = {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
    reviewResult: async () => undefined,
  };
  const run = makeRun();
  assert.equal((await collectRunGateReadiness(run, prepared, inputs)).state, 'ready');

  const phrase = Array<string>(12).fill('abandon').join(' ');
  const refused = await collectRunGateReadiness(
    run,
    { ...prepared, draftBody: `${prepared.draftBody}\n\n${phrase}` },
    inputs,
  );
  assert.equal(refused.state, 'not-ready');
  const reason = refused.reasons.find(({ code }) => code === 'publication-secret-values');
  assert.equal(reason?.prerequisite, 'evidence');
  assert.match(reason?.message ?? '', /Publication blocked by secret values: srp sha256:/);
  assert.doesNotMatch(reason?.message ?? '', /abandon/, 'fingerprints only, never the value');
});

test('an unreadable secret scan fails closed, a verdict holds for its content, and attestation waives neither', async () => {
  const prepared = makeReadyGatePackage({
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  const inputs = {
    deterministic: passed,
    acceptance: emptyAcceptance,
    progress: idle,
    selectedEvidence: passed,
    reviewResult: async () => undefined,
  };
  const unreadable = await collectRunGateReadiness(makeRun(), prepared, {
    ...inputs,
    publicationSecrets: async () => {
      throw new Error('Retained artifact is missing, pruned or changed: artifacts/x/recipe.json');
    },
  });
  const unscanned = unreadable.reasons.find(({ message }) =>
    message.startsWith('The publication secret scan could not read the frozen evidence'),
  );
  assert.equal(unscanned?.code, 'evidence-validation-unavailable');
  assert.equal(unreadable.state, 'not-ready');

  const secret = { ...prepared, draftBody: Array<string>(12).fill('abandon').join(' ') };
  const refused = await collectRunGateReadiness(makeRun(), secret, inputs);
  const reason = refused.reasons.find(({ code }) => code === 'publication-secret-values');
  assert.ok(reason);
  assert.equal(isEvidencePolicyReason(reason), false, 'attestation cannot waive it');
  for (const found of refused.reasons) assert.equal(isEvidencePolicyReason(found), false);

  // A verdict is kept for the package's content: the same content keeps it, other content
  // gets its own scan.
  const again = await collectRunGateReadiness(makeRun(), secret, inputs);
  assert.ok(again.reasons.some(({ code }) => code === 'publication-secret-values'));
  const clean = await collectRunGateReadiness(makeRun(), prepared, inputs);
  assert.ok(!clean.reasons.some(({ code }) => code === 'publication-secret-values'));
});
