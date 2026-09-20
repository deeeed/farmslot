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

const REVIEW_RESULT = {
  recommendation: 'APPROVE',
  reviewMd: 'VERDICT: APPROVE\n',
  lineComments: [],
  artifactManifest: [],
} as unknown as RunReviewResult;

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
