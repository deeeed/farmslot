import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { ReviewGatePayload, RunReviewResult } from '@farmslot/protocol';
import { ReviewApprovalPolicyError } from '@farmslot/protocol/review-approval-policy.cjs';

import '../runtime/mock-pty.test-support.js';

type Completion = Awaited<
  ReturnType<typeof import('../review-workspaces/task.js').readReviewWorkspaceCompletion>
>;
let latest: Completion | Error = null;
let completionReads = 0;
const unused = () => {
  throw new Error('Unexpected review operation');
};
mock.module('../review-workspaces/task.js', {
  namedExports: {
    reviewWorkspaceProgressLocation: async () => ({
      io: { host: 'localhost', machine: 'local', sshTarget: '' },
      taskDir: '/owned/task',
      checklistPath: '/owned/task/CHECKLIST.md',
    }),
    readReviewWorkspaceCompletion: async () => {
      completionReads++;
      if (latest instanceof Error) throw latest;
      return latest;
    },
    readReviewWorkspaceSignal: unused,
    materializeReviewWorkspaceTask: unused,
    resolveStaticReviewLineComments: unused,
    readReviewWorkspaceProgress: async () => null,
    refreshReviewWorkspaceView: unused,
    collectReviewWorkspaceSubtaskMetrics: unused,
  },
});
mock.module('./review-artifacts.js', {
  namedExports: {
    reviewCommitFromMarkdown: unused,
    reviewRecommendationFromMarkdown: unused,
    readFrozenPlanningContext: unused,
    buildReviewPlanningBrief: unused,
    copyWorkerArtifacts: async () => {},
    readReviewArtifacts: async () => {
      if (latest instanceof Error) throw latest;
      throw new Error('Unexpected primary read');
    },
  },
});
const root = await mkdtemp(path.join(os.tmpdir(), 'review-gate-policy-'));
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
const { createRun, deleteRun, getRun, persistRunNow, updateRun } = await import('../runs/store.js');
const { refreshReviewGate } = await import('./review-gate.js');
const { collectRunGateReadiness } = await import('./gate-prerequisites.js');
test.after(() => rm(root, { recursive: true, force: true }));

