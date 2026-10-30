import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeReview, type ReviewResult } from '../review/orchestrator.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { firstOutputFixture } from './first-output.test-support.js';
import { readEvalJudgeReceipt, recordEvalJudgeResult } from './judge.js';

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
