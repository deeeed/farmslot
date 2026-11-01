import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRunResolveDecisionParams,
  createReviewCuration,
  DEFAULT_CURSOR_MODEL,
  pipelineReviewOffReason,
  pipelineReviewPolicyError,
  PUBLISH_APPROVAL_ACTIONS,
  type ReadyGatePrPackage,
  recipeRepairId,
  type RecipeRepairScope,
  type ReviewGatePayload,
  type Run,
  type RunCreateParams,
  type RunDecision,
  SEND_BACK_TO_AGENT_ACTION,
} from '@farmslot/protocol';

import { digest } from '../assessment/failure-triage/packet.js';
import { beginAssessment, finishAssessment, reserveAssessment } from '../assessment/store.js';
import { invalidateProjectVarsCache, projectsDir } from '../core/config.js';
import { GatewayMethodError } from '../core/method-error.js';
import { farmslotRoot } from '../fleet/state.js';
import { admitReviewRound } from '../review/review-round-budget.js';
import { computeReadyGatePackageHash } from '../run-completion/ready-gate-package.js';
import { jiraTicketData, manualTicketData } from '../run-completion/test-fixtures.js';
import { createEngineDecision } from '../run-engine/engine-decisions.js';
import { CONTINUE_REVIEW_FIX_ACTION } from '../run-engine/gate-policy.js';
import { overwriteRetainedFixture, retainRunFixture } from '../run-engine/test-fixtures.js';
import type { VisualRepairAdmission } from '../run-engine/visual-repair.js';
import type { RunProgressObservation } from '../runners/run-progress.js';
import {
  createRun,
  deleteRun,
  getAllRuns,
  getRun,
  isTaskDirectoryAdmitting,
  updateRun,
} from '../runs/store.js';
import { runWithSessionOriginator } from '../security/work-originator.js';
import { captureRunCreationRequest } from '../sources/creation-request.js';

import { makeRun } from './run/test-fixtures.js';
import {
  assertDecisionStillUnresolved,
  assertDuplicateRunAllowed,
  assertExpectedExecutionTemplate,
  planRunCreation,
  resolveCreateSafetyTier,
  runCreate,
  runInteractiveDevResolve,
  runProbeWorkerSignal,
  runRehydratePrNumber,
  runResolveDecision,
} from './run.js';

/** What accepting review findings sends besides the package binding (ADR-065 Amendment 8). */
const ACCEPTANCE = { reason: 'The owner accepts the finding.', findingsDigest: 'sha256:shown' };
const acceptor = {
  id: 'acceptor',
  subject: { type: 'person' as const, displayName: 'Acceptor' },
  roles: [],
};
const acceptorAuthority = {
  authorizeEvidenceAttestation: () => ({
    principalId: 'acceptor',
    displayName: 'Acceptor',
    personSessionId: 'acceptor-session',
  }),
};

for (const reason of ['no_suitable_slot', 'branch_affinity_nudge']) {
  test(`an out-of-filter ${reason} pick leaves the same decision open for a valid pick`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = createRun({
      flowType: 'dev',
      mode: 'interactive',
      project: 'slot-choice',
      ticketOrPr: 'MANUAL-SLOT-CHOICE',
      transport: 'tmux',
      allowedSlots: ['allowed-slot'],
    });
    t.after(async () => {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    });
    const waiting = createEngineDecision(
      run.id,
      reason,
      'Choose a slot',
      [
        { id: 'pick', label: 'Pick', style: 'primary' },
        { id: 'abort', label: 'Abort', style: 'danger' },
      ],
      undefined,
      { readProgress: async () => ({ kind: 'idle' }) },
    );
    await Promise.resolve();
    const decision = getRun(run.id)!.decisions.at(-1)!;
    await assert.rejects(
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'pick',
          selectionData: { slotId: 'outside-slot' },
        },
        () => {},
      ),
      /not in the allowed slot list; pick a slot again/,
    );
    assert.equal(decision.resolvedAt, undefined);
    assert.equal(decision.selectionData, undefined);
    assert.equal(getRun(run.id)!.status, 'blocked');
    await runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'pick',
        selectionData: { slotId: 'allowed-slot' },
      },
      () => {},
    );
    assert.equal(await waiting, 'pick');
    assert.equal(getRun(run.id)!.decisions.length, 1);
    assert.equal(getRun(run.id)!.decisions[0]?.selectionData?.slotId, 'allowed-slot');
  });
}

test('a human-gate WARM request refuses a lost retained session before consuming the gate', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'review-warm-refusal',
    ticketOrPr: 'MANUAL-WARM-REFUSAL',
    runner: 'codex',
    transport: 'tmux',
  });
  const decision: RunDecision = {
    id: 'warm-refusal',
    type: 'engine_human_gate',
    title: 'Review',
    description: '',
    actions: [{ id: 'request-review', label: 'Review', style: 'primary' }],
    createdAt: new Date().toISOString(),
  };
  const reviewId = 'pipeline-review-retained';
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [decision],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: reviewId,
            source: 'pipeline',
            runner: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'high',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            reviewerSessionId: 'lost-session',
            reviewedHeadSha: 'a'.repeat(40),
            completedAt: new Date().toISOString(),
          },
        ],
      },
    },
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  const effects: string[] = [];
  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'request-review',
        selectionData: {
          reviewRequest: {
            runner: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'high',
            mode: 'warm',
            context: { reviewLineages: [{ familyId: run.familyId, reviewId }] },
          },
        },
      },
      () => effects.push('broadcast'),
      {
        assertReviewLaunchAllowed: async () => {
          effects.push('launch');
          throw new Error('unexpected launch');
        },
      },
    ),
    /WARM review refused.*no verified retained session/,
  );
  assert.deepEqual(effects, []);
  assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
  assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length ?? 0, 0);
});
test('run creation holds its task directory against retention until it registers or refuses', async (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-admission-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  writeFileSync(path.join(taskDir, 'TASK.md'), 'task', 'utf-8');
  const tatKey = `TAT-${Date.now()}`;
  let heldAtRegistration = false;
  await assert.rejects(
    runCreate(
      {
        flowType: 'dev',
        project: 'farmslot-farm',
        ticketOrPr: tatKey,
        ticketData: jiraTicketData(tatKey),
        taskFile: path.join(taskDir, 'TASK.md'),
      },
      () => {},
      {
        beforeCreate: () => {
          heldAtRegistration = isTaskDirectoryAdmitting(taskDir);
          throw new Error('refused at registration');
        },
      },
    ),
    /refused at registration/,
  );
  assert.equal(heldAtRegistration, true);
  assert.equal(isTaskDirectoryAdmitting(taskDir), false, 'a refused admission releases it');
});

test('run.create refuses a pipeline review it could not turn off as asked', async () => {
  const before = getAllRuns().length;
  const base: RunCreateParams = {
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `TAT-${Date.now()}`,
    completionPolicy: 'artifact-only',
    pipelineReview: 'none',
  };
  const refusals: Array<[RunCreateParams, RegExp]> = [
    [
      { ...base, completionPolicy: undefined },
      /pipelineReview none is only for artifact-only runs: set completionPolicy artifact-only/,
    ],
    [
      { ...base, reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'cold' }] },
      /turns the review off; drop reviewSequence and reviewPolicy/,
    ],
    [
      {
        ...base,
        engineState: {
          evalExperiment: {
            experimentId: 'experiment',
            experimentKey: 'key',
            experimentManifestPath: 'manifest.json',
            packagePath: 'package',
            candidateStrategyFingerprint: 'fingerprint',
            trialId: 'trial',
          },
        },
      },
      /would skip the eval judge/,
    ],
  ];
  for (const [params, refusal] of refusals)
    await assert.rejects(
      runCreate(params, () => {}),
      refusal,
    );
  await assert.rejects(
    // @ts-expect-error pipelineReview accepts only 'default' or 'none'; a raw RPC can send more.
    runCreate({ ...base, pipelineReview: 'off' }, () => {}),
    /pipelineReview must be 'default' or 'none', not "off"/,
  );
  assert.equal(getAllRuns().length, before, 'nothing is created');
  // update-branch pushes to an existing PR whatever its completion policy. run.create checks a PR
  // reference first, so the shared rule is asserted directly (dispatch.preview covers it end to end).
  assert.match(
    pipelineReviewPolicyError({ ...base, flowType: 'update-branch' }) ?? '',
    /only for dev and fix-bug runs; a update-branch run pushes or publishes/,
  );
});

test('run.create keeps an artifact-only pipeline review off and retains the request', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  let runId = '';
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    if (runId && getRun(runId)) {
      updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(runId);
    }
  });
  const tatKey = `TAT-${Date.now()}`;
  const params: RunCreateParams = {
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: tatKey,
    ticketData: jiraTicketData(tatKey),
    completionPolicy: 'artifact-only',
    pipelineReview: 'none',
  };
  const { run } = await runCreate(params, () => {});
  runId = run.id;
  assert.equal(getRun(run.id)?.pipelineReview, 'none');
  assert.equal(
    pipelineReviewOffReason(getRun(run.id)!),
    'Pipeline review is off for this artifact-only run (pipelineReview none).',
  );
  // Queued revalidation and replays re-read the retained request.
  assert.equal(captureRunCreationRequest(params).pipelineReview, 'none');
});

test('planning resolves the same dispatch defaults without creating a run or consuming a queue claim', async () => {
  const before = getAllRuns().map((run) => run.id);
  let claimed = true;
  let synchronousChecks = 0;
  const tatKey = `TAT-${Date.now()}`;
  const params = {
    flowType: 'dev' as const,
    project: 'farmslot-farm',
    ticketOrPr: tatKey,
    ticketData: jiraTicketData(tatKey),
  };
  const plan = await planRunCreation(params, {
    beforeCreate: () => {
      synchronousChecks++;
    },
  });
  assert.equal(plan.params.mode, 'autonomous');
  assert.equal(synchronousChecks, 0);
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    before,
  );
  const emitted: unknown[] = [];
  await assert.rejects(
    runCreate(params, (_event, data) => emitted.push(data), {
      beforeCreateAsync: async () => {
        queueMicrotask(() => {
          claimed = false;
        });
      },
      beforeCreate: () => {
        synchronousChecks++;
        if (!claimed) throw new Error('queue claim changed');
      },
    }),
    /queue claim changed/,
  );
  assert.equal(synchronousChecks, 1);
  assert.deepEqual(emitted, []);
  assert.deepEqual(
    getAllRuns().map((run) => run.id),
    before,
  );
});

test('assertExpectedExecutionTemplate rejects a changed queued snapshot', () => {
  const expected = {
    id: 'fix-bug/autonomous.mobile',
    sourceId: 'package:canonical',
    flow: 'fix-bug',
    runMode: 'autonomous' as const,
    platforms: ['mobile', 'ios', 'android'],
    labels: [],
    relativePath: 'fix-bug/autonomous.mobile.md',
    sha256: 'expected-sha',
  };
  assert.doesNotThrow(() => assertExpectedExecutionTemplate(expected, expected));
  assert.throws(
    () => assertExpectedExecutionTemplate({ ...expected, sha256: 'changed-sha' }, expected),
    /changed while queued/,
  );
  assert.throws(
    () => assertExpectedExecutionTemplate(undefined, expected),
    /no configured execution template/,
  );
});

test('a sixth gate review is refused before decision consumption, restore or launch checks', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'review-round-budget',
    ticketOrPr: 'MANUAL-REVIEW-ROUND-LIMIT',
    runner: 'scripted',
    transport: 'tmux',
  });
  const decision: RunDecision = {
    id: 'sixth-review',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Review budget spent',
    actions: [{ id: 'request-review', label: 'Review', style: 'secondary' }],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [decision],
    reviewRoundAdmissions: ['one', 'two', 'three', 'four', 'five'],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  const effects: string[] = [];
  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'request-review',
        selectionData: {
          reviewRequest: { runner: 'codex', model: null, effort: null, mode: 'cold' },
        },
      },
      () => effects.push('broadcast'),
      {
        restoreGatePark: async () => {
          throw new Error('restore must not run');
        },
        assertReviewLaunchAllowed: async () => {
          effects.push('launch');
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof GatewayMethodError);
      assert.equal(error.code, 'REVIEW_ROUND_LIMIT_REACHED');
      assert.match(error.message, /design problem or scope creep/);
      return true;
    },
  );
  assert.deepEqual(effects, []);
  assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
  assert.equal(getRun(run.id)!.status, 'human-gating');
});

test('runResolveDecision keeps a review request unresolved when launch validation refuses it', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-DECISION-REFUSAL',
    runner: 'claude',
    slotId: 'test-review-decision-slot',
  });
  const decision: RunDecision = {
    id: 'review-decision-refusal',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Request another review',
    actions: [
      {
        id: 'request-review',
        label: 'Request Review',
        style: 'secondary',
      },
    ],
    createdAt: '2026-08-03T00:00:00.000Z',
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });

  await assert.rejects(
    runResolveDecision(
      {
        selectionData: {
          reviewRequest: { runner: 'claude', model: null, effort: null, mode: 'cold' },
        },
        runId: run.id,
        decisionId: decision.id,
        actionId: 'request-review',
      },
      () => {},
      {
        assertReviewLaunchAllowed: async () => {
          throw new GatewayMethodError(
            'PUBLICATION_REVIEW_LAUNCH_REJECTED',
            'Review launch refused: test worktree is dirty.',
            { userAction: 'Commit the validated fixes, then request re-review.' },
          );
        },
      },
    ),
    (error: unknown) => {
      const structured = error as GatewayMethodError;
      assert.equal(structured.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.equal(structured.userAction, 'Commit the validated fixes, then request re-review.');
      return true;
    },
  );

  const persistedDecision = getRun(run.id)?.decisions.find(
    (candidate) => candidate.id === decision.id,
  );
  assert.equal(persistedDecision?.resolvedAt, undefined);
  assert.equal(persistedDecision?.resolvedAction, undefined);
});

