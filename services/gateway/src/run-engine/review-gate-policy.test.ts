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
const unused = () => {
  throw new Error('Unexpected review operation');
};
mock.module('../review-workspaces/task.js', {
  namedExports: {
    readReviewWorkspaceCompletion: async () => {
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
const root = await mkdtemp(path.join(os.tmpdir(), 'review-gate-policy-'));
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { refreshReviewGate } = await import('./review-gate.js');
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
    updateRun(run.id, { status: 'done' });
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
