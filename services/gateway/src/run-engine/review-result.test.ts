import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import * as artifacts from './review-artifacts.js';

let copies = 0;
mock.module('./review-artifacts.js', {
  namedExports: {
    ...artifacts,
    copyWorkerArtifacts: async () => {
      copies += 1;
    },
  },
});
const { recordArtifactOnlyReviewResult } = await import('./review-result.js');

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-result-'));
  await mkdir(path.join(dir, 'inputs'));
  await mkdir(path.join(dir, 'artifacts'));
  const commit = {
    source: 'github-pr',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    capturedAt: '2026-09-01T10:00:00Z',
  };
  await writeFile(path.join(dir, 'inputs/commit.json'), JSON.stringify(commit));
  await writeFile(path.join(dir, 'inputs/diff.txt'), 'frozen review diff');
  await writeFile(
    path.join(dir, 'artifacts/review.md'),
    '## Summary\nCompleted review.\n## Verdict\nREQUEST_CHANGES',
  );
  await writeFile(
    path.join(dir, 'artifacts/line-comments.json'),
    JSON.stringify([{ path: 'src/a.ts', line: 9, body: 'Cancel the trace', severity: 'must_fix' }]),
  );
  const run = createRun({
    flowType: 'review-pr',
    project: 'review-result-test',
    ticketOrPr: 'owner/repo#123',
    completionPolicy: 'artifact-only',
  });
  updateRun(run.id, {
    taskFile: path.join(dir, 'TASK.md'),
    status: 'human-gating',
    steps: run.steps.map((step) =>
      step.name === 'monitor'
        ? {
            ...step,
            status: 'done',
            outputs: { workerSignal: { status: 'complete', outcome: 'success' } },
          }
        : step.name === 'dispatch'
          ? { ...step, status: 'done', startedAt: '2026-09-01T10:01:00Z' }
          : step,
    ),
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  return { run, dir, commit };
}

test('artifact-only completion persists real report, frozen SHA and findings without a publication decision', async (t) => {
  const { run } = await fixture(t);
  const result = await recordArtifactOnlyReviewResult(run.id);
  assert.equal(result.reviewSnapshot?.headSha, 'a'.repeat(40));
  assert.equal(result.recommendation, 'REQUEST_CHANGES');
  assert.equal(result.lineComments[0].body, 'Cancel the trace');
  assert.equal(getRun(run.id)?.decisions.length, 0);
  assert.deepEqual(getRun(run.id)?.reviewResult, result);
  const before = copies;
  assert.equal(await recordArtifactOnlyReviewResult(run.id), result);
  assert.equal(copies, before, 'An already recorded result is immutable');
});

test('a commit snapshot refreshed after dispatch cannot certify the reviewed commit', async (t) => {
  const { run, dir, commit } = await fixture(t);
  await writeFile(
    path.join(dir, 'inputs/commit.json'),
    JSON.stringify({ ...commit, capturedAt: '2026-09-01T10:02:00Z' }),
  );
  await assert.rejects(recordArtifactOnlyReviewResult(run.id), /pre-dispatch/);
  assert.equal(getRun(run.id)?.reviewResult, undefined);
});

test('missing report and failed worker signal cannot become completed review evidence', async (t) => {
  const { run, dir } = await fixture(t);
  await rm(path.join(dir, 'artifacts/review.md'));
  await assert.rejects(recordArtifactOnlyReviewResult(run.id), /report is missing/);
  updateRun(run.id, {
    steps: getRun(run.id)!.steps.map((step) =>
      step.name === 'monitor'
        ? { ...step, outputs: { workerSignal: { status: 'complete', outcome: 'failure' } } }
        : step,
    ),
  });
  await assert.rejects(recordArtifactOnlyReviewResult(run.id), /successful worker/);
  assert.equal(getRun(run.id)?.reviewResult, undefined);
});