test('a fifth review spent during launch validation leaves the waiting request pending', async (t) => {
  const runs = ['waiting', 'sibling'].map((name) =>
    createRun({
      flowType: 'fix-bug',
      mode: 'autonomous',
      project: 'review-budget-race',
      ticketOrPr: `MANUAL-${name}`,
      runner: 'claude',
      slotId: `test-budget-${name}`,
    }),
  );
  const [waiting, sibling] = runs;
  const url = `https://github.com/example/budget-${waiting.id}/pull/42`;
  for (const run of runs) updateRun(run.id, { links: [{ label: 'PR', url }] });
  const decision: RunDecision = {
    id: 'budget-race',
    type: 'engine_human_gate',
    title: 'Review',
    description: '',
    actions: [{ id: 'request-review', label: 'Review', style: 'secondary' }],
    createdAt: new Date().toISOString(),
  };
  updateRun(waiting.id, { status: 'human-gating', decisions: [decision] });
  t.after(async () => {
    for (const run of runs) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
  });
  for (let index = 0; index < 4; index++) await admitReviewRound(waiting.id, `spent-${index}`);
  await assert.rejects(
    runResolveDecision(
      {
        runId: waiting.id,
        decisionId: decision.id,
        actionId: 'request-review',
        selectionData: {
          reviewRequest: { runner: 'claude', model: 'sonnet', effort: null, mode: 'cold' },
        },
      },
      () => {},
      {
        assertReviewLaunchAllowed: async () => {
          await admitReviewRound(sibling.id, 'concurrent-fifth');
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof GatewayMethodError);
      assert.equal(error.code, 'REVIEW_ROUND_LIMIT_REACHED');
      return true;
    },
  );
  assert.equal(getRun(waiting.id)!.decisions[0].resolvedAt, undefined);
  assert.equal(getRun(waiting.id)!.decisions[0].selectionData, undefined);
});

test('runResolveDecision refuses a full-live review loop before any restore or launch check', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-LIVE-LOOP',
    runner: 'claude',
    slotId: 'test-review-live-loop-slot',
  });
  const decision: RunDecision = {
    id: 'review-decision-live-loop',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Request another review',
    actions: [{ id: 'request-review', label: 'Request Review', style: 'secondary' }],
    createdAt: '2026-09-23T00:00:00.000Z',
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  const touched: string[] = [];

  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'request-review',
        selectionData: {
          reviewRequest: {
            runner: 'codex',
            model: null,
            effort: null,
            mode: 'cold',
            validationDepth: 'full-live',
          },
        },
      },
      () => {},
      {
        restoreGatePark: async () => {
          touched.push('restore');
          throw new Error('restore must not run');
        },
        assertReviewLaunchAllowed: async () => {
          touched.push('launch');
        },
      },
    ),
    (error: Error) => /unsupported property: validationDepth/.test(error.message),
  );
  assert.deepEqual(touched, []);
  const persisted = getRun(run.id)?.decisions.find((candidate) => candidate.id === decision.id);
  assert.equal(persisted?.resolvedAt, undefined);
  assert.equal(persisted?.selectionData, undefined);
});

test('runResolveDecision reports a recoverable action when a review run has no assigned slot', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-NO-SLOT',
    runner: 'claude',
  });
  const decision: RunDecision = {
    id: 'review-decision-no-slot',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Request another review',
    actions: [
      {
        id: 'request-review',
        label: 'Request Review',
        style: 'secondary',
      },
    ],
    createdAt: '2026-08-04T00:00:00.000Z',
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });

  await assert.rejects(
    runResolveDecision(
      {
        selectionData: {
          reviewRequest: { runner: 'claude', model: null, effort: null, mode: 'cold' },
        },
        runId: run.id,
        decisionId: decision.id,
        actionId: 'request-review',
      },
      () => {},
    ),
    (error: unknown) => {
      const structured = error as GatewayMethodError;
      assert.equal(structured.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(structured.userAction ?? '', /restore or assign.*slot/iu);
      return true;
    },
  );

  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
});

test('runResolveDecision clears a prior launch rejection after successful gate resolution', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-DECISION-SUCCESS',
    runner: 'claude',
    slotId: 'test-review-decision-slot',
    engineState: {
      publishGate: {
        reviewLaunchRejection: {
          code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
          message: 'A prior review request was refused.',
          userAction: 'Commit the validated fixes, then request re-review.',
          rejectedAt: '2026-08-03T00:00:00.000Z',
        },
      },
    },
  });
  const decision: RunDecision = {
    id: 'review-decision-success',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Request another review',
    actions: [
      {
        id: 'request-review',
        label: 'Request Review',
        style: 'secondary',
      },
    ],
    createdAt: '2026-08-03T00:00:00.000Z',
  };
  // A run waits at its gate for an action to apply; the resume that applies it is stubbed.
  updateRun(run.id, { status: 'human-gating', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await runResolveDecision(
    {
      selectionData: {
        reviewRequest: { runner: 'claude', model: null, effort: null, mode: 'cold' },
      },
      runId: run.id,
      decisionId: decision.id,
      actionId: 'request-review',
    },
    () => {},
    { assertReviewLaunchAllowed: async () => {}, resumeRun: async () => {} },
  );

  const persisted = getRun(run.id)!;
  assert.equal(persisted.engineState?.publishGate?.reviewLaunchRejection, undefined);
  assert.equal(persisted.decisions[0]?.resolvedAction, 'request-review');
  assert.ok(persisted.decisions[0]?.resolvedAt);
});

test('runResolveDecision retains a launch rejection for non-review gate actions', async (t) => {
  const rejection = {
    code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED' as const,
    message: 'A prior review request was refused.',
    userAction: 'Commit the validated fixes, then request re-review.',
    rejectedAt: '2026-08-03T00:00:00.000Z',
  };
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-REVIEW-HOLD-REJECTION',
    runner: 'claude',
    slotId: 'test-review-decision-slot',
    engineState: { publishGate: { reviewLaunchRejection: rejection } },
  });
  const decision: RunDecision = {
    id: 'review-decision-hold',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Hold publication',
    actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
    createdAt: '2026-08-03T00:00:00.000Z',
  };
  updateRun(run.id, { status: 'human-gating', decisions: [decision] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await runResolveDecision({ runId: run.id, decisionId: decision.id, actionId: 'hold' }, () => {}, {
    resumeRun: async () => {},
  });

  assert.deepEqual(getRun(run.id)?.engineState?.publishGate?.reviewLaunchRejection, rejection);
});

function sendBackFixture(t: import('node:test').TestContext, ticket: string) {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: ticket,
    runner: 'claude',
    slotId: 'test-send-back-slot',
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review-1',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            retryCount: 0,
            maxRetries: 1,
          },
        ],
      },
    },
  });
  const gate = (id: string): RunDecision => ({
    id,
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Return Issues',
    actions: [{ id: SEND_BACK_TO_AGENT_ACTION, label: 'Send back to agent', style: 'primary' }],
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  updateRun(run.id, { status: 'human-gating', decisions: [gate('gate-1')] });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const packageHash = 'b'.repeat(64);
  const scope: RecipeRepairScope = {
    schemaVersion: 1,
    repairId: recipeRepairId({ runId: run.id, packageHash, receiptIds: ['receipt-1'] }),
    runId: run.id,
    generation: 0,
    decisionId: 'gate-1',
    packageHash,
    packageHeadSha: 'c'.repeat(40),
    reviewBaseSha: 'd'.repeat(40),
    reviewId: 'review-1',
    workerContextId: `${run.id}:dev`,
    repairRecipe: 'recipes/visual-repair.json',
    claims: [{ id: 'AC-1', claim: 'The chart renders.' }],
    sources: [
      {
        recipeRunId: 'original',
        closureIdentity: `sha256:${'e'.repeat(64)}`,
        artifactRoot: 'artifacts/recipe-runs/original',
        headSha: 'c'.repeat(40),
      },
    ],
    retained: [],
    rejected: [
      {
        claimId: 'AC-1',
        proofMode: 'visual',
        receiptId: 'receipt-1',
        reason: 'The chart is blank.',
        recipeRunId: 'original',
        closureIdentity: `sha256:${'e'.repeat(64)}`,
        reviewedFiles: [],
        moments: [],
      },
    ],
  };
  const admission = async (current: Run): Promise<VisualRepairAdmission> => {
    const review = current.engineState!.publishGate!.reviews![0]!;
    const reuse = current.engineState?.publishGate?.visualRepairs?.find(
      ({ repairId }) => repairId === scope.repairId,
    );
    return {
      scope,
      review,
      issues: [{ ...scope.rejected[0]!, reviewer: 'Reviewer' }],
      ...(reuse ? { reuse } : {}),
    };
  };
  return { run, admission, gate };
}

test('Send back refusals keep the gate pending and charge nothing', async (t) => {
  const { run } = sendBackFixture(t, 'PROJ-SEND-BACK-REFUSED');
  let admitted = 0;
  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: 'gate-1',
        actionId: SEND_BACK_TO_AGENT_ACTION,
        selectionData: { issues: ['Use this text instead'] },
      },
      () => {},
      { admitVisualRepair: async () => (admitted++, Promise.reject(new Error('unreachable'))) },
    ),
    /Only an operator feedback or comment note/u,
  );
  assert.equal(admitted, 0, 'client-supplied repair content is refused before admission');
  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: 'gate-1', actionId: SEND_BACK_TO_AGENT_ACTION },
      () => {},
      {
        admitVisualRepair: async () => {
          throw new GatewayMethodError('VISUAL_REPAIR_REFUSED', 'No fix round left.');
        },
      },
    ),
    { code: 'VISUAL_REPAIR_REFUSED' },
  );
  const persisted = getRun(run.id)!;
  assert.equal(persisted.decisions[0]?.resolvedAt, undefined);
  assert.equal(persisted.engineState?.publishGate?.reviews?.[0]?.retryCount, 0);
  assert.equal(persisted.engineState?.publishGate?.visualRepairs, undefined);
});

test('Send back preserves operator feedback without accepting client-supplied findings', async (t) => {
  const { run, admission } = sendBackFixture(t, 'PROJ-SEND-BACK-NOTE');
  const feedback = 'Fix both open findings and re-prove AC-1.';
  await runResolveDecision(
    {
      runId: run.id,
      decisionId: 'gate-1',
      actionId: SEND_BACK_TO_AGENT_ACTION,
      selectionData: { feedback },
    },
    () => {},
    { admitVisualRepair: admission, resumeRun: async () => {} },
  );
  const persisted = getRun(run.id)!;
  assert.deepEqual(persisted.decisions[0]?.selectionData, { feedback });
  assert.equal(persisted.engineState?.publishGate?.visualRepairs?.length, 1);
  assert.equal(persisted.engineState?.publishGate?.reviews?.[0]?.retryCount, 1);
});

test('Send back reserves one fix round when the gate is consumed and a retry reuses it', async (t) => {
  const { run, admission, gate } = sendBackFixture(t, 'PROJ-SEND-BACK-RESERVED');
  let resumed!: () => void;
  const resume = new Promise<void>((resolve) => (resumed = resolve));
  await runResolveDecision(
    { runId: run.id, decisionId: 'gate-1', actionId: SEND_BACK_TO_AGENT_ACTION },
    () => {},
    { admitVisualRepair: admission, resumeRun: async () => resumed() },
  );
  await resume;
  let persisted = getRun(run.id)!;
  assert.equal(persisted.decisions[0]?.resolvedAction, SEND_BACK_TO_AGENT_ACTION);
  assert.equal(persisted.engineState?.publishGate?.reviews?.[0]?.retryCount, 1);
  assert.equal(persisted.engineState?.publishGate?.visualRepairs?.length, 1);
  assert.equal(persisted.engineState?.publishGate?.visualRepairs?.[0]?.status, 'reserved');
  // An undelivered repair re-presented at a new gate keeps the same identity and charge.
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [...getRun(run.id)!.decisions, gate('gate-2')],
  });
  await runResolveDecision(
    { runId: run.id, decisionId: 'gate-2', actionId: SEND_BACK_TO_AGENT_ACTION },
    () => {},
    { admitVisualRepair: admission, resumeRun: async () => {} },
  );
  persisted = getRun(run.id)!;
  assert.equal(persisted.decisions[1]?.resolvedAction, SEND_BACK_TO_AGENT_ACTION);
  assert.equal(persisted.engineState?.publishGate?.reviews?.[0]?.retryCount, 1);
  assert.equal(persisted.engineState?.publishGate?.visualRepairs?.length, 1);
});

