import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import type { AcceptanceRegistration, RecipeVisualReviewer } from '@farmslot/protocol';

const home = await mkdtemp(path.join(os.tmpdir(), 'completion-proof-home-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(home, 'status.json'),
});
await mkdir(path.join(home, 'pool'));
await mkdir(path.join(home, 'projects/generic-project/tasks'), { recursive: true });
await writeFile(
  path.join(home, 'projects/generic-project/project.json'),
  JSON.stringify({ name: 'generic-project', task_dir: 'tasks', hooks: {} }),
);
await writeFile(
  path.join(home, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'generic-project',
    platform: 'cli',
    slots: [
      {
        id: 'completion-proof-slot',
        repo: path.join(home, 'projects/generic-project'),
        session: 'completion-proof-slot',
      },
    ],
  }),
);
after(() => rm(home, { recursive: true, force: true }));

await import('../runtime/mock-pty.test-support.js');
mock.module('../runners/run-progress.js', {
  namedExports: {
    readRunProgress: async () => ({ kind: 'idle' }),
    readAgentContextProgress: async () => ({ kind: 'idle' }),
    runDecisionWaitingStatus: () => {
      throw new Error('Unexpected decision posture probe');
    },
  },
});
const coverage = await import('../review/acceptance-coverage.js');
const head = 'a'.repeat(40);
let readHead = async () => head;
mock.module('../review/acceptance-coverage.js', {
  namedExports: { ...coverage, readPRCompletionHead: () => readHead() },
});
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { acknowledgeRunOutput, captureRunOutput, outputOverrideSnapshot, outputReviewDecisions } =
  await import('./output.js');
const { assertPRCompletionIdentity } = await import('./pr-completion-proof.js');
const { closeRunOutput } = await import('./output-close.js');
const { collectRunGateReadiness } = await import('../run-engine/gate-prerequisites.js');
const { runReviewVisualClaim } = await import('../methods/run/claim-reviews.js');
const { visualReviewSnapshotIdentity } = await import('../run-engine/recorded-evidence-sources.js');
const { writeAcceptanceVisualPackage } =
  await import('../run-engine/acceptance-package.test-support.js');

