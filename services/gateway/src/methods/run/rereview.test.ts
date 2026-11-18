import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

import type { Run, RunCreateParams } from '@farmslot/protocol';

import * as github from '../../external/github.js';
import type { RunRecordBuildOptions } from '../../runs/store.js';

import { makeRun } from './test-fixtures.js';

const priorHead = '5f85b47bfa4f7d8ec1888605f0cd2f025fffb804';
const liveHead = 'da6b612ef57bc81a6c14bc873810b66ee0720eb0';
const runs = new Map<string, Run>();
let releaseMetadata: () => void = () => {};
let metadataCalls = 0;
let holdMetadata = false;
let ancestryCalls = 0;
let ancestor = true;
let holdHistory = false;
let historyCalls = 0;
let releaseHistory: () => void = () => {};
let liveSlotAvailable = true;
const creationOptions: Array<RunRecordBuildOptions | undefined> = [];

const prior: Run = {
  ...makeRun(),
  id: 'prior-review',
  familyId: 'family-1',
  familyRootTicketOrPr: 'owner/repo#42',
  lane: 'production',
  flowType: 'review-pr',
  status: 'blocked',
  project: 'farm-a',
  ticketOrPr: 'owner/repo#42',
  slotId: 'slot-1',
  steps: [],
  decisions: [],
  metrics: { ...makeRun().metrics, runner: 'codex', model: 'gpt-6-astra' },
  effort: 'high',
  agentContexts: [
    {
      id: 'review-context',
      reviewId: 'review-lineage',
      role: 'review',
      label: 'Review',
      runId: 'prior-review',
      slotId: 'slot-1',
      runner: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      status: 'complete',
      reviewResultValidatedAt: 'validated',
      runnerSessionCapturedAt: 'captured',
      runnerSessionId: 'prior-session',
      runnerSessionPath: '/tmp/reviewer.jsonl',
      target: { session: 'slot-1', window: 'review-window', target: 'slot-1:review-window' },
    },
  ],
  reviewResult: {
    recommendation: 'request changes',
    reviewMd: 'review.md',
    session: {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: 'review-lineage',
      sessionId: 'prior-session',
      repository: 'owner/repo',
      prNumber: 42,
      lastReviewedHeadSha: priorHead,
    },
    lineComments: [{ path: 'src/a.ts', line: 7, body: 'Fix this.', severity: 'blocker' }],
    reviewSnapshot: {
      source: 'github-pr',
      capturedAt: '2026-10-05T09:00:00.000Z',
      headSha: priorHead,
    },
  },
  createdAt: '2026-10-05T09:00:00.000Z',
};
runs.set(prior.id, prior);

mock.module('../../external/github.js', {
  namedExports: {
    ...github,
    fetchGitHubPR: async () => {
      metadataCalls += 1;
      if (holdMetadata)
        await new Promise<void>((resolve) => {
          const previous = releaseMetadata;
          releaseMetadata = () => {
            previous();
            resolve();
          };
        });
      return { headSha: liveHead, baseSha: 'b'.repeat(40), number: 42 };
    },
    isGitHubAncestor: async () => {
      ancestryCalls += 1;
      return ancestor;
    },
  },
});
// Load the rest only after the GitHub mock, so engine-decisions binds the mocked lookup.
const fleet = await import('../../fleet/state.js');
const store = await import('../../runs/store.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfig: async () => ({ ci: { repo: 'owner/repo' } }),
    loadFleetStatus: async () => ({
      slots: liveSlotAvailable
        ? [
            {
              slot: 'slot-1',
              agent: 'working',
              agentContexts: [{ runId: prior.id, role: 'review' }],
            },
          ]
        : [],
    }),
  },
});
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
    persistRunNow: async () => {},
    getRun: (id: string) => runs.get(id),
    getAllRuns: () => [...runs.values()],
    getAllRunsWithArchived: async () => {
      historyCalls += 1;
      if (holdHistory)
        await new Promise<void>((resolve) => {
          const previous = releaseHistory;
          releaseHistory = () => {
            previous();
            resolve();
          };
        });
      return [...runs.values()];
    },
    listRuns: () => ({ runs: [...runs.values()] }),
    createRun: (params: RunCreateParams, options?: RunRecordBuildOptions) => {
      creationOptions.push(options);
      assertPrimaryReviewContext(params);
      const run: Run = {
        ...makeRun({
          id: `child-${runs.size}`,
          project: params.project,
          flowType: params.flowType,
          ticketOrPr: params.ticketOrPr,
          familyId: params.familyId,
          parentRunId: params.parentRunId,
          familyRootTicketOrPr: params.familyRootTicketOrPr,
          lane: params.lane,
          variant: params.variant,
          mode: params.mode,
        }),
        status: 'slot-finding',
        slotId: params.slotId ?? null,
        branch: params.branch ?? null,
        transport: params.transport,
        reviewWorkspaceTarget: params.reviewWorkspaceTarget,
        reviewMode: params.reviewMode,
        reviewContext: params.reviewContext,
        effort: params.effort,
        reviewAutoFinish: params.reviewAutoFinish,
        completionPolicy: params.completionPolicy,
        nativeOwnerPrincipalId: options?.delegatedReviewOwner,
        createdByPrincipalId: options?.delegatedReviewOwner,
        metrics: {
          ...makeRun().metrics,
          runner: params.runner ?? null,
          model: params.model ?? null,
        },
      };
      runs.set(run.id, run);
      return run;
    },
    updateRun: (id: string, patch: Partial<Run>) => {
      const run = { ...runs.get(id)!, ...patch };
      runs.set(id, run);
      return run;
    },
  },
});
const orchestrator = await import('../../run-engine/orchestrator.js');
mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    ...orchestrator,
    applyChainedRunEngineFlags: () => {},
    startRun: async () => {},
  },
});

