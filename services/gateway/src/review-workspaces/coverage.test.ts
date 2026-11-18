import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewInterdiffReceipt } from '@farmslot/protocol';

import { prepareReviewCoverage } from './coverage.js';
import { withReviewWorkspaceTaskFixture } from './task-fixture.test-support.js';

test('only delta continuations get packets; ordinary COLD and expiry retain full evaluation', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    f.subject.contributionBaseSha = f.subject.baseSha;
    const context = f.run.repeatReviewContext!;
    context.priorReviewedHeadSha = 'c'.repeat(40);
    const input = {
      run: f.run,
      subject: f.subject,
      instructionFiles: [],
      viewDir: () => f.root,
      getPrior: async () => undefined,
      git: async (args: string[]) => (args.includes('ls-tree') ? '' : 'src/changed.ts\0'),
    };
    const warm = await prepareReviewCoverage(input);
    assert(warm?.packet);
    assert.deepEqual(warm.packet.deltaPaths, ['src/changed.ts']);
    assert.deepEqual(warm.packet.scopePaths, ['src/changed.ts']);
    assert.deepEqual(warm.packet.unresolvedFindings, context.unresolvedFindings);
    assert.deepEqual(warm.packet.reusableKeys, []);
    assert.equal(warm.packet.baselineHeadSha, context.priorReviewedHeadSha);
    assert.equal(warm.packet.currentHeadSha, f.subject.headSha);
    context.mode = 'cold';
    assert.equal((await prepareReviewCoverage(input))?.packet, undefined);
    context.session = {
      mode: 'cold',
      continuity: 'fresh',
      fallback: {
        reason: 'retention-expired',
        detail: 'expired',
        comparedRanges: ['full-contribution'],
      },
    };
    assert.equal((await prepareReviewCoverage(input))?.packet, undefined);
    context.session.fallback = {
      reason: 'session-resume-unsupported',
      detail: 'unsupported',
      comparedRanges: ['validated-delta'],
    };
    const fallback = await prepareReviewCoverage(input);
    assert.deepEqual(fallback?.packet?.comparedRanges, ['validated-delta']);
  });
});

test('rebased coverage consumes the pinned author paths and never scans raw prior..head', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    f.subject.contributionBaseSha = f.subject.baseSha;
    const context = f.run.repeatReviewContext!;
    context.priorReviewedHeadSha = 'c'.repeat(40);
    const calls: string[][] = [];
    const interdiff: ReviewInterdiffReceipt = {
      version: 1,
      oldBaseSha: 'd'.repeat(40),
      oldHeadSha: context.priorReviewedHeadSha,
      newBaseSha: f.subject.baseSha,
      newHeadSha: f.subject.headSha,
      rangeDiffHash: 'e'.repeat(64),
      qualification: 'reliable',
      priorCommitCount: 4,
      unmatchedOverlappingPairs: 0,
      upstreamOverlapFiles: ['src/author.ts'],
      deltaPaths: ['src/author.ts'],
    };
    const result = await prepareReviewCoverage({
      run: f.run,
      subject: f.subject,
      instructionFiles: [],
      viewDir: () => f.root,
      getPrior: async () => undefined,
      interdiff,
      git: async (args) => {
        calls.push(args);
        return args.includes('ls-tree') ? '' : 'src/author.ts\0';
      },
    });
    assert.deepEqual(result?.packet?.deltaPaths, ['src/author.ts']);
    assert.deepEqual(result?.packet?.comparedRanges, [
      `${interdiff.oldBaseSha}..${interdiff.oldHeadSha}`,
      `${interdiff.newBaseSha}..${interdiff.newHeadSha}`,
    ]);
    assert.ok(
      !calls.some((args) => args[0] === 'diff' && args.includes(context.priorReviewedHeadSha!)),
    );
  });
});
