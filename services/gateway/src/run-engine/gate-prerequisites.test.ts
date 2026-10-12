import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

await import('../runtime/mock-pty.test-support.js');
const { collectRunGateReadiness, gateActionsForReadiness, refreshRunGateReadiness } =
  await import('./gate-prerequisites.js');
const { makeRun, makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('./test-fixtures.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { computeReadyGatePackageHash } = await import('../run-completion/ready-gate-package.js');

const idle = async () => ({ kind: 'idle' as const });
const emptyAcceptance = async () => ({ criteria: [], ledger: null, issues: [] });
const passed = async () => {};

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
  const unavailable = await collectRunGateReadiness(makeRun(), null, {
    ...sources,
    recordedEvidence: async () => {
      throw new Error('Frozen artifact is unreadable');
    },
  });
  assert.ok(
    unavailable.reasons.some((reason) => reason.code === 'evidence-validation-unavailable'),
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
  const run = makeRun({ taskFile: path.join(root, 'TASK.md') });
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
  await writeFile(path.join(root, prepared.artifactPath), JSON.stringify(prepared));
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
  assert.ok(foreign.reasons.some((reason) => reason.code === 'evidence-invalid'));
  await writeFile(
    path.join(directory, 'recipe-invocation.json'),
    JSON.stringify({ ...invocation, params: { substituted: true } }),
  );
  assert.ok(
    (await check()).reasons.some((reason) => reason.message.includes('missing or changed')),
  );
  await writeFile(path.join(directory, 'recipe-invocation.json'), '{');
  const unreadable = await check();
  assert.ok(unreadable.reasons.some((reason) => reason.code === 'evidence-validation-unavailable'));
  assert.ok(unreadable.reasons.some((reason) => reason.message.includes('recipe-invocation.json')));
  const unavailable = await collectRunGateReadiness(run, null, sources);
  assert.ok(
    unavailable.reasons.some((reason) => reason.message.includes('prepared evidence package')),
  );
});