async function fixture(t: TestContext, captureHead?: string) {
  readHead = async () => head;
  const root = await mkdtemp(path.join(home, 'projects/generic-project/tasks/completion-proof-'));
  const directory = path.join(root, 'artifacts/recipe-runs/qa-attempt');
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, 'inputs'));
  const { claims } = await writeAcceptanceVisualPackage(directory, captureHead);
  await writeFile(
    path.join(directory, 'evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'Protocol fixture', file: 'stills/1.png' }],
    }),
  );
  await writeFile(
    path.join(root, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/qa-attempt' }),
  );
  await writeFile(path.join(root, 'artifacts/acceptance-status.json'), JSON.stringify(claims));
  await writeFile(path.join(root, 'artifacts/report.md'), '# Completion protocol fixture\n');
  await writeFile(path.join(root, 'TASK.md'), '# Task\n');
  await writeFile(path.join(root, 'CHECKLIST.md'), '# Task\n- [x] **1. Done**\n');
  const run = createRun({
    flowType: 'pr-complete',
    project: 'generic-project',
    ticketOrPr: 'example/repo#1',
    mode: 'autonomous',
    transport: 'tmux',
    slotId: 'completion-proof-slot',
  });
  await writeFile(
    path.join(home, 'status.json'),
    JSON.stringify({
      slots: [
        { slot: run.slotId, current_run_id: run.id, lifecycle: 'held', phase: 'operator-wait' },
      ],
    }),
  );
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', slotId: null, agentContexts: [] });
      await deleteRun(run.id);
    }
    await rm(root, { recursive: true, force: true });
  });
  const registration: AcceptanceRegistration = {
    schemaVersion: 1,
    runId: run.id,
    revision: 2,
    intake: {
      provider: 'github',
      repository: 'example/repo',
      prNumber: 1,
      headSha: head,
      capturedAt: '2026-10-25T00:00:00Z',
    },
    original: [{ id: 'AC-1', text: claims.criteria[0].text }],
    derived: [
      {
        id: 'AC-2',
        text: claims.criteria[1].text,
        proofMode: 'visual',
        source: {
          kind: 'review-comment',
          sourceId: 'comment:1',
          sourceVersion: 'v1',
          obligationIndex: 0,
        },
      },
    ],
    units: [
      {
        id: 'derive-acceptance',
        sources: [
          { id: 'comment:1', kind: 'review-comment', body: claims.criteria[1].text, version: 'v1' },
        ],
        result: {
          schemaVersion: 1,
          runId: run.id,
          generation: 0,
          registrationRevision: 1,
          unitId: 'derive-acceptance',
          classifications: [
            {
              sourceId: 'comment:1',
              sourceVersion: 'v1',
              obligations: [{ text: claims.criteria[1].text, proofMode: 'visual' }],
            },
          ],
        },
      },
    ],
  };
  const base = JSON.stringify({
    schemaVersion: 1,
    flowType: 'pr-complete',
    mode: run.mode,
    recordedEvidenceContractVersion: run.recordedEvidenceContractVersion,
    acceptanceContractVersion: 1,
    claimReviewSupported: true,
    acceptance: { require: true },
    commands: {
      complete: { artifacts: [] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
  });
  await writeFile(path.join(root, 'inputs/worker-terminal-contract.json'), base);
  await writeFile(
    path.join(root, 'inputs/handoff.json'),
    JSON.stringify({
      attemptId: run.id,
      project: run.project,
      flow: run.flowType,
      task: { acceptanceCriteria: [claims.criteria[0].text] },
    }),
  );
  await writeFile(
    path.join(root, 'inputs/acceptance-registration.json'),
    JSON.stringify({ schemaVersion: 1, generation: 0, registration }),
  );
  updateRun(run.id, {
    status: 'paused',
    taskFile: path.join(root, 'TASK.md'),
    lane: 'production',
    acceptanceRegistration: registration,
    ticketData: {
      source: 'manual',
      title: 'Proof',
      description: 'Proof',
      acceptanceCriteria: [claims.criteria[0].text],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    acceptanceExecutionContract: {
      schemaVersion: 1,
      runId: run.id,
      revision: 1,
      registrationRevision: 2,
      baseContractHash: createHash('sha256').update(base).digest('hex'),
      inheritedCriterionIds: [],
      proofModes: claims.criteria.map(({ id, text, proofMode }) => ({ id, text, proofMode })),
      claimReviewGate: true,
      publicationReview: false,
    },
    acceptanceProofHold: {
      state: 'held',
      registrationRevision: 2,
      contractRevision: 1,
      headSha: head,
    },
    metrics: { ...run.metrics, outcome: 'partial' },
    steps: [{ name: 'complete', status: 'pending' }],
  });
  await captureRunOutput(run.id, false, true);
  const current = getRun(run.id)!;
  const decision = current.decisions.find(({ payload }) => payload?.kind === 'output-review')!;
  assert.ok(decision);
  updateRun(run.id, {
    acceptanceProofHold: { ...current.acceptanceProofHold!, decisionId: decision.id },
  });
  const sources = {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
    prCompletionHead: async () => head,
  };
  const readiness = (overrides = {}) =>
    collectRunGateReadiness(
      getRun(run.id)!,
      null,
      { ...sources, ...overrides },
      'completion-proof',
    );
  const reviewer: RecipeVisualReviewer = {
    principalId: 'person',
    credentialId: 'test',
    displayName: 'Fixture reviewer',
    subjectKind: 'person',
  };
  const review = (verdict: 'confirmed' | 'rejected') =>
    runReviewVisualClaim(
      {
        runId: run.id,
        decisionId: decision.id,
        claimId: 'AC-2',
        recipeRunId: claims.recipeRunId,
        snapshotIdentity: visualReviewSnapshotIdentity(getRun(run.id)!, decision.id),
        verdict,
        reason: 'Protocol fixture judgment only.',
      },
      () => {},
      {
        authorizeVisualClaimReview: () => reviewer,
        refreshPackage: async () => ({ run: getRun(run.id)! }),
      },
    );
  return { run, root, directory, decision, readiness, review };
}

test('captured derived visual proof blocks until qualified and rejection keeps the completion held', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.readiness()).state, 'not-ready');
  const original = await readFile(path.join(f.directory, 'acceptance-status.json'), 'utf8');
  await f.review('confirmed');
  const ready = await f.readiness();
  assert.equal(ready.state, 'ready', JSON.stringify(ready.reasons));
  assert.equal(getRun(f.run.id)!.status, 'paused');
  assert.equal(await readFile(path.join(f.directory, 'acceptance-status.json'), 'utf8'), original);
  await f.review('rejected');
  assert.equal((await f.readiness()).state, 'not-ready');
  assert.equal(
    getRun(f.run.id)!.decisions.find(({ id }) => id === f.decision.id)?.resolvedAt,
    undefined,
  );
});

test('closing a proof hold records partial completion without a provenance mutation', async (t) => {
  const f = await fixture(t);
  let publications = 0;
  const closed = await closeRunOutput(f.run.id, f.decision.id, {
    publish: async (run) => {
      publications++;
      return run;
    },
    releaseSlot: async () => ({ released: true }),
    slotOwner: async () => null,
  });
  assert.equal(closed.status, 'done');
  assert.equal(closed.metrics.outcome, 'partial');
  assert.ok(closed.output?.closedAt);
  assert.equal(
    publications,
    1,
    'only the run-status publisher is called; no completion pipeline or PR comment',
  );
});

