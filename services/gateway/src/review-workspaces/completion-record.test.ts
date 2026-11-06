// What a settled static review records, for BOTH worker transports.
//
// `scripts/e2e-subtask-workspace.mts` drives the tmux monitor branch end to end;
// a native reviewer needs a node session no test can stand up. Both branches call
// this one recorder, so these assertions cover what each of them persists: the
// typed result and the child-unit roll-up (ADR-060) on `run.metrics.subtasks`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run, RunReviewResult, RunSubtaskMetrics } from '@farmslot/protocol';

const stamp = `${process.pid}-${Date.now()}`;
const root = mkdtempSync(path.join(os.tmpdir(), `gw-completion-record-${stamp}-`));
const OWNER = `completion-record-owner-${stamp}`;
const PROJECT = `completion-record-${stamp}`;

process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = OWNER;

// Imported after the env above: @farmslot/slot-config captures the pool and
// projects directories at module load.
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { recordWorkspaceReviewCompletion } = await import('./pipeline.js');
const {
  admitReviewRound,
  reviewRoundAdmissionId,
  runReviewRoundBudget,
  settleReviewRoundNoVerdict,
} = await import('../review/review-round-budget.js');

const CHILD_METRICS: RunSubtaskMetrics[] = [
  {
    id: 'perps-review',
    parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
    source: { kind: 'skill', sha256: 'aa', renderedSha256: 'bb' },
    status: 'complete',
    durationMs: 1200,
    completedSteps: 3,
    totalSteps: 3,
  },
];

const REVIEW_RESULT: RunReviewResult = {
  recommendation: 'APPROVE',
  reviewMd: 'VERDICT: APPROVE\n',
  lineComments: [],
  artifactManifest: [],
};

function writeFixtures(): void {
  const projectDir = path.join(process.env.FARMSLOT_PROJECTS_DIR!, PROJECT);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(process.env.FARMSLOT_POOL_DIR!, { recursive: true });
  mkdirSync(process.env.FARMSLOT_RUNS_DIR!, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'project.json'),
    `${JSON.stringify({ name: PROJECT, paths: { runtime_dir: '.agent', artifact_dir: 'artifacts' } })}\n`,
  );
}

/** A workspace run the generation guard accepts, as MONITOR sees it. */
function makeWorkspaceRun(): string {
  const created = createRun(
    {
      project: PROJECT,
      flowType: 'review-pr',
      ticketOrPr: 'https://github.com/example/project/pull/1',
      mode: 'autonomous',
      transport: 'native',
      runner: 'codex',
      model: 'gpt-5-codex',
      reviewWorkspaceTarget: { machine: 'local' },
    } as never,
    { nativeOwnerPrincipalId: OWNER },
  );
  updateRun(created.id, {
    reviewWorkspace: {
      workspaceId: `workspace-${created.id}`,
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: path.join(root, 'source'),
      taskPath: path.join(root, 'task'),
      artifactPath: path.posix.join(root, 'task/artifacts'),
    },
    engineState: { generation: 0 },
    metrics: { nudgeCount: 2, runner: 'codex', model: 'gpt-5-codex' } as Run['metrics'],
  });
  return created.id;
}

test('a settled review records its result and the child roll-up together', async () => {
  writeFixtures();
  const runId = makeWorkspaceRun();

  const updated = await recordWorkspaceReviewCompletion(runId, 0, REVIEW_RESULT, {
    collectSubtasks: async () => CHILD_METRICS,
  });

  assert.equal(updated.reviewResult?.recommendation, 'APPROVE');
  assert.deepEqual(updated.metrics.subtasks, CHILD_METRICS);
  assert.equal(updated.metrics.nudgeCount, 2, 'the run’s own metrics survive the roll-up');
  // Persisted, not just held in memory: the retrospective reads the stored run.
  assert.deepEqual(getRun(runId)?.metrics.subtasks, CHILD_METRICS);
});