function makeReadyGatePackage(overrides: Partial<ReadyGatePrPackage> = {}): ReadyGatePrPackage {
  const packageWithoutHash: Omit<ReadyGatePrPackage, 'packageHash'> = {
    id: overrides.id ?? 'pkg-test',
    artifactPath: overrides.artifactPath ?? 'artifacts/pr-package.json',
    branch: overrides.branch ?? 'feature/test',
    remoteBranchRef: overrides.remoteBranchRef ?? 'origin/feature/test',
    headSha: overrides.headSha ?? 'abc1234',
    diffStat: overrides.diffStat ?? { files: 1, additions: 2, deletions: 0 },
    draftTitle: overrides.draftTitle ?? 'fix(test): publish package',
    draftBody: overrides.draftBody ?? 'body',
    evidenceManifest: overrides.evidenceManifest ?? [],
    selectedEvidenceKeys: overrides.selectedEvidenceKeys ?? [],
    validationSummaryPath: overrides.validationSummaryPath ?? null,
    validationSummaryHash: overrides.validationSummaryHash ?? null,
    reviewArtifactIds: overrides.reviewArtifactIds ?? [],
    dispatchMode: overrides.dispatchMode ?? 'autonomous',
    gatePolicy: overrides.gatePolicy ?? {
      owner: 'human',
      dispatchMode: 'autonomous',
      publishAuthority: 'human',
      reason: 'local-first publication requires human approval',
    },
    reviewPolicy: overrides.reviewPolicy ?? {
      minimumReviews: 0,
      requestedBy: 'dispatch',
    },
    publicationTarget: overrides.publicationTarget ?? 'ready',
    publicationStatus: overrides.publicationStatus ?? 'not_published',
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
  };
  const packageHash = overrides.packageHash ?? computeReadyGatePackageHash(packageWithoutHash);
  return { ...packageWithoutHash, packageHash };
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('assertDecisionStillUnresolved lets a first resolver through and blocks a raced second one', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `RESOLVE-RACE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise concurrent decision resolution guard',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const decision: RunDecision = {
    id: 'handoff-1',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Waiting for SIGNAL.json',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' as const },
      { id: 'abort', label: 'Abort Run', style: 'danger' as const },
    ],
    createdAt: '2026-04-15T00:00:00.000Z',
  };
  updateRun(run.id, { decisions: [decision] });

  // Unresolved: the guard passes.
  assertDecisionStillUnresolved(run.id, decision.id);

  // An operator abort lands while another resolver is mid-await: the second
  // writer must be rejected instead of overwriting the abort.
  decision.resolvedAt = '2026-04-15T00:01:00.000Z';
  decision.resolvedAction = 'abort';
  updateRun(run.id, { decisions: [decision] });
  assert.throws(
    () => assertDecisionStillUnresolved(run.id, decision.id),
    /Decision already resolved/,
  );
  assert.throws(() => assertDecisionStillUnresolved(run.id, 'missing-id'), /already resolved/);
});

test('a gate action on a gate decision another one replaced is refused, not reported ok and dropped', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `GATE-REPLACED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Two open gate decisions, as run 7e88468f had',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const gate = (id: string, createdAt: string): RunDecision => ({
    id,
    type: 'engine_human_gate',
    title: 'MANUAL — human gate',
    description: 'Review the package.',
    actions: [{ id: 'request-review', label: 'Request review', style: 'primary' as const }],
    createdAt,
  });
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [
      gate('older', '2026-10-31T15:08:51.529Z'),
      gate('newer', '2026-10-31T15:14:39.995Z'),
    ],
  });
  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: 'older', actionId: 'request-review' },
      () => {},
    ),
    (error: unknown) =>
      error instanceof Error &&
      /older has been replaced by newer; act on the current gate/.test(error.message),
  );
  assert.equal(getRun(run.id)!.decisions.find((d) => d.id === 'older')!.resolvedAt, undefined);
  assert.throws(() => assertDecisionStillUnresolved(run.id, 'older'), /replaced by newer/);
  assertDecisionStillUnresolved(run.id, 'newer');
});

test('the gate decision an engine waits on stays current even when an orphan was opened after it', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `GATE-LIVE-OLDER-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Older gate has the live waiter, newer one is an orphan (7e88468f order)',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const waiting = createEngineDecision(
    run.id,
    'human_gate',
    'Package ready',
    [{ id: 'abort', label: 'Abort', style: 'danger' }],
    undefined,
    { readProgress: async () => ({ kind: 'idle' }) },
  );
  await Promise.resolve();
  const live = getRun(run.id)!.decisions.at(-1)!;
  const orphan: RunDecision = {
    id: 'orphan-gate',
    type: 'engine_human_gate',
    title: 'Gate',
    description: 'No engine waits on this one.',
    actions: [{ id: 'request-review', label: 'Request review', style: 'primary' }],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, { decisions: [...getRun(run.id)!.decisions, orphan] });
  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: 'orphan-gate', actionId: 'request-review' },
      () => {},
    ),
    new RegExp(`orphan-gate has been replaced by ${live.id}`),
  );
  assertDecisionStillUnresolved(run.id, live.id);
  await runResolveDecision({ runId: run.id, decisionId: live.id, actionId: 'abort' }, () => {});
  assert.equal(await waiting, 'abort');
});

test('with no engine waiting, acting on the newest gate supersedes the other orphans and resumes the run', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `GATE-ORPHANS-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Both gate decisions lost their engine (gateway restart)',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const gate = (id: string): RunDecision => ({
    id,
    type: 'engine_human_gate',
    title: 'Gate',
    description: 'Retry this gate.',
    actions: [{ id: 'hold', label: 'Retry Gate', style: 'secondary' }],
    createdAt: new Date().toISOString(),
  });
  updateRun(run.id, { status: 'blocked', decisions: [gate('older'), gate('newer')] });
  let resumed!: () => void;
  const resume = new Promise<void>((resolve) => (resumed = resolve));
  await runResolveDecision({ runId: run.id, decisionId: 'newer', actionId: 'hold' }, () => {}, {
    resumeRun: async () => resumed(),
  });
  await Promise.race([
    resume,
    new Promise((_, reject) => setTimeout(() => reject(new Error('run did not resume')), 2_000)),
  ]);
  const older = getRun(run.id)!.decisions.find((decision) => decision.id === 'older')!;
  assert.equal(older.resolvedAction, 'superseded');
  assert.equal(older.context?.supersededBy, 'newer');
});

test('a gate action no engine waits for is refused, not acknowledged, when no resume could apply it', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `GATE-UNCARRIED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'The gate lost its engine in a gateway restart (8a768552, 7e88468f)',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const gate: RunDecision = {
    id: 'restarted-gate',
    type: 'engine_human_gate',
    title: 'Gate',
    description: 'Re-presented after a restart; no engine waits on it.',
    actions: [{ id: 'hold', label: 'Retry Gate', style: 'secondary' }],
    createdAt: new Date().toISOString(),
  };
  const monitor: RunDecision = {
    id: 'monitor-wait',
    type: 'monitor_timeout',
    title: 'Monitor',
    description: 'Still open.',
    actions: [{ id: 'extend', label: 'Extend', style: 'primary' }],
    createdAt: new Date().toISOString(),
  };
  const resumed: string[] = [];
  const continueFixing: RunDecision = {
    ...gate,
    actions: [{ id: CONTINUE_REVIEW_FIX_ACTION, label: 'Continue Fixing', style: 'primary' }],
  };
  for (const [status, decisions, actionId, reason] of [
    ['reconciling', [gate], 'hold', /the run is reconciling, not waiting at its gate/],
    ['blocked', [gate, monitor], 'hold', /also waits on its monitor_timeout decision monitor-wait/],
    // A resumed gate never replays Continue Fixing, so no fix would start.
    [
      'human-gating',
      [continueFixing],
      CONTINUE_REVIEW_FIX_ACTION,
      /a resumed gate does not apply continue-review-fix/,
    ],
  ] as const) {
    updateRun(run.id, { status, decisions: decisions.map((decision) => ({ ...decision })) });
    await assert.rejects(
      runResolveDecision({ runId: run.id, decisionId: gate.id, actionId }, () => {}, {
        resumeRun: async (id) => {
          resumed.push(id);
        },
      }),
      (error: unknown) =>
        error instanceof GatewayMethodError &&
        error.code === 'RUN_GATE_NOT_READY' &&
        reason.test(error.message),
    );
    assertDecisionStillUnresolved(run.id, gate.id);
  }
  // Let a wrongly scheduled resume fire before checking that none was.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(resumed, []);
});

test('a gate action an engine waits for is taken by it, unless the run ended', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `GATE-WAITED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'A live engine owns the gate while progress is unproven',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  const openGate = async (readProgress: () => Promise<RunProgressObservation>) => {
    const waiting = createEngineDecision(
      run.id,
      'human_gate',
      'Package ready',
      [{ id: 'abort', label: 'Abort', style: 'danger' }],
      undefined,
      { readProgress },
    );
    for (let poll = 0; !getRun(run.id)!.decisions.some((d) => !d.resolvedAt); poll++) {
      assert.ok(poll < 100, 'the gate decision was not presented');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return { waiting, live: getRun(run.id)!.decisions.find((d) => !d.resolvedAt)! };
  };
  for (const progress of [
    { kind: 'unproven', reason: 'run-progress-unconfirmed' },
    { kind: 'idle' },
  ] as const) {
    const { waiting, live } = await openGate(async () => progress);
    assert.equal(getRun(run.id)!.status, progress.kind === 'idle' ? 'human-gating' : 'reconciling');
    await runResolveDecision({ runId: run.id, decisionId: live.id, actionId: 'abort' }, () => {});
    assert.equal(await waiting, 'abort');
  }
  // A cancelled run's waiting engine would abort instead of acting: refused, not acknowledged.
  const { live } = await openGate(async () => ({ kind: 'idle' }));
  updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  await assert.rejects(
    runResolveDecision({ runId: run.id, decisionId: live.id, actionId: 'abort' }, () => {}),
    /abort would not be applied: the run is cancelled/,
  );
  assertDecisionStillUnresolved(run.id, live.id);
});

test('publication RPC refuses unresolved findings without a pending decision, including an active fix', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'review-fix-refusal',
    ticketOrPr: 'TAT-REVIEW-FIX',
    transport: 'tmux',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'rv3',
            source: 'human-gate',
            mode: 'cold',
            loopNumber: 3,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'icon.service.ts', description: 'Exponential parsing' }],
            feedbackSent: false,
          },
        ],
      },
    },
  });
  for (const status of ['human-gating', 'fixing'] as const) {
    updateRun(run.id, { status });
    const before = structuredClone(getRun(run.id));
    for (const actionId of PUBLISH_APPROVAL_ACTIONS) {
      await assert.rejects(
        runResolveDecision({ runId: run.id, decisionId: 'no-pending-decision', actionId }, () =>
          assert.fail('no side effects'),
        ),
        (error: unknown) =>
          // Readiness, not the review-block pre-check, decides accepting findings.
          actionId === 'approve-publish-unresolved'
            ? /Decision not found/.test(String(error))
            : error instanceof GatewayMethodError &&
              error.code === 'RUN_GATE_NOT_READY' &&
              /Review found 1 issue/.test(error.message),
      );
    }
    assert.deepEqual(getRun(run.id), before);
  }
});

test('runResolveDecision keeps publish gate pending when approved package selection is stale', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PUBLISH-STALE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise stale publish package approval',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const prPackage = makeReadyGatePackage();
  const decision: RunDecision = {
    id: 'publish-gate',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: prPackage.diffStat,
      workerReport: 'ready',
      branch: prPackage.branch,
      headSha: prPackage.headSha,
      artifactManifest: prPackage.evidenceManifest,
      prPackage,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      reviewPolicy: prPackage.reviewPolicy,
      reviews: [],
    },
  };
  updateRun(run.id, {
    decisions: [decision],
    engineState: {
      publishGate: {
        publicationStatus: 'not_published',
        reviewPolicy: prPackage.reviewPolicy,
        reviews: [],
      },
    },
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'approve-publish',
          selectionData: {
            packageId: prPackage.id,
            packageHash: 'stale-hash',
            packageHeadSha: prPackage.headSha,
          },
        },
        () => {},
      ),
    /refresh package and re-review before publishing/,
  );
  const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
  assert.equal(stillPending?.resolvedAt, undefined);
});

for (const actionId of ['approve-publish', 'approve-publish-unresolved']) {
  test(`runResolveDecision rejects approval when current package artifact drifted (${actionId})`, async (t) => {
    const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-package-drift-'));
    t.after(() => rmSync(taskDir, { recursive: true, force: true }));
    mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
    const taskFile = path.join(taskDir, 'task.md');
    writeFileSync(taskFile, 'task', 'utf-8');

    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: `PUBLISH-DRIFT-${Date.now().toString(16).toUpperCase()}`,
      mode: 'autonomous',
      initialContext: 'Exercise current package drift approval',
    });
    t.after(async () => {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(run.id);
      }
    });

    const visiblePackage = makeReadyGatePackage({ id: 'pkg-visible' });
    const currentPackage = makeReadyGatePackage({ id: 'pkg-current' });
    writeFileSync(
      path.join(taskDir, currentPackage.artifactPath),
      JSON.stringify(currentPackage, null, 2),
      'utf-8',
    );
    const decision: RunDecision = {
      id: 'publish-gate-drift',
      type: 'engine_human_gate',
      title: 'Ready',
      description: 'Ready',
      actions: [{ id: actionId, label: 'Approve Publish', style: 'primary' as const }],
      createdAt: '2026-04-15T00:00:00.000Z',
      payload: {
        kind: 'ready',
        prNumber: null,
        repo: null,
        diffStat: visiblePackage.diffStat,
        workerReport: 'ready',
        branch: visiblePackage.branch,
        headSha: visiblePackage.headSha,
        artifactManifest: visiblePackage.evidenceManifest,
        prPackage: visiblePackage,
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        reviewPolicy: visiblePackage.reviewPolicy,
        reviews: [],
      },
    };
    updateRun(run.id, {
      taskFile,
      decisions: [decision],
      engineState: {
        publishGate: {
          packageArtifactPath: currentPackage.artifactPath,
          publicationStatus: 'not_published',
          reviewPolicy: visiblePackage.reviewPolicy,
          reviews: [],
        },
      },
    });

    const accepting = actionId === 'approve-publish-unresolved';
    await assert.rejects(
      () =>
        runWithSessionOriginator(acceptor, () =>
          runResolveDecision(
            {
              runId: run.id,
              decisionId: decision.id,
              actionId,
              ...(accepting ? ACCEPTANCE : {}),
              selectionData: {
                packageId: visiblePackage.id,
                packageHash: visiblePackage.packageHash,
                packageHeadSha: visiblePackage.headSha,
              },
            },
            () => {},
            accepting ? acceptorAuthority : {},
          ),
        ),
      /refresh package and re-review before publishing/,
    );
    const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
    assert.equal(stillPending?.resolvedAt, undefined);
  });
}