test('an acceptance revision change during the final await invalidates readiness', async (t) => {
  const f = await fixture(t);
  await f.review('confirmed');
  const stale = await f.readiness({
    progress: async () => {
      const current = getRun(f.run.id)!;
      updateRun(f.run.id, {
        acceptanceRegistration: { ...current.acceptanceRegistration!, revision: 3 },
      });
      return { kind: 'idle' as const };
    },
  });
  assert.ok(stale.reasons.some(({ code }) => code === 'run-gate-superseded'));
  const decisions = outputReviewDecisions(
    {
      ...getRun(f.run.id)!,
      acceptanceProofHold: {
        ...getRun(f.run.id)!.acceptanceProofHold!,
        registrationRevision: 3,
      },
    },
    getRun(f.run.id)!.output!,
  );
  assert.ok(
    decisions.some(
      ({ payload, resolvedAt }) =>
        !resolvedAt &&
        payload?.kind === 'output-review' &&
        payload.completionProof?.registrationRevision === 3,
    ),
  );
});

test('mark-reviewed uses supported COMPLETE replay exactly once and preserves captured proof', async (t) => {
  const f = await fixture(t);
  let snapshot = outputOverrideSnapshot(f.run.id, f.decision.id);
  await assert.rejects(acknowledgeRunOutput(f.run.id, f.decision.id, snapshot), /claim verdicts/i);
  assert.equal(getRun(f.run.id)!.acceptanceProofHold?.state, 'held');
  await f.review('confirmed');
  snapshot = outputOverrideSnapshot(f.run.id, f.decision.id);
  const resumed = await acknowledgeRunOutput(f.run.id, f.decision.id, snapshot);
  assert.equal(resumed.status, 'completing');
  assert.equal(resumed.acceptanceProofHold?.state, 'reviewed');
  assert.equal(resumed.acceptanceProofHold?.resumedGeneration, resumed.engineState?.generation);
  assert.equal(resumed.steps.find(({ name }) => name === 'complete')?.status, 'pending');
  const generation = resumed.engineState?.generation;
  const bundle = resumed.output?.artifactBundle;
  await acknowledgeRunOutput(f.run.id, f.decision.id, snapshot);
  assert.equal(getRun(f.run.id)!.engineState?.generation, generation);
  assert.deepEqual(getRun(f.run.id)!.output?.artifactBundle, bundle);
});

test('a persisted reviewed hold can recover the acknowledgement-to-replay crash gap', async (t) => {
  const f = await fixture(t);
  await f.review('confirmed');
  const current = getRun(f.run.id)!;
  updateRun(f.run.id, {
    acceptanceProofHold: { ...current.acceptanceProofHold!, state: 'reviewed' },
    decisions: current.decisions.map((entry) =>
      entry.id === f.decision.id
        ? { ...entry, resolvedAction: 'mark-reviewed', resolvedAt: new Date().toISOString() }
        : entry,
    ),
  });
  const resumed = await acknowledgeRunOutput(
    f.run.id,
    f.decision.id,
    outputOverrideSnapshot(f.run.id, f.decision.id),
  );
  assert.equal(resumed.status, 'completing');
  assert.equal(resumed.acceptanceProofHold?.resumedGeneration, resumed.engineState?.generation);
});

for (const change of ['head', 'revision', 'pause', 'cancel'] as const) {
  test(`${change} changing during a head read prevents the next PR mutation`, async (t) => {
    const f = await fixture(t);
    updateRun(f.run.id, { status: 'completing' });
    const current = getRun(f.run.id)!;
    const identity = {
      generation: current.engineState?.generation ?? 0,
      ...current.acceptanceProofHold!,
    };
    readHead = async () => {
      if (change === 'head') return 'b'.repeat(40);
      if (change === 'revision')
        updateRun(f.run.id, {
          acceptanceRegistration: { ...current.acceptanceRegistration!, revision: 3 },
        });
      else updateRun(f.run.id, { status: change === 'pause' ? 'paused' : 'cancelled' });
      return head;
    };
    await assert.rejects(
      assertPRCompletionIdentity(f.run.id, identity),
      /acceptance or pushed head changed/,
    );
  });
}

test('fresh after-captures from an earlier head cannot qualify a new completion hold', async (t) => {
  const f = await fixture(t, head);
  await f.review('confirmed');
  assert.equal((await f.readiness()).state, 'ready');
  const nextHead = 'b'.repeat(40);
  const current = getRun(f.run.id)!;
  updateRun(f.run.id, {
    acceptanceProofHold: {
      ...current.acceptanceProofHold!,
      headSha: nextHead,
      state: 'held',
      decisionId: undefined,
    },
  });
  await captureRunOutput(f.run.id, false, true);
  const latest = getRun(f.run.id)!;
  const decision = latest.decisions.find(
    ({ resolvedAt, payload }) =>
      !resolvedAt &&
      payload?.kind === 'output-review' &&
      payload.completionProof?.headSha === nextHead,
  )!;
  updateRun(f.run.id, {
    acceptanceProofHold: { ...latest.acceptanceProofHold!, decisionId: decision.id },
  });
  const blocked = await f.readiness({ prCompletionHead: async () => nextHead });
  assert.equal(blocked.state, 'not-ready');
  assert.ok(
    blocked.reasons.some(({ message }) => message.includes('comparison-source-mismatch')),
    JSON.stringify(blocked),
  );
});