const workspaceIntakeRuns: Run[] = [];
const intake = await import('../pr-rules.js');
mock.module('../pr-rules.js', {
  namedExports: {
    ...intake,
    submitRereviewRequest: async (run: Run) => {
      workspaceIntakeRuns.push(structuredClone(run));
      return {};
    },
  },
});

const owners = await import('../../security/native-worker-owner.js');
let denyWorkspaceOwner = false;
mock.module('../../security/native-worker-owner.js', {
  namedExports: {
    ...owners,
    assertNativeRunOwner: () => {
      if (denyWorkspaceOwner) throw new Error('Workspace owner refused');
    },
  },
});

const { runRereviewLatestHead } = await import('./rereview.js');
const { assertPrimaryReviewContext } = await import('../../run-engine/review-plan.js');
const { resetWarmReviewerSessionsForTest } = await import('../../review/session-mode.js');

beforeEach(() => {
  runs.clear();
  workspaceIntakeRuns.length = 0;
  denyWorkspaceOwner = false;
  creationOptions.length = 0;
  liveSlotAvailable = true;
  runs.set(prior.id, { ...prior });
  ancestryCalls = 0;
  ancestor = true;
  releaseMetadata = () => {};
  metadataCalls = 0;
  holdMetadata = false;
  holdHistory = false;
  historyCalls = 0;
  releaseHistory = () => {};
  resetWarmReviewerSessionsForTest();
});

test('a retried click during PR metadata lookup reuses the WARM child with its primary lineage', async () => {
  holdMetadata = true;
  const first = runRereviewLatestHead({ runId: prior.id });
  const second = runRereviewLatestHead({ runId: prior.id });
  while (metadataCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  const [a, b] = await Promise.all([first, second]);

  const children = [...runs.values()].filter((run) => run.parentRunId === prior.id);
  assert.equal(children.length, 1, 'one warm re-review per head');
  assert.equal(a.runId, children[0]!.id);
  assert.equal(b.runId, children[0]!.id);
  assert.equal(children[0]!.reviewMode, 'warm');
  assert.deepEqual(children[0]!.reviewContext, {
    reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'review-lineage' }],
  });
  assert.deepEqual(children[0]!.repeatReviewContext?.unresolvedFindings, [
    { file: 'src/a.ts', line: 7, description: 'Fix this.' },
  ]);
});