test('refresh invalidates stale APPROVE and then projects revised minor and major verdicts', async (t) => {
  const result: RunReviewResult = {
    recommendation: 'APPROVE',
    reviewMd: 'VERDICT: APPROVE',
    lineComments: [],
  };
  const run = createRun({
    flowType: 'review-pr',
    project: 'review-policy-fixture',
    ticketOrPr: 'example/project#1',
  });
  t.after(async () => {
    const current = getRun(run.id)!;
    await persistRunNow(
      updateRun(run.id, {
        status: 'done',
        reviewWorkspace: current.reviewWorkspace
          ? { ...current.reviewWorkspace, cleanedAt: new Date().toISOString() }
          : undefined,
      }),
      'fixture cleanup',
    );
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'human-gating',
    reviewResult: result,
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'local',
      executionNodeId: 'local',
      cleanedAt: new Date().toISOString(),
      checkoutPath: '/fixture/source',
      taskPath: '/fixture/task',
      artifactPath: '/fixture/task/artifacts',
    },
    decisions: [
      {
        id: 'posting',
        type: 'engine_review_posting',
        title: 'Post',
        description: '',
        createdAt: new Date().toISOString(),
        actions: [{ id: 'post', label: 'Post', style: 'primary' }],
        payload: { kind: 'review', repo: 'example/project', prNumber: 1, ...result },
      },
    ],
  });
  latest = new ReviewApprovalPolicyError('COMMENT');
  await assert.rejects(refreshReviewGate(run.id), /require COMMENT/);
  let current = getRun(run.id)!;
  assert.equal((current.decisions[0].payload as ReviewGatePayload).recommendation, 'COMMENT');
  assert.equal(current.reviewResult, undefined);
  assert(!current.decisions[0].actions.some((action) => action.id === 'post'));
  latest = new ReviewApprovalPolicyError('APPROVE');
  await assert.rejects(refreshReviewGate(run.id), /require APPROVE/);
  assert.equal(
    (getRun(run.id)!.decisions[0].payload as ReviewGatePayload).recommendation,
    'COMMENT',
  );
  const workspace = getRun(run.id)!.reviewWorkspace;
  for (const mode of ['workspace', 'primary'])
    for (const message of [
      'body-only finding missing from report',
      'outside RIGHT-side diff',
      'wrong head identity',
    ]) {
      const before = getRun(run.id)!;
      updateRun(run.id, {
        reviewWorkspace: mode === 'workspace' ? workspace : undefined,
        reviewResult: result,
        decisions: before.decisions.map((decision) => ({
          ...decision,
          payload: { ...(decision.payload as ReviewGatePayload), ...result },
          actions: [{ id: 'post', label: 'Post', style: 'primary' }],
        })),
      });
      latest = new Error(message);
      await assert.rejects(refreshReviewGate(run.id), { message });
      const invalid = getRun(run.id)!;
      assert.equal(invalid.reviewResult, undefined);
      const payload = invalid.decisions[0].payload;
      assert(payload?.kind === 'review');
      assert.equal(payload.recommendation, 'COMMENT');
      assert(!invalid.decisions[0].actions.some((action) => action.id === 'post'));
    }
  updateRun(run.id, { reviewWorkspace: workspace });
  for (const recommendation of ['COMMENT', 'REQUEST_CHANGES'] as const) {
    latest = {
      signal: { status: 'complete', outcome: 'success', timestamp: new Date().toISOString() },
      result: { ...result, recommendation, reviewMd: `VERDICT: ${recommendation}` },
    };
    current = await refreshReviewGate(run.id);
    assert.equal(current.reviewResult?.recommendation, recommendation);
    assert.equal(current.decisions[0].description, `**Recommendation:** ${recommendation}`);
    assert.equal(
      (current.decisions[0].payload as ReviewGatePayload).recommendation,
      recommendation,
    );
  }
});

test('workspace gate inspection projects the captured result without recopying live artifacts', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'review-policy-fixture',
    ticketOrPr: 'example/project#1',
  });
  t.after(async () => {
    const current = getRun(run.id)!;
    await persistRunNow(
      updateRun(run.id, {
        status: 'done',
        reviewWorkspace: current.reviewWorkspace
          ? { ...current.reviewWorkspace, cleanedAt: new Date().toISOString() }
          : undefined,
      }),
      'fixture cleanup',
    );
    await deleteRun(run.id);
  });
  const result: RunReviewResult = {
    recommendation: 'COMMENT',
    reviewMd: 'VERDICT: COMMENT',
    lineComments: [],
  };
  latest = {
    signal: { status: 'complete', outcome: 'success', timestamp: new Date().toISOString() },
    result,
  };
  updateRun(run.id, {
    status: 'human-gating',
    taskFile: '/fixture/task/TASK.md',
    reviewResult: result,
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: '/fixture/source',
      taskPath: '/fixture/task',
      artifactPath: '/fixture/task/artifacts',
    },
  });
  const reads = completionReads;
  const inputs = {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' as const }),
  };
  for (let i = 0; i < 2; i++) {
    const readiness = await collectRunGateReadiness(run, null, inputs);
    assert.equal(readiness.state, 'ready', JSON.stringify(readiness.reasons));
  }
  assert.equal(completionReads, reads, 'Readiness must not reacquire the package on each read');
  updateRun(run.id, { reviewResult: undefined });
  const absent = await collectRunGateReadiness(run, null, inputs);
  assert.equal(absent.state, 'not-ready');
  assert(absent.reasons.some(({ code }) => code === 'review-document-missing'));
  assert.equal(completionReads, reads, 'A missing capture requires explicit refresh');
});