test('a verdict a monitor replay records counts the round its superseded monitor settled', async () => {
  writeFixtures();
  const runId = makeWorkspaceRun();
  // No DISPATCH launch time in this fixture, so the receipt keys on createdAt.
  const receipt = reviewRoundAdmissionId(`workspace-review-${runId}`, 1, getRun(runId)!.createdAt);
  await admitReviewRound(runId, receipt);
  await settleReviewRoundNoVerdict(runId, receipt, 'superseded by a monitor replay');
  assert.equal((await runReviewRoundBudget(getRun(runId)!)).used, 0);

  await recordWorkspaceReviewCompletion(runId, 0, REVIEW_RESULT, {
    collectSubtasks: async () => null,
  });

  const budget = await runReviewRoundBudget(getRun(runId)!);
  assert.equal(budget.used, 1, 'the attempt returned a verdict, so its round counts');
  assert.equal(budget.noVerdict, 0);
});

test('a run with no child unit records its result and no roll-up', async () => {
  const runId = makeWorkspaceRun();

  const updated = await recordWorkspaceReviewCompletion(runId, 0, REVIEW_RESULT, {
    collectSubtasks: async () => null,
  });

  assert.equal(updated.reviewResult?.recommendation, 'APPROVE');
  assert.equal(updated.metrics.subtasks, undefined);
});

test('an unreadable registry still records the review result', async () => {
  const runId = makeWorkspaceRun();

  // A corrupt `subtasks/index.json` is the run's cost record's problem, not the
  // review's: losing the result here would discard a finished review.
  const updated = await recordWorkspaceReviewCompletion(runId, 0, REVIEW_RESULT, {
    collectSubtasks: async () => {
      throw new Error('invalid subtasks/index.json');
    },
  });

  assert.equal(updated.reviewResult?.recommendation, 'APPROVE');
  assert.equal(updated.metrics.subtasks, undefined);
});

test('a superseded generation cannot record a completion', async () => {
  const runId = makeWorkspaceRun();
  updateRun(runId, { engineState: { generation: 3 } });

  await assert.rejects(
    recordWorkspaceReviewCompletion(runId, 0, REVIEW_RESULT, {
      collectSubtasks: async () => CHILD_METRICS,
    }),
    /no longer owns this run generation/,
  );
  assert.equal(getRun(runId)?.reviewResult, undefined);
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('slotless completion durably binds its conversation, lineage and reviewed head', async () => {
  writeFixtures();
  const runId = makeWorkspaceRun();
  const head = 'a'.repeat(40);
  updateRun(runId, {
    reviewWorkspaceSubject: {
      repository: 'example/project',
      repositoryUrl: 'https://github.com/example/project.git',
      headSha: head,
      baseSha: 'b'.repeat(40),
      branch: 'feature',
      title: 'Review fixture',
      body: '',
      capturedAt: '2026-11-06T01:00:00Z',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Reviewer',
        runId,
        slotId: null,
        status: 'working',
        runner: 'codex',
        model: 'gpt-5-codex',
        reviewId: 'fixture-lineage',
        runnerSessionId: 'fixture-conversation',
        runnerSessionPath: '/fixture/session.jsonl',
        runnerSessionCapturedAt: '2026-11-06T01:01:00Z',
      },
    ],
  });
  await recordWorkspaceReviewCompletion(runId, 0, REVIEW_RESULT, {
    collectSubtasks: async () => null,
  });
  const saved = getRun(runId)!;
  assert.equal(saved.reviewResult?.session?.reviewId, 'fixture-lineage');
  assert.equal(saved.reviewResult?.session?.sessionId, 'fixture-conversation');
  assert.equal(saved.reviewResult?.session?.lastReviewedHeadSha, head);
  assert.equal(saved.reviewResult?.reviewSnapshot?.headSha, head);
  assert.equal(saved.agentContexts?.[0].deliveryBaselineRef, head);
  assert.ok(saved.agentContexts?.[0].reviewResultValidatedAt);
});