test('concurrent clicks waiting on archive history create only one WARM child', async () => {
  holdMetadata = true;
  holdHistory = true;
  const first = runRereviewLatestHead({ runId: prior.id });
  const second = runRereviewLatestHead({ runId: prior.id });
  while (metadataCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  while (historyCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseHistory();
  const results = await Promise.allSettled([first, second]);
  const children = [...runs.values()].filter((run) => run.parentRunId === prior.id);
  assert.equal(children.length, 1, 'archive I/O cannot separate duplicate check from creation');
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'fulfilled');
  assert(results[0].status === 'fulfilled' && results[1].status === 'fulfilled');
  assert.equal(results[0].value.runId, results[1].value.runId);
});

test('a standalone posting decision supplies retained provenance without a publication registry', async () => {
  holdMetadata = true;
  runs.set(prior.id, {
    ...prior,
    reviewResult: undefined,
    decisions: [
      {
        id: 'posting',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Head moved',
        actions: [],
        createdAt: prior.createdAt,
        payload: { ...prior.reviewResult!, kind: 'review', repo: 'owner/repo', prNumber: 42 },
      },
    ],
  });
  const click = runRereviewLatestHead({ runId: prior.id });
  while (metadataCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  const result = await click;
  assert.equal(result.mode, 'warm-handoff');
  assert.equal(
    runs.get(result.runId!)?.reviewContext?.reviewLineages[0]?.reviewId,
    'review-lineage',
  );
});

test('ambiguous standalone session evidence refuses before replacing the parent', async () => {
  holdMetadata = true;
  runs.set(prior.id, {
    ...prior,
    agentContexts: [
      ...prior.agentContexts!,
      { ...prior.agentContexts![0], id: 'other-context', runnerSessionId: 'other-session' },
    ],
    decisions: [
      {
        id: 'other-posting',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Head moved',
        actions: [],
        createdAt: prior.createdAt,
        payload: {
          ...prior.reviewResult!,
          kind: 'review',
          repo: 'owner/repo',
          prNumber: 42,
          session: { ...prior.reviewResult!.session!, sessionId: 'other-session' },
        },
      },
    ],
  });
  const click = runRereviewLatestHead({ runId: prior.id });
  const refused = assert.rejects(click, /ambiguous session provenance/);
  while (metadataCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  await refused;
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'blocked');
});

test('missing or ambiguous lineage preserves the parent without creating a child', async () => {
  const result = prior.reviewResult!;
  for (const state of [
    { reviewResult: { ...result, session: undefined } },
    { repeatReviewContext: { session: { ...result.session!, reviewId: 'review-other' } } },
  ]) {
    runs.set(prior.id, { ...prior, ...state } as Run);
    await assert.rejects(runRereviewLatestHead({ runId: prior.id }), /missing or ambiguous/);
    assert.equal(runs.size, 1);
    assert.equal(runs.get(prior.id)!.status, 'blocked');
  }
});

test('unavailable retained session refuses before superseding the parent', async () => {
  holdMetadata = true;
  resetWarmReviewerSessionsForTest();
  runs.set(prior.id, { ...prior, agentContexts: [] });
  const click = runRereviewLatestHead({ runId: prior.id });
  const refused = assert.rejects(click, /no verified retained session/);
  while (metadataCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  await refused;
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'blocked');
});

test('a rebased head creates a WARM candidate without an ancestry refusal', async () => {
  ancestor = false;
  holdMetadata = true;
  const click = runRereviewLatestHead({ runId: prior.id });
  while (metadataCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  const result = await click;
  assert.equal(result.mode, 'warm-handoff');
  assert.equal(runs.get(result.runId!)?.reviewMode, 'warm');
  assert.equal(ancestryCalls, 0, 'local immutable interdiff qualification owns rebase scope');
});

test('a parent cancelled during the PR metadata lookup gets no warm re-review', async () => {
  holdMetadata = true;
  for (const id of [...runs.keys()]) if (id !== prior.id) runs.delete(id);
  runs.set(prior.id, { ...prior, status: 'blocked' } as Run);
  metadataCalls = 0;
  const click = runRereviewLatestHead({ runId: prior.id });
  while (metadataCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  runs.set(prior.id, { ...runs.get(prior.id)!, status: 'cancelled' } as Run);
  releaseMetadata();
  await assert.rejects(click, /is cancelled/);
  assert.equal(
    [...runs.values()].filter((run) => run.parentRunId === prior.id).length,
    0,
    'a cancelled review starts no child',
  );
  assert.equal(runs.get(prior.id)!.status, 'cancelled');
});

function workspacePrior(): Run {
  return {
    ...prior,
    status: 'done',
    transport: 'tmux',
    nativeOwnerPrincipalId: 'review-owner',
    createdByPrincipalId: 'review-owner',
    slotId: null,
    reviewWorkspaceTarget: { machine: 'review-node' },
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
    },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://example.invalid/repo.git',
      headSha: priorHead,
      baseSha: 'b'.repeat(40),
      branch: 'feature',
      title: 'Fixture',
      body: '',
      capturedAt: '2026-11-06T01:00:00Z',
    },
    reviewAutoFinish: true,
    reviewResult: prior.reviewResult,
    agentContexts: [{ ...prior.agentContexts![0], id: 'review', slotId: null }],
  };
}

test('slotless rereview repairs retained lineage and starts directly without discovery filters', async () => {
  workspaceIntakeRuns.length = 0;
  const workspace = workspacePrior();
  runs.set(prior.id, {
    ...workspace,
    reviewResult: { ...workspace.reviewResult!, session: undefined },
  });
  const result = await runRereviewLatestHead({ runId: prior.id });
  assert.equal(result.mode, 'warm-handoff');
  assert.equal(workspaceIntakeRuns.length, 0);
  const child = runs.get(result.runId!)!;
  assert.equal(child.slotId, null);
  assert.deepEqual(child.reviewWorkspaceTarget, { machine: 'review-node' });
  assert.equal(child.transport, 'tmux');
  assert.equal(child.reviewMode, 'warm');
  assert.equal(child.reviewAutoFinish, false);
  assert.equal(child.parentRunId, prior.id);
  assert.equal(child.reviewContext?.reviewLineages[0]?.reviewId, 'review-lineage');
  assert.equal(creationOptions[0]?.delegatedReviewOwner, 'review-owner');
  assert.deepEqual(creationOptions[0]?.workflowExecution, {
    workspacePolicy: { kind: 'exact', machine: 'review-node' },
    transport: 'tmux',
    models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'warm' }],
  });
  assert.equal(runs.get(prior.id)!.reviewResult?.session?.sessionId, 'prior-session');
  assert.equal(runs.get(prior.id)!.reviewResult?.session?.reviewId, 'review-lineage');
  assert.equal(runs.get(prior.id)!.reviewResult?.session?.lastReviewedHeadSha, priorHead);
  assert.equal(
    ancestryCalls,
    0,
    'slotless continuation is validated by the workspace intake/launch path',
  );
});