for (const actionId of ['approve-publish', 'approve-publish-unresolved']) {
  test(`runResolveDecision rejects approval when selected evidence hash drifted (${actionId})`, async (t) => {
    const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-evidence-drift-'));
    t.after(() => rmSync(taskDir, { recursive: true, force: true }));
    mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
    const taskFile = path.join(taskDir, 'task.md');
    const evidencePath = path.join(taskDir, 'artifacts/keep.png');
    writeFileSync(taskFile, 'task', 'utf-8');
    writeFileSync(evidencePath, 'original-image', 'utf-8');

    const prPackage = makeReadyGatePackage({
      evidenceManifest: [
        {
          path: 'artifacts/keep.png',
          purpose: 'after',
          sizeBytes: 'original-image'.length,
          sha256: sha256Text('original-image'),
        },
      ],
      selectedEvidenceKeys: ['artifacts/keep.png'],
    });
    writeFileSync(
      path.join(taskDir, prPackage.artifactPath),
      JSON.stringify(prPackage, null, 2),
      'utf-8',
    );

    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: `EVIDENCE-DRIFT-${Date.now().toString(16).toUpperCase()}`,
      mode: 'autonomous',
      initialContext: 'Exercise selected evidence drift approval',
    });
    t.after(async () => {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(run.id);
      }
    });

    const decision: RunDecision = {
      id: 'publish-gate-evidence-drift',
      type: 'engine_human_gate',
      title: 'Ready',
      description: 'Ready',
      actions: [{ id: actionId, label: 'Approve Publish', style: 'primary' as const }],
      createdAt: '2026-04-15T00:00:00.000Z',
      payload: {
        kind: 'ready',
        prNumber: null,
        repo: null,
        diffStat: prPackage.diffStat,
        workerReport: 'ready',
        branch: prPackage.branch,
        headSha: prPackage.headSha,
        artifactManifest: prPackage.evidenceManifest,
        prPackage,
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        reviewPolicy: prPackage.reviewPolicy,
        reviews: [],
      },
    };
    updateRun(run.id, {
      taskFile,
      decisions: [decision],
      engineState: {
        publishGate: {
          packageArtifactPath: prPackage.artifactPath,
          publicationStatus: 'not_published',
          reviewPolicy: prPackage.reviewPolicy,
          reviews: [],
        },
      },
    });

    await retainRunFixture(getRun(run.id)!, prPackage);
    await overwriteRetainedFixture(getRun(run.id)!, 'artifacts/keep.png', 'mutated-image');

    const accepting = actionId === 'approve-publish-unresolved';
    await assert.rejects(
      () =>
        runWithSessionOriginator(acceptor, () =>
          runResolveDecision(
            {
              runId: run.id,
              decisionId: decision.id,
              actionId,
              ...(accepting ? ACCEPTANCE : {}),
              selectionData: {
                packageId: prPackage.id,
                packageHash: prPackage.packageHash,
                packageHeadSha: prPackage.headSha,
                selectedEvidenceKeys: ['artifacts/keep.png'],
              },
            },
            () => {},
            accepting ? acceptorAuthority : {},
          ),
        ),
      /selected evidence hash mismatch/,
    );
    const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
    assert.equal(stillPending?.resolvedAt, undefined);
  });
}

test('runResolveDecision rejects approval when selected evidence differs from refreshed package', async (t) => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'farmslot-evidence-selection-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  writeFileSync(taskFile, 'task', 'utf-8');

  const prPackage = makeReadyGatePackage({
    evidenceManifest: [
      {
        path: 'artifacts/keep.png',
        purpose: 'after',
        sizeBytes: 10,
        sha256: sha256Text('original-image'),
      },
    ],
    selectedEvidenceKeys: ['artifacts/keep.png'],
  });
  writeFileSync(
    path.join(taskDir, prPackage.artifactPath),
    JSON.stringify(prPackage, null, 2),
    'utf-8',
  );

  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `EVIDENCE-SELECTION-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise selected evidence approval mismatch',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const decision: RunDecision = {
    id: 'publish-gate-evidence-selection',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Ready',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat: prPackage.diffStat,
      workerReport: 'ready',
      branch: prPackage.branch,
      headSha: prPackage.headSha,
      artifactManifest: prPackage.evidenceManifest,
      prPackage,
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      reviewPolicy: prPackage.reviewPolicy,
      reviews: [],
    },
  };
  updateRun(run.id, {
    taskFile,
    decisions: [decision],
    engineState: {
      publishGate: {
        packageArtifactPath: prPackage.artifactPath,
        publicationStatus: 'not_published',
        reviewPolicy: prPackage.reviewPolicy,
        reviews: [],
      },
    },
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'approve-publish',
          selectionData: {
            packageId: prPackage.id,
            packageHash: prPackage.packageHash,
            packageHeadSha: prPackage.headSha,
            selectedEvidenceKeys: [],
          },
        },
        () => {},
      ),
    /selected evidence differs/,
  );
  const stillPending = getRun(run.id)?.decisions.find((entry) => entry.id === decision.id);
  assert.equal(stillPending?.resolvedAt, undefined);
});

test('production duplicate runs are rejected', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'fix-bug',
          lane: 'production',
          variant: null,
          familyId: 'family-2',
        },
        [makeRun()],
      ),
    /Active run already exists/,
  );
});

test('comparison duplicates require explicit family id', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'codex',
          familyId: undefined,
        },
        [makeRun({ lane: 'comparison', variant: 'claude' })],
      ),
    /require an explicit familyId/,
  );
});

test('comparison duplicates reject conflicting family or reused variant', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'claude',
          familyId: 'family-1',
        },
        [makeRun({ lane: 'comparison', variant: 'claude', familyId: 'family-1' })],
      ),
    /Comparison duplicate blocked/,
  );
});

test('comparison duplicates are allowed for same family with distinct variants', () => {
  assert.doesNotThrow(() =>
    assertDuplicateRunAllowed(
      {
        ticketOrPr: 'PROJ-1',
        project: 'example-mobile-farm',
        flowType: 'dev',
        lane: 'comparison',
        variant: 'codex',
        familyId: 'family-1',
      },
      [makeRun({ lane: 'comparison', variant: 'claude', familyId: 'family-1' })],
    ),
  );
});

test('createRun persists lightweight interactive dev initial context policy', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-LOCAL-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Explore a faster local dev task launch flow',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  assert.equal(run.flowType, 'dev');
  assert.equal(run.devInteractiveProfile, 'lightweight');
  assert.equal(run.engineState?.interactiveDev?.profile, 'lightweight');
  assert.equal(
    run.engineState?.interactiveDev?.initialContext,
    'Explore a faster local dev task launch flow',
  );
});

test('createRun preserves reviewed interactive dev profile on dev lane', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-REVIEWED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
    initialContext: 'Prototype with review enabled',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  assert.equal(run.flowType, 'dev');
  assert.equal(run.devInteractiveProfile, 'reviewed');
  assert.equal(run.engineState?.interactiveDev?.profile, 'reviewed');
  assert.equal(run.engineState?.interactiveDev?.initialContext, 'Prototype with review enabled');
});

test('runInteractiveDevResolve rejects terminal interactive dev runs without slot mutation', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-DONE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Already complete interactive dev task',
  });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  t.after(async () => {
    if (getRun(run.id)) {
      await deleteRun(run.id);
    }
  });

  const result = await runInteractiveDevResolve({ runId: run.id, action: 'done-no-pr' }, () => {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /already terminal/);
  assert.equal(getRun(run.id)?.status, 'done');
});

test('runInteractiveDevResolve marks blocked and failed operator actions with audit state', async (t) => {
  const blocked = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-BLOCKED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Blocked interactive dev task',
  });
  const failed = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `DEV-FAILED-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Failed interactive dev task',
    engineState: { generation: 2 },
  });
  updateRun(failed.id, {
    agentContexts: [
      {
        id: 'ctx-1',
        role: 'primary',
        label: 'Worker',
        status: 'working',
        slotId: 'slot-test',
        runId: failed.id,
        taskFile: 'TASK.md',
        runner: 'codex',
      },
    ],
  });
  t.after(async () => {
    for (const id of [blocked.id, failed.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  const blockedResult = await runInteractiveDevResolve(
    { runId: blocked.id, action: 'blocked', reason: 'waiting on API decision' },
    () => {},
  );
  assert.equal(blockedResult.ok, true);
  const blockedRun = getRun(blocked.id)!;
  assert.equal(blockedRun.status, 'blocked');
  assert.equal(blockedRun.metrics.outcome, 'partial');
  assert.equal(blockedRun.steps.find((step) => step.name === 'monitor')?.status, 'done');
  assert.equal(blockedRun.engineState?.interactiveDev?.terminalActions?.at(-1)?.action, 'blocked');

  const failedResult = await runInteractiveDevResolve(
    { runId: failed.id, action: 'failed', reason: 'operator stopped the attempt' },
    () => {},
  );
  assert.equal(failedResult.ok, true);
  const failedRun = getRun(failed.id)!;
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.metrics.outcome, 'failure');
  assert.deepEqual(failedRun.agentContexts, []);
  assert.equal(failedRun.engineState?.generation, 3);
  assert.equal(failedRun.engineState?.interactiveDev?.terminalActions?.at(-1)?.action, 'failed');
});

test('runInteractiveDevResolve links PR-complete handoff and closes parent ci-watch step', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const projectDir = mkdtempSync(path.join(projectsDir, 'run-test-project-'));
  const project = path.basename(projectDir);
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      ci: { repo: 'example-org/example-mobile' },
    }),
    'utf-8',
  );
  const run = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `DEV-PRCOMPLETE-${Date.now().toString(16).toUpperCase()}`,
    mode: 'interactive',
    initialContext: 'Interactive dev task with PR-complete handoff',
    branch: 'feat/interactive-dev-handoff',
    runner: 'codex',
    model: 'gpt-5.5',
  });
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    invalidateProjectVarsCache(project);
    rmSync(projectDir, { recursive: true, force: true });
    const latest = getRun(run.id);
    if (latest) {
      updateRun(latest.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(latest.id);
    }
  });

  const result = await runInteractiveDevResolve(
    { runId: run.id, action: 'link-pr-and-pr-complete', prRef: '123456' },
    () => {},
  );
  assert.equal(result.ok, true);
  assert.equal(result.prNumber, 123456);
  assert.ok(result.chainedRunId);

  const parent = getRun(run.id)!;
  const child = getRun(result.chainedRunId!)!;
  t.after(async () => {
    if (getRun(child.id)) {
      updateRun(child.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(child.id);
    }
  });

  assert.equal(parent.status, 'done');
  assert.equal(parent.prNumber, 123456);
  assert.equal(parent.steps.find((step) => step.name === 'ci-watch')?.status, 'done');
  assert.equal(
    parent.steps.find((step) => step.name === 'complete')?.outputs?.handoff,
    'pr-complete',
  );
  assert.equal(parent.steps.find((step) => step.name === 'complete')?.outputs?.prNumber, 123456);
  assert.equal(
    parent.engineState?.interactiveDev?.terminalActions?.at(-1)?.action,
    'link-pr-and-pr-complete',
  );
  assert.equal(child.flowType, 'pr-complete');
  assert.equal(child.parentRunId, parent.id);
  assert.equal(child.ticketOrPr, 'example-org/example-mobile#123456');
});

