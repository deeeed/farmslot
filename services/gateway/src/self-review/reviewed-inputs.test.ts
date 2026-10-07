import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { ReviewLoopRequest } from '@farmslot/protocol';

import { farmslotRoot } from '../fleet/state.js';
import type { PrepareCompletionPackageResult } from '../run-completion/orchestrator.js';
import { rerunSelfReviewIfReviewedInputsChanged } from '../run-engine/post-dispatch-steps.js';
import { deleteTestRunIfPresent, makeReadyGatePackage } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import {
  noteReviewInputsAtLaunch,
  recordReviewedInputs,
  reviewedInputsAwaitingReview,
  reviewedInputsChanged,
} from './reviewed-inputs.js';

const execFileAsync = promisify(execFile);

async function git(repo: string, ...args: string[]) {
  await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Farmslot Test',
    '-c',
    'user.email=farmslot-test@example.invalid',
    ...args,
  ]);
}

/** A local slot whose checkout holds a worker task dir with description and evidence. */
async function slotWithTask(t: import('node:test').TestContext) {
  const id = `reviewed-inputs-${process.pid}-${Date.now()}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `${id}-`));
  const poolFile = path.join(farmslotRoot, 'pool', `${id}.json`);
  const taskRelDir = `test/${id}`;
  const artifacts = path.join(repo, '.sandbox/farmslot-farm/worker-task', taskRelDir, 'artifacts');
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'TAT-4031-LIKE',
    runner: 'claude',
  });
  updateRun(run.id, {
    slotId: `${id}-slot`,
    taskFile: path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks', taskRelDir, 'TASK.md'),
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(poolFile, { force: true });
    await rm(repo, { recursive: true, force: true });
  });
  await writeFile(path.join(repo, 'README.md'), 'fixture\n');
  await execFileAsync('git', ['init', '-q', repo]);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'base');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Removed surfaces\n- Banner\n');
  await writeFile(
    path.join(artifacts, 'evidence-manifest.json'),
    JSON.stringify({
      before_after_pairs: [{ label: 'flag on', before: 'on-before.png', after: 'on-after.png' }],
    }),
  );
  await writeFile(path.join(artifacts, 'on-after.png'), 'png-v1');
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project: 'farmslot-farm',
      platform: 'cli',
      host: 'localhost',
      ssh_user: os.userInfo().username,
      slots: [{ id: `${id}-slot`, enabled: true, repo, session: `${id}-slot` }],
    }),
  );
  return { run, repo, artifacts };
}

/** A review launched on the slot as it is now, then passed. */
async function reviewPasses(runId: string) {
  await noteReviewInputsAtLaunch(runId);
  await recordReviewedInputs(runId);
}

test('what a passing review judged changes with the description, evidence or HEAD', async (t) => {
  const { run, repo, artifacts } = await slotWithTask(t);
  assert.equal(await reviewedInputsChanged(getRun(run.id)!), false, 'no record: no change');

  await reviewPasses(run.id);
  assert.ok(getRun(run.id)!.engineState?.reviewedInputs?.fingerprint);
  const changed = () => reviewedInputsChanged(getRun(run.id)!);
  assert.equal(await changed(), false);

  await writeFile(path.join(artifacts, 'review-feedback.md'), '## Verdict: PASS\n');
  assert.equal(await changed(), false, "the review's own text output is not an input");

  // The rework from delete to hide-behind-flag rewrites the description.
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Hidden behind a flag\n');
  assert.equal(await changed(), true, 'description');
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Removed surfaces\n- Banner\n');
  assert.equal(await changed(), false, 'the same content is the same fingerprint');

  await writeFile(path.join(artifacts, 'on-after.png'), 'png-v2');
  assert.equal(await changed(), true, 're-captured evidence');
  await writeFile(path.join(artifacts, 'on-after.png'), 'png-v1');

  await mkdir(path.join(artifacts, 'recipe-runs/r1'), { recursive: true });
  await writeFile(path.join(artifacts, 'latest-valid-recipe-run.json'), '{"runId":"r1"}');
  assert.equal(await changed(), true, 'a newly selected recipe run');
  await reviewPasses(run.id);
  await writeFile(path.join(artifacts, 'recipe-runs/r1/evidence-manifest.json'), '{}');
  assert.equal(await changed(), true, "a recipe run's own manifest");
  await reviewPasses(run.id);

  await writeFile(
    path.join(artifacts, 'evidence-manifest.json'),
    JSON.stringify({
      before_after_pairs: [{ label: 'flag off', before: 'on-before.png', after: 'on-after.png' }],
    }),
  );
  assert.equal(await changed(), true, 'relabelled evidence');
  await reviewPasses(run.id);
  assert.equal(await changed(), false);

  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'squash');
  assert.equal(await changed(), true, 'a new HEAD, e.g. a squash');
});

test('a pass records what the review was given, not the slot as it is when it passes', async (t) => {
  const { run, artifacts } = await slotWithTask(t);
  await reviewPasses(run.id);
  await noteReviewInputsAtLaunch(run.id);
  // Edited while the review ran, or while a crashed gateway was down before
  // recovery returned the retained pass.
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Hidden behind a flag\n');
  await recordReviewedInputs(run.id);
  assert.equal(await reviewedInputsChanged(getRun(run.id)!), true);
});

test('the publication gate re-runs self-review once per change before it is presented', async (t) => {
  const { run, artifacts } = await slotWithTask(t);
  await reviewPasses(run.id);
  const plans: ReviewLoopRequest[][] = [];
  let passing = true;
  let fixLoopEdit: string | null = null;
  const context = {
    executePublishGateReviewPlan: async (
      _runId: string,
      _slotId: string,
      plan: ReviewLoopRequest[],
    ) => {
      plans.push(plan);
      if (fixLoopEdit) await writeFile(path.join(artifacts, 'pr-description.md'), fixLoopEdit);
      // As executeSelfReview does: the document notes the inputs, a pass records them.
      await noteReviewInputsAtLaunch(run.id);
      if (passing) await recordReviewedInputs(run.id);
      return { reviewIds: [`review-${plans.length}`] };
    },
    getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
    prepareCompletionPackageForRun: async (): Promise<PrepareCompletionPackageResult> => ({
      completion: {
        prNumber: null,
        ciRepo: null,
        artifactsCopied: true,
        prCommentPosted: false,
        prTitleUpdated: false,
        prMarkedReady: false,
        retrospectiveCreated: false,
        artifacts: [],
      },
      prPackage: makeReadyGatePackage(),
      reviewDepth: {
        minimumIndependentReviews: 0,
        requireCrossRunner: false,
        extraLoopsRequested: 0,
        requestedBy: 'dispatch',
      },
      independentReviews: [],
    }),
  };
  const awaiting = async () => (await reviewedInputsAwaitingReview(getRun(run.id)!)) !== null;

  assert.equal(await rerunSelfReviewIfReviewedInputsChanged(run.id, context), false);
  assert.equal(plans.length, 0, 'nothing changed since the review');

  await writeFile(path.join(artifacts, 'pr-description.md'), '## Hidden behind a flag\n');
  assert.equal(await awaiting(), true, 'an approval now is held');
  assert.equal(await rerunSelfReviewIfReviewedInputsChanged(run.id, context), true);
  assert.deepEqual(plans, [[{ order: 1, runner: 'same', validationDepth: 'static-code' }]]);
  assert.equal(await reviewedInputsChanged(getRun(run.id)!), false, 'its pass is the new record');

  // A re-run that finds issues runs once, also across a gateway restart: the
  // gate shows review unsatisfied and an explicit override is no longer held.
  passing = false;
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Hidden, flag on only\n');
  assert.equal(await rerunSelfReviewIfReviewedInputsChanged(run.id, context), true);
  assert.equal(await rerunSelfReviewIfReviewedInputsChanged(run.id, context), false);
  assert.equal(plans.length, 2);
  assert.equal(await reviewedInputsChanged(getRun(run.id)!), true);
  assert.equal(await awaiting(), false);

  // A failing re-run whose fix loop moved the slot does not hold again for its end state.
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Hidden, partly fixed\n');
  fixLoopEdit = '## Hidden, fixed again\n';
  assert.equal(await rerunSelfReviewIfReviewedInputsChanged(run.id, context), true);
  assert.equal(plans.length, 3);
  assert.equal(await awaiting(), false, 'the end state counts as re-run');
  fixLoopEdit = null;

  // A further change is a new state: reviewed again.
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Hidden, both states\n');
  assert.equal(await awaiting(), true);
});