test('concurrent workspace re-review clicks create one unpublished child', async () => {
  runs.set(prior.id, workspacePrior());
  holdMetadata = true;
  const a = runRereviewLatestHead({ runId: prior.id });
  const b = runRereviewLatestHead({ runId: prior.id });
  while (metadataCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseMetadata();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.runId, second.runId);
  assert.equal(runs.size, 2);
  assert.equal(workspaceIntakeRuns.length, 0);
  assert.equal(runs.get(first.runId!)!.reviewAutoFinish, false);
});

test('a foreign workspace owner cannot create a re-review or change its parent', async () => {
  runs.set(prior.id, workspacePrior());
  denyWorkspaceOwner = true;
  await assert.rejects(runRereviewLatestHead({ runId: prior.id }), /Workspace owner refused/);
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'done');
  assert.equal(metadataCalls, 0);
});

test('an unavailable workspace reviewer refuses before creating a child', async () => {
  runs.set(prior.id, { ...workspacePrior(), agentContexts: [] });
  await assert.rejects(
    runRereviewLatestHead({ runId: prior.id }),
    /verified retained workspace reviewer/,
  );
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'done');
  assert.equal(workspaceIntakeRuns.length, 0);
});

test('an inactive legacy slot still uses normal review intake', async () => {
  liveSlotAvailable = false;
  const result = await runRereviewLatestHead({ runId: prior.id });
  assert.equal(result.mode, 'review-intake');
  assert.equal(workspaceIntakeRuns.length, 1);
  assert.equal(runs.size, 1);
});

test('a workspace replay during metadata lookup keeps ownership and starts no child', async () => {
  runs.set(prior.id, workspacePrior());
  holdMetadata = true;
  const pending = runRereviewLatestHead({ runId: prior.id });
  while (!metadataCalls) await new Promise((resolve) => setImmediate(resolve));
  const current = runs.get(prior.id)!;
  runs.set(prior.id, { ...current, engineState: { ...current.engineState, generation: 1 } });
  releaseMetadata();
  await assert.rejects(pending, /changed during re-review admission/);
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'done');
});

test('a blocked workspace with a completed stopped reviewer creates a warm child', async () => {
  const source = workspacePrior();
  runs.set(prior.id, {
    ...source,
    status: 'blocked',
    reviewWorkspace: {
      ...source.reviewWorkspace!,
      retainedAt: '2026-11-18T00:00:00Z',
      executionStoppedAt: '2026-11-18T00:00:01Z',
    },
  });
  const result = await runRereviewLatestHead({ runId: prior.id });
  assert.equal(result.mode, 'warm-handoff');
  assert.equal(workspaceIntakeRuns.length, 0);
  assert.equal(runs.get(result.runId!)!.reviewMode, 'warm');
  assert.equal(runs.get(result.runId!)!.reviewAutoFinish, false);
  assert.equal(runs.get(prior.id)!.status, 'done');
});

test('a blocked workspace without confirmed execution stop retains its parent and creates no child', async () => {
  const source = workspacePrior();
  runs.set(prior.id, {
    ...source,
    status: 'blocked',
    reviewWorkspace: { ...source.reviewWorkspace!, retainedAt: '2026-11-18T00:00:00Z' },
  });
  await assert.rejects(
    runRereviewLatestHead({ runId: prior.id }),
    /verified retained workspace reviewer/,
  );
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'blocked');
});
