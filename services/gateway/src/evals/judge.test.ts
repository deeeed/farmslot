import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeReview, type ReviewResult } from '../review/orchestrator.js';
import { captureCurrentReviewSnapshot } from '../review/snapshots.js';
import { deleteTestRunIfPresent, makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { firstOutputFixture } from './first-output.test-support.js';
import {
  readEvalJudgeReceipt,
  readEvalReviewContribution,
  recordEvalJudgeResult,
} from './judge.js';
import { sha256Text } from './package-store.js';

test('the eval judge reads frozen dirty and untracked source even when HEAD equals the base', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-uncommitted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
  git('init', '-q');
  await writeFile(path.join(repo, 'tracked.ts'), 'export const answer = 0;\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'test: seed',
  );
  const baseSha = git('rev-parse', 'HEAD').trim();
  await writeFile(path.join(repo, 'tracked.ts'), 'export const answer = 42;\n');
  await writeFile(path.join(repo, 'new.ts'), 'export const added = true;\n');
  const untracked = spawnSync(
    'git',
    ['diff', '--no-index', '--binary', '--full-index', '/dev/null', 'new.ts'],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(untracked.status, 1, 'git diff --no-index reports a real file addition');
  const diffText = git('diff', '--binary', '--full-index', baseSha) + untracked.stdout;
  assert.equal(git('diff', `${baseSha}..HEAD`), '', 'the committed range hides both changes');
  const run = await firstOutputFixture(root, makeRun());
  const blind = run.engineState!.evalExperiment!.blind!;
  blind.baseSha = baseSha;
  const first = blind.firstOutput!;
  first.headSha = baseSha;
  first.diffSha256 = sha256Text(diffText);
  first.diff = { ...first.diff, baseSha, headSha: baseSha, files: 2, additions: 2, deletions: 1 };
  await writeFile(first.diffPath, diffText);
  const frozenContribution = await readEvalReviewContribution(run);
  await writeFile(path.join(repo, 'tracked.ts'), 'export const answer = -1;\n');
  const captured = await captureCurrentReviewSnapshot(
    makeVars(),
    { frozenContribution },
    {
      resolveContext: async () =>
        assert.fail('Frozen contribution must not resolve a live Git base'),
      exec: async () => assert.fail('Frozen contribution must not read a mutable checkout'),
    },
  );
  assert.equal(captured.diffText, diffText);
  assert.match(captured.diffText!, /answer = 42/);
  assert.match(captured.diffText!, /added = true/);
  assert.equal(captured.snapshot.headSha, baseSha);
  assert.equal(captured.snapshot.diffHash, first.diffSha256);
  await assert.rejects(
    recordEvalJudgeResult(run, {
      verdict: 'pass',
      issues: [],
      retryCount: 0,
      reviewSnapshot: { ...captured.snapshot, diffHash: sha256Text('') },
    }),
    /did not review the frozen first output/,
  );
  await writeFile(first.diffPath, 'Changed frozen contribution');
  await assert.rejects(readEvalReviewContribution(run), /frozen eval contribution changed/);
});

for (const verdict of ['pass', 'issues'] as const) {
  test(`a retained ${verdict} judge is reused without a second reviewer or fix`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-judge-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = createRun({
      flowType: 'fix-bug',
      project: 'generic-project',
      ticketOrPr: 'JUDGE',
      slotId: 'missing-slot',
    });
    t.after(() => deleteTestRunIfPresent(run.id));
    const fixture = await firstOutputFixture(root, getRun(run.id)!);
    updateRun(run.id, {
      engineState: fixture.engineState,
      taskFile: fixture.taskFile,
      status: 'reviewing',
    });
    const first = fixture.engineState!.evalExperiment!.blind!.firstOutput!;
    const result: ReviewResult = {
      verdict,
      issues:
        verdict === 'issues'
          ? [{ file: 'value.ts', line: 1, description: 'Incorrect answer', severity: 'major' }]
          : [],
      retryCount: 0,
      maxRetries: 0,
      reviewId: 'eval-first-output',
      reviewerSessionId: 'judge-session',
      validationDepth: 'static-code',
      runner: 'claude',
      model: 'opus',
      effort: null,
      reviewSnapshot: {
        source: 'local-git',
        baseSha: first.diff.baseSha,
        headSha: first.headSha,
        capturedAt: first.capturedAt,
        diffHash: first.diffSha256,
      },
      usage: {
        source: 'unavailable',
        measuredAt: first.capturedAt,
        costUsd: null,
        error: 'Reviewer usage unavailable',
      },
      attempts: [
        {
          loopNumber: 1,
          mode: 'cold',
          verdict,
          issues: [],
          unresolvedCount: verdict === 'issues' ? 1 : 0,
          artifactPaths: ['artifacts/eval-first-output/review-loop-1/review-result.json'],
          completedAt: '2026-10-30T00:02:00Z',
        },
      ],
    };
    await recordEvalJudgeResult(getRun(run.id)!, result);
    const receiptFile = path.join(root, 'gateway/first-output-judge.json');
    const original = await readFile(receiptFile);
    const cached = await readEvalJudgeReceipt(getRun(run.id)!);
    assert.equal(cached?.result.verdict, verdict);
    assert.deepEqual(cached?.result.issues, result.issues);
    assert.deepEqual(cached?.result.usage, result.usage);
    // This slot deliberately does not exist. A reviewer launch would fail instead of replaying.
    const replayed = await executeReview(run.id, 'missing-slot', {
      validationDepth: 'static-code',
    });
    assert.equal(replayed.verdict, verdict);
    assert.deepEqual(replayed.issues, result.issues);
    assert.equal(replayed.retryCount, 0);
    assert.equal(getRun(run.id)?.agentContexts?.filter(({ role }) => role === 'review').length, 0);
    assert.deepEqual(getRun(run.id)?.decisions, []);
    assert.deepEqual(await readFile(receiptFile), original);
    await assert.rejects(
      recordEvalJudgeResult(getRun(run.id)!, {
        ...result,
        issues: [{ file: 'other.ts', description: 'Different finding', severity: 'major' }],
      }),
      /first eval judge outcome changed/,
    );
    updateRun(run.id, {
      engineState: {
        ...fixture.engineState,
        evalExperiment: {
          ...fixture.engineState!.evalExperiment!,
          blind: {
            ...fixture.engineState!.evalExperiment!.blind!,
            firstOutput: { ...first, headSha: 'd'.repeat(40) },
          },
        },
      },
    });
    await assert.rejects(
      readEvalJudgeReceipt(getRun(run.id)!),
      /differs from its frozen first output/,
    );
    await writeFile(receiptFile, '{}');
    await assert.rejects(
      readEvalJudgeReceipt(getRun(run.id)!),
      /differs from its frozen first output/,
    );
  });
}