test('runInteractiveDevResolve CI-watch actions resume the pipeline through the publication gate', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const projectDir = mkdtempSync(path.join(projectsDir, 'run-test-project-'));
  const project = path.basename(projectDir);
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      ci: { repo: 'example-org/example-mobile' },
    }),
    'utf-8',
  );
  const taskDir = mkdtempSync(path.join(tmpdir(), 'run-test-task-'));
  writeFileSync(path.join(taskDir, 'TASK.md'), '# Task\n\nPR_NUMBER: 411\n', 'utf-8');
  const localDevSuffix = Date.now().toString(16).toUpperCase().slice(-8);
  const paused = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `DEV-CIWATCH-${localDevSuffix}`,
    mode: 'interactive',
    initialContext: 'Interactive dev task parked at monitor with a pushed PR',
    branch: 'feat/interactive-dev-ci-watch',
  });
  const preGateSteps = new Set(['find-slot', 'write-task', 'prepare', 'dispatch']);
  updateRun(paused.id, {
    status: 'paused',
    taskFile: path.join(taskDir, 'TASK.md'),
    steps: paused.steps.map((step) =>
      preGateSteps.has(step.name)
        ? { ...step, status: 'done', completedAt: new Date().toISOString() }
        : step.name === 'monitor'
          ? { ...step, status: 'running', startedAt: new Date().toISOString() }
          : step,
    ),
    agentContexts: [
      {
        id: 'ctx-worker',
        role: 'primary',
        label: 'Worker',
        status: 'working',
        slotId: '',
        runId: paused.id,
        taskFile: 'TASK.md',
        runner: 'codex',
      },
    ],
  });
  const blocked = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `DEV-CIWATCHB-${localDevSuffix}`,
    mode: 'interactive',
    initialContext: 'Blocked interactive dev task with a pushed PR',
    branch: 'feat/interactive-dev-ci-watch-blocked',
  });
  updateRun(blocked.id, { status: 'blocked', error: 'operator marked blocked' });
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    invalidateProjectVarsCache(project);
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(taskDir, { recursive: true, force: true });
    for (const id of [paused.id, blocked.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  const detectResult = await runInteractiveDevResolve(
    { runId: paused.id, action: 'detect-pr-and-ci-watch' },
    () => {},
  );
  assert.equal(detectResult.ok, true);
  assert.equal(detectResult.prNumber, 411);

  const resumed = getRun(paused.id)!;
  assert.equal(resumed.prNumber, 411);
  // The run must be waiting on the publication gate machinery, not stamped done.
  assert.notEqual(resumed.status, 'done');
  const humanGate = resumed.steps.find((step) => step.name === 'human-gate')!;
  const gateDecision = resumed.decisions.find((decision) => decision.type === 'engine_human_gate');
  assert.ok(
    humanGate.status !== 'done' || gateDecision,
    'human-gate must not complete without a recorded gate decision',
  );
  assert.equal(humanGate.status, 'pending');
  assert.equal(resumed.steps.find((step) => step.name === 'complete')?.status, 'pending');
  assert.equal(resumed.steps.find((step) => step.name === 'finalize')?.status, 'pending');
  assert.equal(resumed.steps.find((step) => step.name === 'ci-watch')?.status, 'pending');
  assert.equal(resumed.steps.find((step) => step.name === 'monitor')?.status, 'done');
  const review = resumed.steps.find((step) => step.name === 'review')!;
  assert.equal(review.status, 'done');
  assert.equal(review.outputs?.skipped, true);
  assert.equal(review.outputs?.source, 'operator');
  assert.equal(resumed.devInteractiveProfile, 'reviewed');
  assert.equal(resumed.engineState?.interactiveDev?.profile, 'reviewed');
  assert.equal(
    resumed.engineState?.interactiveDev?.terminalActions?.at(-1)?.action,
    'link-pr-and-ci-watch',
  );
  // Worker context survives: agent teardown belongs to post-gate finalize.
  assert.equal(resumed.agentContexts?.length, 1);

  const linkResult = await runInteractiveDevResolve(
    { runId: blocked.id, action: 'link-pr-and-ci-watch', prRef: '411' },
    () => {},
  );
  assert.equal(linkResult.ok, true);
  assert.equal(linkResult.prNumber, 411);
  const resumedBlocked = getRun(blocked.id)!;
  assert.equal(resumedBlocked.prNumber, 411);
  assert.notEqual(resumedBlocked.status, 'done');
  assert.notEqual(resumedBlocked.status, 'blocked');
  assert.equal(resumedBlocked.error, undefined);
  assert.equal(resumedBlocked.steps.find((step) => step.name === 'human-gate')?.status, 'pending');
  assert.equal(resumedBlocked.devInteractiveProfile, 'reviewed');
});

test('comparison duplicates are allowed against their explicit production source run', () => {
  assert.doesNotThrow(() =>
    assertDuplicateRunAllowed(
      {
        ticketOrPr: 'PROJ-1',
        project: 'example-mobile-farm',
        flowType: 'dev',
        lane: 'comparison',
        variant: 'codex',
        familyId: 'source-run',
        parentRunId: 'source-run',
      },
      [makeRun({ id: 'source-run', lane: 'production', variant: null, familyId: 'source-run' })],
    ),
  );
});

test('comparison duplicates are blocked when existing active production run is not the source', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'codex',
          familyId: 'family-1',
        },
        [makeRun({ lane: 'production', variant: null, familyId: 'family-1' })],
      ),
    /Comparison duplicate blocked/,
  );
});

test('active production run is not bypassed by direct startRef params', () => {
  assert.throws(
    () =>
      assertDuplicateRunAllowed(
        {
          ticketOrPr: 'PROJ-1',
          project: 'example-mobile-farm',
          flowType: 'dev',
          lane: 'comparison',
          variant: 'replay-codex',
          familyId: 'family-1',
          parentRunId: 'wrong-parent',
          completionPolicy: 'artifact-only',
          startRef: 'main',
        },
        [
          makeRun({
            id: 'baseline-run',
            lane: 'production',
            variant: null,
            familyId: 'family-1',
            status: 'monitoring',
          }),
        ],
      ),
    /Comparison duplicate blocked/,
  );
});

test('runCreate rejects direct prior-run startRef provenance', async (t) => {
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const baseline = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const created = [baseline.id];
  t.after(async () => {
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      if (!getRun(id)) {
        continue;
      }
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  await assert.rejects(
    () =>
      runCreate(
        {
          flowType: 'dev',
          project: baseline.project,
          ticketOrPr: baseline.ticketOrPr,
          familyId: baseline.familyId,
          parentRunId: baseline.id,
          lane: 'comparison',
          variant: 'replay-codex',
          completionPolicy: 'artifact-only',
          startRef: 'main',
          startRefSource: { kind: 'prior-run', runId: baseline.id },
        } as any,
        () => {},
      ),
    /eval\.experiment\.create \+ eval\.trial\.start|Comparison duplicate blocked/,
  );
});

test('runCreate defaults omitted dev mode to autonomous when interactive template exists', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const created: string[] = [];
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  const tatKey = `TAT-${Date.now()}`;
  const result = await runCreate(
    {
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: tatKey,
      ticketData: jiraTicketData(tatKey),
    },
    () => {},
  );
  created.push(result.run.id);

  assert.equal(result.run.mode, 'autonomous');
});

test('runCreate permits explicit fresh replacement for a non-PR flow', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  const previousDemoPool = process.env.FARMSLOT_DEMO_POOL;
  process.env.FARMSLOT_DEMO_POOL = '1';
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  let runId = '';
  t.after(async () => {
    if (previousDemoPool === undefined) delete process.env.FARMSLOT_DEMO_POOL;
    else process.env.FARMSLOT_DEMO_POOL = previousDemoPool;
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    if (runId && getRun(runId)) {
      updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(runId);
    }
  });

  const tatKey = `TAT-${Date.now()}`;
  const result = await runCreate(
    {
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: tatKey,
      ticketData: jiraTicketData(tatKey),
      slotId: 'demo-ff-1',
      freshReuse: true,
    },
    () => {},
  );
  runId = result.run.id;

  assert.equal(result.run.engineState?.flags?.freshReuse, true);
});

test('runCreate persists the configured dev-interactive template for interactive dev', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  const previousDemoPool = process.env.FARMSLOT_DEMO_POOL;
  process.env.FARMSLOT_DEMO_POOL = '1';
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const created: string[] = [];
  t.after(async () => {
    if (previousDemoPool === undefined) delete process.env.FARMSLOT_DEMO_POOL;
    else process.env.FARMSLOT_DEMO_POOL = previousDemoPool;
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  const result = await runCreate(
    {
      flowType: 'dev',
      mode: 'interactive',
      slotId: 'demo-ff-1',
      project: 'farmslot-farm',
      ticketOrPr: `interactive dev spike ${Date.now()}`,
    },
    () => {},
  );
  created.push(result.run.id);

  assert.equal(result.run.executionTemplate?.id, 'dev/interactive');
  assert.equal(result.run.taskTemplate, undefined);
});

test('runCreate persists implicit pr-complete-interactive template and branch-based lineage', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const projectDir = mkdtempSync(path.join(projectsDir, 'run-test-pr-complete-'));
  const project = path.basename(projectDir);
  const templatesDir = path.join(projectDir, 'templates', 'worker');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, ci: { repo: 'example-org/example-mobile' } }),
    'utf-8',
  );
  writeFileSync(path.join(templatesDir, 'pr-complete.md'), 'Default PR complete\n', 'utf-8');
  writeFileSync(
    path.join(templatesDir, 'pr-complete-interactive.md'),
    'Interactive PR complete\n',
    'utf-8',
  );
  const created: string[] = [];
  const parent = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `TAT-${Date.now()}`,
    prNumber: 456789,
    branch: 'feat/pr-complete-reentry',
    taskFile: 'tasks/dev/TAT-root/TASK.md',
    familyRootTicketOrPr: 'TAT-root',
  });
  created.push(parent.id);
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
    invalidateProjectVarsCache(project);
    rmSync(projectDir, { recursive: true, force: true });
  });

  const result = await runCreate(
    {
      flowType: 'pr-complete',
      mode: 'interactive',
      project,
      ticketOrPr: 'example-org/example-mobile#456789',
    },
    () => {},
  );
  created.push(result.run.id);

  assert.deepEqual(result.run.taskTemplate, {
    fileName: 'pr-complete-interactive.md',
    variant: 'interactive',
  });
  assert.equal(result.run.branch, 'feat/pr-complete-reentry');
  assert.equal(result.run.parentRunId, parent.id);
  assert.equal(result.run.familyId, parent.familyId);
});

test('runResolveDecision rejects interactive PR-complete handoff resume without terminal signal', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'interactive',
  });
  const decision: RunDecision = {
    id: 'interactive-handoff',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Worker stopped for human handoff',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'signal-written',
        },
        () => {},
      ),
    /fresh terminal SIGNAL\.json/,
  );
  assert.equal(getRun(run.id)?.status, 'blocked');
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
});

test('a worker question handoff resumes monitoring without a terminal signal; other handoffs do not', async (t) => {
  for (const workerQuestion of [true, false]) {
    const run = createRun({
      flowType: 'dev',
      project: 'example-mobile-farm',
      ticketOrPr: `QUESTION-${Date.now()}-${workerQuestion}`,
      mode: 'autonomous',
      ticketData: manualTicketData('Worker question handoff'),
    });
    const decision: RunDecision = {
      id: `question-handoff-${workerQuestion}`,
      type: 'monitor_interactive_handoff',
      title: 'Worker question',
      description: 'The worker asked a question and is waiting for an answer.',
      actions: [
        { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' },
        { id: 'question-closed', label: 'Resume monitoring', style: 'primary' },
        { id: 'abort', label: 'Abort Run', style: 'danger' },
      ],
      createdAt: new Date().toISOString(),
      context: { signalFile: null, ...(workerQuestion ? { workerQuestion: true } : {}) },
    };
    updateRun(run.id, {
      status: 'blocked',
      decisions: [decision],
      steps: [{ name: 'monitor', status: 'running' }],
    });
    t.after(async () => {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(run.id);
      }
    });
    let resumeRun: (() => void) | undefined;
    const resumed = new Promise<void>((resolve) => {
      resumeRun = resolve;
    });
    const resolve = () =>
      runResolveDecision(
        { runId: run.id, decisionId: decision.id, actionId: 'question-closed' },
        () => {},
        { resumeRun: async () => resumeRun?.() },
      );
    if (workerQuestion) {
      await resolve();
      assert.equal(getRun(run.id)?.decisions[0]?.resolvedAction, 'question-closed');
      // Without a live monitor (gateway restart) the resolution re-enters the engine.
      await resumed;
    } else {
      await assert.rejects(resolve, /fresh terminal SIGNAL\.json/);
      assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
    }
  }
});

test('resolving a CI abort without a live resolver re-enters the persisted CI-watch step', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'example-mobile-farm',
    ticketOrPr: 'CI-ABORT-RESTART',
    slotId: 'ci-abort-restart-slot',
  });
  const decision: RunDecision = {
    id: `ci-abort-${run.id}`,
    type: 'ci_inline_fix_blocked',
    title: 'CI fix blocked',
    description: 'Fix did not advance HEAD',
    actions: [{ id: 'abort', label: 'Abort', style: 'danger' }],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, {
    status: 'blocked',
    decisions: [decision],
    steps: [{ name: 'ci-watch', status: 'running', outputs: { phase: 'blocked' } }],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });

  let resumeRun: (() => void) | undefined;
  const resumed = new Promise<void>((resolve) => {
    resumeRun = resolve;
  });
  await runResolveDecision(
    { runId: run.id, decisionId: decision.id, actionId: 'abort' },
    () => {},
    { resumeRun: async () => resumeRun?.() },
  );
  await resumed;

  const after = getRun(run.id)!;
  assert.equal(after.decisions[0]?.resolvedAction, 'abort');
  assert.equal(after.status, 'created');
  assert.equal(after.steps.find((step) => step.name === 'ci-watch')?.status, 'pending');
  assert.equal(after.steps.find((step) => step.name === 'ci-watch')?.outputs, undefined);
});

