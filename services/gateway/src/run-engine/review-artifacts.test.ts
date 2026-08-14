import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PlanningContextProjection } from '@farmslot/protocol';

import { buildPlanningContextSection, PLANNING_CONTEXT_INPUT } from '../tasks/planning-context.js';

import {
  buildIndependentReviewPlanningBrief,
  readFrozenPlanningContext,
  reviewRecommendationFromMarkdown,
} from './review-artifacts.js';

const WORKER_SNAPSHOT: PlanningContextProjection = {
  backlogItemId: 'bk_target',
  roadmapItemId: 'ri_790ea3508ba4',
  roadmapTitle: 'Roadmap delivery lineage',
  roadmapSpecPath: '.roadmap/inbox/items/delivery-lineage.md',
  roadmapStage: 'rough',
  workGraphId: 'wg_delivery',
  workNodeId: 'node_target',
  delivery: {
    roadmapItemId: 'ri_790ea3508ba4',
    status: 'partial',
    backlogItemCount: 2,
    deliveredBacklogItemCount: 1,
    runFamilyCount: 1,
    prCount: 1,
    findingCount: 1,
  },
  relations: [
    {
      label: 'depends-on',
      direction: 'upstream',
      targetKind: 'backlog',
      targetId: 'bk_upstream',
      targetRef: 'MANUAL-000059',
      targetStatus: 'done',
      specPath: '.backlog/specs/manual-000059.md',
      source: 'work-graph-edge',
      schedulerAuthority: true,
      reason: 'WorkGraph edge edge_dep (merged, blocks start, status satisfied).',
    },
  ],
  generatedAt: '2026-08-02T10:00:00.000Z',
  snapshotHash: 'f00dcafef00dcafe',
};

async function taskDirWithSnapshot(snapshot?: unknown): Promise<{ dir: string; taskFile: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-artifacts-'));
  await mkdir(path.join(dir, 'inputs'), { recursive: true });
  if (snapshot !== undefined) {
    await writeFile(
      path.join(dir, PLANNING_CONTEXT_INPUT),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf-8',
    );
  }
  return { dir, taskFile: path.join(dir, 'TASK.md') };
}

test('independent-review brief reuses the worker frozen planning-context snapshot', async (t) => {
  const { dir, taskFile } = await taskDirWithSnapshot(WORKER_SNAPSHOT);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const workerSection = buildPlanningContextSection('tasks/dev/manual-000072', WORKER_SNAPSHOT);
  const reviewerSection = await buildIndependentReviewPlanningBrief(
    taskFile,
    'tasks/dev/manual-000072',
  );

  // Same snapshot, same hash, same rendered brief — a reviewer comparing the
  // hash against a re-derived one can tell that prerequisites changed.
  assert.equal(reviewerSection, workerSection);
  assert.match(reviewerSection, /Snapshot hash: f00dcafef00dcafe/);
  assert.match(reviewerSection, /`depends-on` MANUAL-000059/);
  assert.match(reviewerSection, /· scheduler authority ·/);

  const frozen = await readFrozenPlanningContext(taskFile);
  assert.equal(frozen?.snapshotHash, WORKER_SNAPSHOT.snapshotHash);
});

test('independent-review brief is not re-derived from a changed store', async (t) => {
  const { dir, taskFile } = await taskDirWithSnapshot(WORKER_SNAPSHOT);
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A prerequisite that moved after dispatch changes the live projection, but the
  // reviewer brief keeps quoting what the worker was actually briefed on.
  const drifted: PlanningContextProjection = {
    ...WORKER_SNAPSHOT,
    relations: [],
    snapshotHash: '0000000000000000',
  };
  const reviewerSection = await buildIndependentReviewPlanningBrief(taskFile, 'tasks/dev/x');
  assert.match(reviewerSection, /Snapshot hash: f00dcafef00dcafe/);
  assert.equal(reviewerSection.includes(drifted.snapshotHash), false);
});

test('missing frozen snapshot yields an explicit empty state, not a silent omission', async (t) => {
  const { dir, taskFile } = await taskDirWithSnapshot();
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await readFrozenPlanningContext(taskFile), null);
  const section = await buildIndependentReviewPlanningBrief(taskFile, 'tasks/dev/x');
  assert.match(section, /^## Related planning context$/m);
  assert.match(section, /the worker task carried no frozen planning-context snapshot/);
});

test('malformed frozen snapshot fails loudly instead of briefing a reviewer with junk', async (t) => {
  const { dir, taskFile } = await taskDirWithSnapshot({ relations: 'not-an-array' });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => readFrozenPlanningContext(taskFile),
    /Malformed frozen planning context/,
  );
});

test('review recommendation accepts the emphasized field emitted by the review template', () => {
  assert.equal(
    reviewRecommendationFromMarkdown('- **Recommended action:** **REQUEST_CHANGES**'),
    'REQUEST_CHANGES',
  );
});