test('runResolveDecision extends a timed-out interactive handoff without SIGNAL.json', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `TAT-${Date.now()}`,
    mode: 'interactive',
  });
  const decision: RunDecision = {
    id: 'interactive-handoff-timeout',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description:
      'The agent did not write a terminal signal. Finish the PR work in the slot (or verify the signal file), then resume the run.\n\nMonitor note: exceeded 90 minute timeout.',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const staleStart = '2026-09-10T15:49:53.703Z';
  updateRun(run.id, {
    monitorState: {
      nudgeCount: 0,
      lastPollAt: staleStart,
      startedAt: staleStart,
    },
  });
  const before = Date.now();
  const result = await runResolveDecision(
    {
      runId: run.id,
      decisionId: decision.id,
      actionId: 'continue',
    },
    () => {},
  );
  assert.equal(result.run.decisions[0]?.resolvedAction, 'continue');
  assert.ok(result.run.decisions[0]?.resolvedAt);
  const persistedStart = getRun(run.id)?.monitorState?.startedAt;
  assert.ok(persistedStart);
  assert.ok(new Date(persistedStart).getTime() >= before);
  assert.notEqual(persistedStart, staleStart);
  updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
});

test('runResolveDecision still requires SIGNAL.json when continue is listed without a timeout note', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'interactive',
  });
  const decision: RunDecision = {
    id: 'interactive-handoff-listed-continue',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Worker stopped for human handoff',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' },
      { id: 'continue', label: 'Extend monitoring 90 min', style: 'secondary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'continue',
        },
        () => {},
      ),
    /fresh terminal SIGNAL\.json/,
  );
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
});

test('runResolveDecision still rejects continue on a non-timeout interactive handoff', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'interactive',
  });
  const decision: RunDecision = {
    id: 'interactive-handoff-worker-done',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Worker stopped for human handoff',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () =>
      runResolveDecision(
        {
          runId: run.id,
          decisionId: decision.id,
          actionId: 'continue',
        },
        () => {},
      ),
    /Action not found/,
  );
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
});

test('runProbeWorkerSignal reports missing slot when run is unbound', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'interactive',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const probe = await runProbeWorkerSignal({ runId: run.id });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'no_slot');
  assert.match(probe.message, /no slot bound/i);
});

test('runRehydratePrNumber rejects unpublished autonomous dev runs before PR lookup', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'autonomous',
    lane: 'production',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  const result = await runRehydratePrNumber({ runId: run.id }, () => {});
  assert.deepEqual(result, {
    ok: false,
    reason:
      'publication status is not_published; human-approved publication is required before PR rehydrate',
  });
});

test('runRehydratePrNumber rejects artifact-only runs before any PR lookup', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'validation',
    lane: 'validation',
    completionPolicy: 'artifact-only',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  const result = await runRehydratePrNumber({ runId: run.id }, () => {});
  assert.deepEqual(result, {
    ok: false,
    reason: 'artifact-only runs never link or rehydrate PR numbers',
  });
});

// ─── resolveCreateSafetyTier ───

test('resolveCreateSafetyTier: explicit param wins over project default', () => {
  assert.equal(resolveCreateSafetyTier('sandboxed', 'dangerous'), 'sandboxed');
});

test('resolveCreateSafetyTier: project default applies when param is undefined', () => {
  assert.equal(resolveCreateSafetyTier(undefined, 'dangerous'), 'dangerous');
});

test('resolveCreateSafetyTier: undefined when neither is set (runner fallback applies later)', () => {
  assert.equal(resolveCreateSafetyTier(undefined, undefined), undefined);
});

test('createRun defaults explicit Cursor runner with missing model to the shared default', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cursor-default`,
    runner: 'cursor',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  assert.equal(run.metrics.runner, 'cursor');
  assert.equal(run.metrics.model, DEFAULT_CURSOR_MODEL);
});

test('createRun treats explicit Cursor unknown model as unset', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cursor-unknown`,
    runner: 'cursor',
    model: 'unknown',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  assert.equal(run.metrics.model, DEFAULT_CURSOR_MODEL);
});

test('runCreate rejects scripted scenario without dev feature flag', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  const previousScenarioFlag = process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
  t.after(() => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    if (previousScenarioFlag === undefined) delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
    else process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = previousScenarioFlag;
  });

  await assert.rejects(
    () =>
      runCreate(
        {
          flowType: 'dev',
          project: 'farmslot-farm',
          ticketOrPr: `scripted scenario ${Date.now()}`,
          mode: 'interactive',
          runner: 'scripted',
          scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 0 },
        },
        () => {},
      ),
    /FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1/,
  );
});

test('runCreate accepts scripted scenario when dev feature flag is enabled', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  const previousScenarioFlag = process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = '1';
  const created: string[] = [];
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    if (previousScenarioFlag === undefined) delete process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS;
    else process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = previousScenarioFlag;
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  const result = await runCreate(
    {
      flowType: 'dev',
      project: 'farmslot-farm',
      ticketOrPr: `scripted scenario ${Date.now()}`,
      mode: 'interactive',
      runner: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 0 },
    },
    () => {},
  );
  created.push(result.run.id);

  assert.equal(result.run.metrics.runner, 'scripted');
  assert.deepEqual(result.run.scripted, { mode: 'scenario', scenario: 'success', stepDelayMs: 0 });
});

test('runCreate rejects legacy fake runner spelling', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  t.after(() => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
  });

  await assert.rejects(
    () =>
      runCreate(
        {
          flowType: 'dev',
          project: 'farmslot-farm',
          ticketOrPr: `fake runner ${Date.now()}`,
          mode: 'interactive',
          runner: 'fake',
        },
        () => {},
      ),
    /runner 'fake' is no longer supported/,
  );
});

test('runCreate validates scripted commandRef against project config', async (t) => {
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const projectDir = mkdtempSync(path.join(projectsDir, 'run-test-scripted-'));
  const project = path.basename(projectDir);
  const templatesDir = path.join(projectDir, 'templates', 'worker');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      scripted: { commands: { smoke: { command: 'printf smoke', timeout_ms: 1000 } } },
    }),
    'utf-8',
  );
  writeFileSync(path.join(templatesDir, 'dev-interactive.md'), 'Scripted dev template\n', 'utf-8');
  const created: string[] = [];
  t.after(async () => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    invalidateProjectVarsCache(project);
    rmSync(projectDir, { recursive: true, force: true });
    for (const id of created.reverse()) {
      const run = getRun(id);
      if (!run) continue;
      updateRun(id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });

  await assert.rejects(
    () =>
      runCreate(
        {
          flowType: 'dev',
          project,
          ticketOrPr: 'scripted command missing',
          mode: 'interactive',
          runner: 'scripted',
          scripted: { mode: 'command', commandRef: 'missing' },
        },
        () => {},
      ),
    /commandRef 'missing' is not declared/,
  );

  const result = await runCreate(
    {
      flowType: 'dev',
      project,
      ticketOrPr: 'scripted command smoke',
      mode: 'interactive',
      runner: 'scripted',
      scripted: { mode: 'command', commandRef: 'smoke' },
    },
    () => {},
  );
  created.push(result.run.id);

  assert.deepEqual(result.run.scripted, { mode: 'command', commandRef: 'smoke' });
});

// ─── ADR-054 free-slot: gate resolution is fenced from a park ───

function gateParkRecord(
  runId: string,
  slotId: string,
  overrides: { slotFreedAt?: string; phase?: 'resources-stopping' | 'parked' } = {},
) {
  const at = '2026-09-05T00:00:00.000Z';
  return {
    version: 1 as const,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 1,
    machine: 'macwork',
    slotId,
    mode: 'release' as const,
    phase: overrides.phase ?? ('parked' as const),
    slotDisposition: 'freed' as const,
    ...(overrides.slotFreedAt ? { slotFreedAt: overrides.slotFreedAt } : {}),
    prePauseStatus: 'blocked' as const,
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' as const },
    resourceManifest: { capturedAt: at, resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped' as const, resources: [] },
    createdAt: at,
    updatedAt: at,
  };
}

/** A run sitting at a publication gate with the given park record. */
function gateParkedRun(
  t: { after: (fn: () => void | Promise<void>) => void },
  label: string,
  record: ReturnType<typeof gateParkRecord>,
) {
  const slotId = `test-gate-park-${label}-${Date.now()}`;
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-GATE-PARK-${label}`,
    runner: 'claude',
    slotId,
  });
  const decision: RunDecision = {
    id: `gate-park-${label}`,
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Approve package',
    actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
    createdAt: '2026-09-05T00:00:00.000Z',
  };
  updateRun(run.id, {
    status: 'blocked',
    decisions: [decision],
    park: { ...record, runId: run.id, slotId },
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', park: null });
    await deleteRun(run.id);
  });
  return { run, decision, slotId };
}

test('review curation freshness rejects before restore and after an awaited restore', async (t) => {
  const { run, decision, slotId } = gateParkedRun(
    t,
    'curation',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );
  const payload: ReviewGatePayload = {
    kind: 'review',
    repo: 'example/app',
    prNumber: 42,
    reviewMd: 'Original',
    lineComments: [],
    recommendation: 'COMMENT',
  };
  decision.type = 'engine_review_posting';
  decision.actions = [{ id: 'post', label: 'Post', style: 'primary' }];
  decision.payload = payload;
  updateRun(run.id, { decisions: [decision] });
  let restores = 0;
  const dependencies = {
    restoreGatePark: async (runId: string) => {
      restores++;
      const fresh = getRun(runId)!;
      updateRun(runId, {
        park: { ...fresh.park!, phase: 'restored' as const, slotFreedAt: undefined },
        decisions: fresh.decisions.map((entry) => ({
          ...entry,
          payload: { ...payload, reviewMd: 'Refreshed' },
        })),
      });
      return {
        ok: true as const,
        runId,
        slotId,
        restoredGeneration: 1,
        reloadedSessionId: 'test',
        gateReplayed: false,
        record: getRun(runId)!.park!,
      };
    },
  };
  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'post',
        selectionData: { reviewFingerprint: 'stale', includedIndices: [] },
      },
      () => {},
      dependencies,
    ),
    /Review changed/,
  );
  assert.equal(restores, 0);
  assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'post',
        selectionData: { ...createReviewCuration(payload) },
      },
      () => {},
      dependencies,
    ),
    /Review changed/,
  );
  assert.equal(restores, 1);
  assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
});

test('runResolveDecision refuses and leaves the gate pending while a park is in flight', async (t) => {
  // Still stopping its resources: there is no coherent state to restore into
  // yet, and the effects are landing right now.
  const { run, decision, slotId } = gateParkedRun(
    t,
    'in-flight',
    gateParkRecord('x', 's', { phase: 'resources-stopping' }),
  );

  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
      () => {},
    ),
    (error: unknown) => {
      assert.equal((error as GatewayMethodError).code, 'GATE_PARK_IN_FLIGHT');
      return true;
    },
  );

  // The refusal happens before the decision is consumed, so the operator can
  // still answer it after a restore and the park record is not stranded.
  const persisted = getRun(run.id)!;
  assert.equal(persisted.decisions[0]?.resolvedAt, undefined);
  assert.equal(persisted.status, 'blocked');
  assert.equal(persisted.park?.slotId, slotId);
});

test('runResolveDecision restores a landed gate park before it consumes the decision', async (t) => {
  const { run, decision, slotId } = gateParkedRun(
    t,
    'restore-first',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );
  const order: string[] = [];

  const result = await runResolveDecision(
    { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
    () => {},
    {
      restoreGatePark: async (runId) => {
        order.push('restore');
        // The restore's own effect: the record no longer advertises a freed slot.
        const parked = getRun(runId)!.park!;
        updateRun(runId, { park: { ...parked, phase: 'restored', slotFreedAt: undefined } });
        return {
          ok: true,
          runId,
          slotId,
          restoredGeneration: 1,
          reloadedSessionId: 'session-restored',
          gateReplayed: false,
          record: getRun(runId)!.park!,
        };
      },
    },
  );

  order.push('resolved');
  assert.deepEqual(order, ['restore', 'resolved'], 'the restore runs first, every time');
  assert.deepEqual(result.gateParkRestore, {
    runId: run.id,
    slotId,
    restoredGeneration: 1,
    reloadedSessionId: 'session-restored',
  });
  assert.ok(
    getRun(run.id)!.decisions[0]?.resolvedAt,
    'the decision was consumed after the restore',
  );
});

test('runResolveDecision restores a half-finished restore rather than reading its occupancy', async (t) => {
  // The slot is bound and the worker is running, so every occupancy reader says
  // this run is healthy — but the reload was never acknowledged, and consuming
  // the gate there drives the engine against a worker that never confirmed it
  // came back.
  const { run, decision, slotId } = gateParkedRun(
    t,
    'half-restored',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );
  const parked = getRun(run.id)!.park!;
  updateRun(run.id, {
    park: {
      ...parked,
      slotReboundAt: '2026-09-05T00:00:20.000Z',
      restoreProgress: {
        operationId: 'restore-1',
        attempting: 'reload',
        completed: ['rebind', 'reattach', 'reacquire'],
        updatedAt: '2026-09-05T00:00:20.000Z',
      },
    },
  });
  let restores = 0;

  const result = await runResolveDecision(
    { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
    () => {},
    {
      restoreGatePark: async (runId) => {
        restores += 1;
        const current = getRun(runId)!.park!;
        updateRun(runId, {
          park: { ...current, phase: 'restored', slotFreedAt: undefined },
        });
        return {
          ok: true,
          runId,
          slotId,
          restoredGeneration: 1,
          reloadedSessionId: 'session-restored',
          gateReplayed: false,
          record: getRun(runId)!.park!,
        };
      },
    },
  );

  assert.equal(restores, 1, 'the unfinished restore is re-run, not skipped');
  assert.equal(result.gateParkRestore?.reloadedSessionId, 'session-restored');
  assert.ok(getRun(run.id)!.decisions[0]?.resolvedAt);
});

test('runResolveDecision validates the request before it buys a restore', async (t) => {
  // Restoring is a slot claim, a checkout, a resource boot, and a runner
  // relaunch — minutes of real effects on a real machine. A request that was
  // never going to be accepted must not buy any of them.
  const { run, decision } = gateParkedRun(
    t,
    'validate-first',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );
  let restores = 0;

  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: decision.id, actionId: 'approve-publsh' },
      () => {},
      {
        restoreGatePark: async () => {
          restores += 1;
          throw new Error('unreachable');
        },
      },
    ),
    /Action not found/,
  );

  assert.equal(restores, 0, 'a typo never restores the run');
  assert.equal(getRun(run.id)!.decisions[0]?.resolvedAt, undefined);
});

test('runResolveDecision reports the slot a re-homed restore actually used', async (t) => {
  const { run, decision } = gateParkedRun(
    t,
    'restore-rehomed',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );

  const result = await runResolveDecision(
    { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
    () => {},
    {
      restoreGatePark: async (runId) => {
        const parked = getRun(runId)!.park!;
        // A successor held the original, so the restore re-homed the run. The
        // record's own slot moved with it, which is what the gate answer must
        // report — telling the operator the old slot would send them to a pane
        // that belongs to someone else.
        updateRun(runId, {
          slotId: 'macwork-ff-3',
          park: {
            ...parked,
            slotId: 'macwork-ff-3',
            phase: 'restored',
            slotFreedAt: undefined,
            rehome: {
              fromSlotId: parked.slotId,
              toSlotId: 'macwork-ff-3',
              at: '2026-09-05T00:00:20.000Z',
              reason: 'taken by run-successor',
            },
          },
        });
        return {
          ok: true,
          runId,
          slotId: 'macwork-ff-3',
          restoredGeneration: 1,
          reloadedSessionId: 'session-restored',
          gateReplayed: false,
          record: getRun(runId)!.park!,
        };
      },
    },
  );

  assert.equal(result.gateParkRestore?.slotId, 'macwork-ff-3');
  assert.ok(
    getRun(run.id)!.decisions[0]?.resolvedAt,
    'the decision was consumed after the restore',
  );
});

test('a refused re-home tells the operator what will actually clear it', async (t) => {
  const refusals = [
    {
      code: 'RESTORE_NO_REHOME_TARGET',
      // "Wait for the slot" is wrong advice here: the gateway already looked at
      // every other slot on the machine and found none it could use.
      action: /Free a slot on this machine/,
    },
    {
      code: 'RESTORE_REHOME_SESSION_NOT_PORTABLE',
      // And wrong differently here: no other slot will ever do, because the
      // runner cannot carry its session out of the workspace it recorded it in.
      action: /can only resume its session in macwork-ff-1/,
    },
  ];
  for (const refusal of refusals) {
    const { run, decision } = gateParkedRun(
      t,
      `rehome-refused-${refusal.code}`,
      gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
    );
    await assert.rejects(
      runResolveDecision(
        { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
        () => {},
        {
          restoreGatePark: async (runId) => ({
            ok: false,
            runId,
            slotId: 'macwork-ff-1',
            code: refusal.code,
            reason: 'no eligible slot',
            record: getRun(runId)!.park!,
          }),
        },
      ),
      (error: unknown) => {
        assert.equal((error as GatewayMethodError).code, refusal.code);
        assert.match(String((error as GatewayMethodError).userAction ?? ''), refusal.action);
        return true;
      },
    );
    assert.equal(getRun(run.id)!.decisions[0]?.resolvedAt, undefined);
  }
});

test('runResolveDecision leaves the gate pending when the restore is refused', async (t) => {
  const { run, decision } = gateParkedRun(
    t,
    'restore-refused',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );

  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
      () => {},
      {
        restoreGatePark: async (runId) => ({
          ok: false,
          runId,
          slotId: 'macwork-ff-1',
          code: 'RESTORE_SLOT_TAKEN',
          reason: "slot 'macwork-ff-1' is now owned by run 'run-successor'",
          record: getRun(runId)!.park!,
        }),
      },
    ),
    (error: unknown) => {
      assert.equal((error as GatewayMethodError).code, 'RESTORE_SLOT_TAKEN');
      assert.match((error as Error).message, /run-successor/);
      return true;
    },
  );

  // A refused restore is not a failed run and not a lost answer: the decision
  // is still there to answer once the slot comes back.
  const persisted = getRun(run.id)!;
  assert.equal(persisted.decisions[0]?.resolvedAt, undefined);
  assert.equal(persisted.status, 'blocked');
  assert.ok(persisted.park?.slotFreedAt, 'the record is still parked and still freed');
});

test('runResolveDecision refuses to consume a decision the restore replaced by replaying the gate', async (t) => {
  const { run, decision, slotId } = gateParkedRun(
    t,
    'restore-replayed',
    gateParkRecord('x', 's', { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
  );

  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
      () => {},
      {
        restoreGatePark: async (runId) => {
          const parked = getRun(runId)!.park!;
          updateRun(runId, { park: { ...parked, phase: 'restored', slotFreedAt: undefined } });
          return {
            ok: true,
            runId,
            slotId,
            restoredGeneration: 2,
            reloadedSessionId: 'session-restored',
            gateReplayed: true,
            record: getRun(runId)!.park!,
          };
        },
      },
    ),
    (error: unknown) => {
      assert.equal((error as GatewayMethodError).code, 'RESTORE_GATE_REPLAYED');
      return true;
    },
  );

  // Consuming it would resolve a decision nothing is waiting on and leave the
  // freshly presented gate unanswered.
  assert.equal(getRun(run.id)!.decisions[0]?.resolvedAt, undefined);
});

test('runResolveDecision refuses a park that landed during its awaited probes', async (t) => {
  const slotId = `test-gate-park-race-${Date.now()}`;
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-GATE-PARK-RACE-${Date.now()}`,
    runner: 'claude',
    slotId,
  });
  const decision: RunDecision = {
    id: 'gate-park-race',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Approve package',
    actions: [{ id: 'request-review', label: 'Request review', style: 'secondary' }],
    createdAt: '2026-09-05T00:00:00.000Z',
  };
  // A review whose normalization WOULD rewrite it. If the normalize write runs
  // before the consumption-point fence, this run is mutated by a resolve that
  // was then refused.
  const exhaustedReview = {
    reviewerSessionId: 'fixture-session-' + 'review-1',
    reviewedHeadSha: 'fixture-head',
    mode: 'cold' as const,
    id: 'review-1',
    source: 'human-gate' as const,
    loopNumber: 1,
    verdict: 'issues' as const,
    unresolvedCount: 1,
    issues: [{ file: 'src/example.ts', description: 'Fix this' }],
    feedbackSent: true,
    attempts: [
      { mode: 'cold' as const, loopNumber: 1, verdict: 'issues' as const, unresolvedCount: 1 },
    ],
  };
  // Starts UNPARKED, so the entry check passes and only the re-check can catch it.
  updateRun(run.id, {
    status: 'blocked',
    decisions: [decision],
    engineState: { publishGate: { reviews: [exhaustedReview] } },
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', park: null });
    await deleteRun(run.id);
  });

  await assert.rejects(
    runResolveDecision(
      {
        selectionData: {
          reviewRequest: { runner: 'claude', model: null, effort: null, mode: 'cold' },
        },
        runId: run.id,
        decisionId: decision.id,
        actionId: 'request-review',
      },
      () => {},
      {
        // The park lands inside an awaited probe — the window the entry check
        // cannot see, because it read the run before this ran.
        assertReviewLaunchAllowed: async () => {
          updateRun(run.id, {
            park: {
              ...gateParkRecord(run.id, slotId, { phase: 'resources-stopping' }),
              runId: run.id,
              slotId,
            },
          });
        },
      },
    ),
    (error: unknown) => {
      assert.equal((error as GatewayMethodError).code, 'GATE_PARK_IN_FLIGHT');
      return true;
    },
  );

  const persisted = getRun(run.id)!;
  assert.equal(persisted.decisions[0]?.resolvedAt, undefined);
  assert.equal(persisted.status, 'blocked');
  // Nothing this refused resolve touched may have persisted, including the
  // review normalization that runs alongside the launch assertion.
  const stored = persisted.engineState?.publishGate?.reviews?.[0];
  assert.equal(stored?.feedbackSent, true, 'a refused resolve must not normalize reviews');
  assert.equal(stored?.recoveryContinuationPending, undefined);
});

test('the post-resolve resume timer does not restart a gate-parked run', async (t) => {
  const slotId = `test-gate-park-resume-${Date.now()}`;
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-GATE-PARK-RESUME-${Date.now()}`,
    runner: 'claude',
    slotId,
  });
  const decision: RunDecision = {
    id: 'gate-park-resume',
    type: 'engine_human_gate',
    title: 'Publication gate',
    description: 'Approve package',
    actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
    createdAt: '2026-09-05T00:00:00.000Z',
  };
  // Starts UNPARKED so the resolve succeeds and actually schedules the timer.
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  const { updateRunStep } = await import('../runs/store.js');
  updateRunStep(run.id, 'finalize', { status: 'running' });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', park: null });
    await deleteRun(run.id);
  });

  const beforeSteps = JSON.stringify(getRun(run.id)!.steps);

  // The park lands after the resolve and before the timer's tick — the window
  // the timer reads the run in. `emit` runs synchronously at the end of the
  // resolve, so this is exactly that gap.
  await runResolveDecision(
    { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
    () => {
      if (getRun(run.id)?.park) return;
      updateRun(run.id, {
        status: 'blocked',
        park: {
          ...gateParkRecord(run.id, slotId, { slotFreedAt: '2026-09-05T00:00:10.000Z' }),
          runId: run.id,
          slotId,
        },
      });
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = getRun(run.id)!;
  // Resuming would reset the stale step and re-enter FINALIZE against a slot a
  // successor may already own.
  assert.equal(after.status, 'blocked');
  assert.equal(JSON.stringify(after.steps), beforeSteps, 'no step was reset for a resume');
});

test('runResolveDecision binds only an owned completed triage of the current failure', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'triage-decision-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-TRIAGE-DECISION',
  });
  const decision: RunDecision = {
    id: 'triage-resolution',
    type: 'blocked_alert',
    title: 'Failed step',
    description: 'Select a recovery action',
    actions: [{ id: 'continue', label: 'Continue', style: 'primary' }],
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, {
    status: 'done',
    decisions: [decision],
    steps: [{ name: 'VALIDATE', status: 'failed', detail: 'fixture' }],
  });
  const alice = {
    id: 'triage-operator',
    subject: { type: 'person' as const, displayName: 'Triage operator' },
    roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
  };
  const sourceHash = 'a'.repeat(64);
  const packetHash = 'd'.repeat(64);
  const questionHash = 'e'.repeat(64);
  const sources = [{ id: 'e1', sourceId: 'fixture-source', digest: 'f'.repeat(64) }];
  const price = {
    version: 1 as const,
    provider: 'typesafe',
    model: 'jev-fixture',
    verifiedAt: new Date().toISOString(),
    source: 'https://example.invalid/price',
    inputUsdPerMillion: 0.01,
    outputUsdPerMillion: 0,
    maxRequestTokens: 1000,
  };
  const hash = digest({
    source: sourceHash,
    packet: packetHash,
    questions: questionHash,
    provider: price.provider,
    model: price.model,
    rubric: 'failure-triage-v1',
  });
  let counter = 0;
  async function assessment(
    ownerId: string,
    subjectRunId = run.id,
    step = 'VALIDATE',
    withEvidence = true,
  ) {
    const reserved = await reserveAssessment(
      {
        ownerId,
        consumer: 'failure-triage',
        subject: {
          run: { id: subjectRunId, project: run.project, step, snapshotHash: hash, sources },
        },
        requestedIdentity: {
          provider: price.provider,
          model: price.model,
          inputDigest: packetHash,
          questionSchemaHash: questionHash,
        },
        policyVersion: 'failure-triage-v1',
      },
      {
        key: String(++counter).padStart(64, '0'),
        priceHash: 'c'.repeat(64),
        maxUsd: 0.01,
        price,
      },
      { maxCalls: 10, maxUsd: 0.1 },
    );
    assert.equal(reserved.status, 'reserved');
    if (reserved.status !== 'reserved') throw new Error('Fixture reservation refused');
    await finishAssessment(reserved.record, {
      status: 'completed',
      answers: {
        cause: { type: 'choice', choice: 'environment', choices: ['environment'] },
        ...(withEvidence
          ? { evidence: { type: 'choice' as const, choice: 'e1', choices: ['e1'] } }
          : {}),
      },
    });
    return reserved.record.id;
  }
  const own = await assessment(alice.id);
  const noEvidence = await assessment(alice.id, run.id, 'VALIDATE', false);
  const otherOwner = await assessment('other-operator');
  const otherRun = await assessment(alice.id, 'other-run');
  const otherStep = await assessment(alice.id, run.id, 'OTHER');
  let snapshotHash = sourceHash;
  let probes = 0;
  const dependencies = {
    triageSnapshot: async (runId: string, step: string, originalPrice: typeof price) => {
      probes++;
      assert.equal(runId, run.id);
      assert.equal(step, 'VALIDATE');
      assert.deepEqual(originalPrice, price);
      return { snapshotHash, sources };
    },
  };
  t.after(async () => {
    if (getRun(run.id)) await deleteRun(run.id);
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  async function resolve(triageAssessmentId: string) {
    return runWithSessionOriginator(alice, () =>
      runResolveDecision(
        { runId: run.id, decisionId: decision.id, actionId: 'continue', triageAssessmentId },
        () => {},
        dependencies,
      ),
    );
  }
  await assert.rejects(resolve(noEvidence), /completed failure-triage assessment/);
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
  for (const [id, reason] of [
    [otherOwner, /not found or expired/],
    [otherRun, /this run and failed step/],
    [otherStep, /this run and failed step/],
  ] as const) {
    await assert.rejects(resolve(id), reason);
    assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
  }
  const incomplete = await beginAssessment({
    ownerId: alice.id,
    consumer: 'failure-triage',
    subject: { run: { id: run.id, project: run.project, step: 'VALIDATE', snapshotHash: hash } },
  });
  await assert.rejects(resolve(incomplete.id), /completed failure-triage assessment/);
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
  snapshotHash = 'b'.repeat(64);
  await assert.rejects(resolve(own), /stale/);
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
  snapshotHash = sourceHash;
  probes = 0;
  const changing = {
    ...dependencies,
    triageSnapshot: async (runId: string, step: string, originalPrice: typeof price) => {
      const snapshot = await dependencies.triageSnapshot(runId, step, originalPrice);
      return { ...snapshot, snapshotHash: probes === 1 ? sourceHash : 'c'.repeat(64) };
    },
  };
  await assert.rejects(
    runWithSessionOriginator(alice, () =>
      runResolveDecision(
        { runId: run.id, decisionId: decision.id, actionId: 'continue', triageAssessmentId: own },
        () => {},
        changing,
      ),
    ),
    /stale/,
  );
  assert.equal(probes, 2, 'second check observes a changed snapshot');
  assert.equal(getRun(run.id)?.decisions[0]?.resolvedAt, undefined);
  probes = 0;
  const accepted = await resolve(own);
  assert.ok(probes >= 2, 'revalidates after awaited gate probes');
  assert.equal(accepted.run.decisions[0]?.triageAssessmentId, own);
  assert.equal(accepted.run.decisions[0]?.resolvedAction, 'continue');
  assert.equal(getRun(run.id)?.decisions[0]?.triageAssessmentId, own);
  assert.deepEqual(
    buildRunResolveDecisionParams({
      runId: run.id,
      decision,
      actionId: 'continue',
      triageAssessmentId: own,
    }),
    { runId: run.id, decisionId: decision.id, actionId: 'continue', triageAssessmentId: own },
  );
});

for (const interruption of ['cancelled', 'paused', 'replay', 'package-refresh'] as const) {
  test(`gate advancement preserves its pending decision after ${interruption} during validation`, async (t) => {
    const run = createRun({
      flowType: 'dev',
      mode: 'interactive',
      project: 'gate-fence',
      ticketOrPr: 'GATE-CONSUMPTION-FENCE',
      runner: 'scripted',
    });
    const decision: RunDecision = {
      id: 'no-change-fence',
      type: 'engine_no_change',
      title: 'No change',
      description: '',
      actions: [{ id: 'accept-no-change', label: 'Accept', style: 'primary' }],
      createdAt: new Date().toISOString(),
      payload: { kind: 'no-change', disposition: 'already_fixed' },
    };
    updateRun(run.id, {
      status: 'human-gating',
      decisions: [decision],
      engineState: { generation: 2 },
    });
    t.after(async () => {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    });
    await assert.rejects(
      runResolveDecision(
        { runId: run.id, decisionId: decision.id, actionId: 'accept-no-change' },
        () => {},
        {
          assertGatePrerequisites: async () => {
            if (interruption === 'replay') updateRun(run.id, { engineState: { generation: 3 } });
            else if (interruption === 'package-refresh')
              updateRun(run.id, {
                decisions: [{ ...decision, payload: { ...decision.payload! } }],
              });
            else updateRun(run.id, { status: interruption });
          },
        },
      ),
      /changed during validation/,
    );
    assert.equal(getRun(run.id)!.decisions[0].resolvedAt, undefined);
  });
}

test('resolver-less human-gating approval re-enters its persisted gate after restart', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'gate-restart',
    ticketOrPr: 'GATE-RESTART',
  });
  const decision: RunDecision = {
    id: 'restart-gate',
    type: 'engine_human_gate',
    title: 'Recovered gate',
    description: '',
    createdAt: new Date().toISOString(),
    actions: [{ id: 'ready', label: 'Ready', style: 'primary' }],
    payload: { kind: 'no-change', disposition: 'already_fixed' },
  };
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [decision],
    steps: [{ name: 'human-gate', status: 'running' }],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  let resumed!: () => void;
  const continuation = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  await runResolveDecision(
    { runId: run.id, decisionId: decision.id, actionId: 'ready' },
    () => {},
    {
      assertGatePrerequisites: async () => {},
      resumeRun: async () => {
        resumed();
      },
    },
  );
  await continuation;
  assert.equal(getRun(run.id)!.status, 'created');
  assert.equal(getRun(run.id)!.steps[0].status, 'pending');
});

test('a live gate resolver retains its continuation without starting a second loop', async (t) => {
  const { createEngineDecision, setEngineDecisionRuntime } =
    await import('../run-engine/engine-decisions.js');
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'gate-live',
    ticketOrPr: 'GATE-LIVE',
  });
  updateRun(run.id, { status: 'human-gating', steps: [{ name: 'human-gate', status: 'running' }] });
  let published!: () => void;
  const publication = new Promise<void>((resolve) => {
    published = resolve;
  });
  setEngineDecisionRuntime({
    broadcast: (event) => {
      if (event === 'run.decision.new') published();
    },
    stepToStatus: { 'human-gate': 'human-gating' },
  });
  t.after(async () => {
    setEngineDecisionRuntime({ broadcast: () => {}, stepToStatus: {} });
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  const waiting = createEngineDecision(
    run.id,
    'human_gate',
    'Live gate',
    [{ id: 'hold', label: 'Hold', style: 'secondary' }],
    undefined,
    { readProgress: async () => ({ kind: 'idle' }) },
  );
  await publication;
  let resumes = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const decision = getRun(run.id)!.decisions[0];
  await runResolveDecision({ runId: run.id, decisionId: decision.id, actionId: 'hold' }, () => {}, {
    resumeRun: async () => {
      resumes++;
    },
  });
  assert.equal(await waiting, 'hold');
  t.mock.timers.tick(1);
  assert.equal(resumes, 0);
  assert.equal(getRun(run.id)!.steps[0].status, 'running');
});

test('refused publication approval stays pending without restoring, replaying or resuming a fix', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'approval-refusal',
    ticketOrPr: 'APPROVAL-REFUSAL',
    runner: 'scripted',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled' });
    await deleteRun(run.id);
  });
  const decision: RunDecision = {
    id: 'approval-refused',
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    createdAt: '2026-10-15T00:00:00Z',
    actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      branch: 'fix/subject',
      workerReport: 'Proof retained',
      diffStat: { files: 1, additions: 1, deletions: 0 },
    },
  };
  updateRun(run.id, {
    status: 'human-gating',
    decisions: [decision],
    steps: [
      { name: 'human-gate', status: 'running' },
      { name: 'finalize', status: 'pending' },
    ],
    engineState: {
      generation: 4,
      publishGate: {
        reviewSequence: [{ runner: 'grok', model: null, effort: null, mode: 'cold' }],
      },
    },
  });
  const before = structuredClone(getRun(run.id)!);
  const effects: string[] = [];
  await assert.rejects(
    runResolveDecision(
      { runId: run.id, decisionId: decision.id, actionId: 'approve-publish' },
      () => effects.push('broadcast'),
      {
        assertGatePrerequisites: async () => {
          throw new Error(
            'Review budget 5/5 exhausted; extend-review-budget then request current-head reviews',
          );
        },
        restoreGatePark: async () => assert.fail('refusal cannot restore a worker'),
        resumeRun: async () => {
          effects.push('resume');
        },
      },
    ),
    /Review budget 5\/5 exhausted; extend-review-budget/,
  );
  assert.deepEqual(effects, []);
  assert.deepEqual(getRun(run.id), before);
});

test('real packaged approval restores a parked run before reading a reused slot checkout', async (t) => {
  const projectDir = mkdtempSync(path.join(projectsDir, 'parked-package-'));
  const project = path.basename(projectDir);
  writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, default_branch: 'main', hooks: {} }),
  );
  invalidateProjectVarsCache();
  t.after(() => {
    rmSync(projectDir, { recursive: true, force: true });
    invalidateProjectVarsCache();
  });
  const root = mkdtempSync(path.join(tmpdir(), 'parked-publication-source-'));
  const poolFile = path.join(farmslotRoot, 'pool', `parked-approval-${randomUUID()}.json`);
  const oldRepo = path.join(root, 'foreign');
  const ownedRepo = path.join(root, 'owned');
  for (const repo of [oldRepo, ownedRepo]) {
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'owned-change'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        repo,
      ],
      { cwd: repo },
    );
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ownedRepo,
    encoding: 'utf8',
  }).trim();
  const task = path.join(root, 'task');
  mkdirSync(path.join(task, 'artifacts'), { recursive: true });
  writeFileSync(path.join(task, 'TASK.md'), '# Retained package');
  const oldSlot = 'reused-' + randomUUID();
  const ownedSlot = 'restored-' + randomUUID();
  writeFileSync(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      host: 'localhost',
      ssh_user: userInfo().username,
      os: 'darwin',
      project,
      platform: 'cli',
      slots: [
        { id: oldSlot, enabled: true, repo: oldRepo, session: oldSlot },
        { id: ownedSlot, enabled: true, repo: ownedRepo, session: ownedSlot },
      ],
    }),
  );
  const pkg = makeReadyGatePackage({
    headSha: head,
    branch: 'owned-change',
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  writeFileSync(path.join(task, 'artifacts/pr-package.json'), JSON.stringify(pkg));
  const { run, decision } = gateParkedRun(
    t,
    'real-package-rehome',
    gateParkRecord('x', oldSlot, { slotFreedAt: '2026-09-05T00:00:10Z' }),
  );
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(poolFile, { force: true });
  });
  decision.actions = [
    { id: 'approve-publish-unresolved', label: 'Accept findings', style: 'danger' },
  ];
  decision.payload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    branch: pkg.branch,
    workerReport: '',
    diffStat: pkg.diffStat,
    prPackage: pkg,
  };
  updateRun(run.id, {
    project,
    slotId: oldSlot,
    branch: pkg.branch,
    taskFile: path.join(task, 'TASK.md'),
    ticketData: manualTicketData('Restore a parked approval'),
    decisions: [decision],
  });
  await retainRunFixture(getRun(run.id)!, pkg);
  let restores = 0;
  const findings = [{ reviewId: 'review', file: 'src/a.ts', description: 'Accepted finding' }];
  await runWithSessionOriginator(acceptor, () =>
    runResolveDecision(
      {
        runId: run.id,
        decisionId: decision.id,
        actionId: 'approve-publish-unresolved',
        ...ACCEPTANCE,
        selectionData: {
          packageId: pkg.id,
          packageHash: pkg.packageHash,
          packageHeadSha: head,
          selectedEvidenceKeys: [],
        },
      },
      () => {},
      {
        ...acceptorAuthority,
        assertGatePrerequisites: async (current) => ({
          state: 'not-ready' as const,
          identity: {
            runId: run.id,
            generation: current.engineState?.generation ?? 0,
            packageHash: pkg.packageHash,
          },
          reasons: [
            {
              code: 'review-fix-required',
              prerequisite: 'review' as const,
              message: 'Review rounds spent: 1 issue open',
              allowedReviewOverrides: ['approve-publish-unresolved'],
            },
          ],
          findings,
          findingsDigest: ACCEPTANCE.findingsDigest,
        }),
        resumeRun: async () => {},
        restoreGatePark: async () => {
          restores++;
          const park = getRun(run.id)!.park!;
          updateRun(run.id, {
            slotId: ownedSlot,
            park: { ...park, slotId: ownedSlot, phase: 'restored', slotFreedAt: undefined },
          });
          return {
            ok: true,
            runId: run.id,
            slotId: ownedSlot,
            restoredGeneration: 1,
            reloadedSessionId: 'retained',
            gateReplayed: false,
            record: getRun(run.id)!.park!,
          };
        },
      },
    ),
  );
  assert.equal(restores, 1);
  assert.equal(getRun(run.id)!.decisions[0].resolvedAction, 'approve-publish-unresolved');
  assert.deepEqual(getRun(run.id)!.decisions[0].publicationApproval?.acceptedFindings, {
    findings,
    digest: ACCEPTANCE.findingsDigest,
  });
  assert.equal(getRun(run.id)!.engineState?.publishGate?.publicationStatus, 'pending_publish');
  assert.equal(getRun(run.id)!.engineState?.publishGate?.approvedPackageHash, pkg.packageHash);
  const { loadAllRuns } = await import('../runs/store.js');
  const { ensureCurrentPublishPackage } = await import('../run-engine/publish-package-refresh.js');
  await loadAllRuns();
  const reloaded = getRun(run.id)!;
  assert.equal(reloaded.decisions[0].resolvedAction, 'approve-publish-unresolved');
  assert.equal(reloaded.engineState?.publishGate?.publicationStatus, 'pending_publish');
  assert.equal((await ensureCurrentPublishPackage(run.id))?.packageHash, pkg.packageHash);
});
