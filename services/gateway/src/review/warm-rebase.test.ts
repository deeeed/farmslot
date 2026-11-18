import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isRecord, type ReviewInterdiffReceipt } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

import {
  interdiffFallback,
  interdiffReviewScope,
  isReliableInterdiff,
  parseInterdiffReceipt,
} from './interdiff.js';
import { captureCurrentReviewSnapshot, reviewDeltaSinceReviewedHead } from './snapshots.js';

async function fixture(t: test.TestContext, overlap = false) {
  const repo = await mkdtemp(path.join(tmpdir(), 'warm-rebase-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' },
    ).trim();
  const commit = async (file: string, text: string, message: string) => {
    await writeFile(path.join(repo, file), text);
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const exec = async (command: string) => {
    const r = spawnSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  git('init', '-q', '-b', 'main');
  if (overlap)
    await writeFile(
      path.join(repo, 'author.txt'),
      Array.from({ length: 40 }, (_, i) => 'base ' + i).join('\n') + '\n',
    );
  const oldBase = await commit('upstream.txt', 'base\n', 'test: base');
  git('checkout', '-qb', 'author');
  const oldHead = await commit(
    'author.txt',
    Array.from({ length: 40 }, (_, i) =>
      overlap ? (i === 0 ? 'author zero' : 'base ' + i) : 'old ' + i,
    ).join('\n') + '\n',
    'feat: author change',
  );
  git('checkout', '-q', 'main');
  if (overlap)
    await writeFile(
      path.join(repo, 'author.txt'),
      Array.from({ length: 40 }, (_, i) => (i === 39 ? 'UPSTREAM-ONLY-OVERLAP' : 'base ' + i)).join(
        '\n',
      ) + '\n',
    );
  const newBase = await commit('upstream.txt', 'upstream-only-noise\n', 'test: upstream advance');
  git('checkout', '-q', 'author');
  git('rebase', '-q', 'main');
  return { repo, git, commit, exec, oldBase, oldHead, newBase };
}

test('a warm snapshot survives a real rebase and excludes upstream-only changes', async (t) => {
  const f = await fixture(t);
  const head = await f.commit(
    'author.txt',
    Array.from({ length: 40 }, (_, i) => (i === 10 ? 'author correction' : 'old ' + i)).join('\n') +
      '\n',
    'fix: author correction',
  );
  const captured = await captureCurrentReviewSnapshot(
    makeVars(),
    { mode: 'warm', lastReviewedHeadSha: f.oldHead, baseRef: 'main' },
    {
      resolveContext: async () => ({ baseRef: 'main', pathspecs: ['.'] }),
      exec: async (_vars, command) => f.exec(command),
    },
  );
  assert.equal(captured.snapshot.source, 'local-git');
  assert.equal(captured.snapshot.headSha, head);
  assert.equal(captured.snapshot.baseSha, f.newBase);
  assert.doesNotMatch(captured.diffText ?? '', /upstream-only-noise/);
  assert.ok('interdiff' in captured.snapshot && isRecord(captured.snapshot.interdiff));
  assert.equal(captured.snapshot.interdiff.oldHeadSha, f.oldHead);
  assert.equal(captured.snapshot.interdiff.newHeadSha, head);
  assert.equal(captured.snapshot.interdiff.qualification, 'reliable');
});

test('a heavily rewritten unmatched overlapping series records the frozen cold-fallback qualification', async (t) => {
  const f = await fixture(t);
  f.git('reset', '--soft', 'main');
  const head = await f.commit(
    'author.txt',
    Array.from({ length: 40 }, (_, i) => 'rewritten ' + i).join('\n') + '\n',
    'fix: rewrite after conflict',
  );
  const delta = await reviewDeltaSinceReviewedHead(f.exec, {
    lastReviewedHeadSha: f.oldHead,
    headSha: head,
    baseRef: 'main',
  });
  assert.ok('interdiff' in delta && isRecord(delta.interdiff));
  assert.equal(delta.interdiff.qualification, 'unreliable');
  assert.equal(delta.interdiff.unmatchedOverlappingPairs, 1);
  assert.equal(delta.interdiff.priorCommitCount, 1);
  assert.equal(delta.interdiff.oldBaseSha, f.oldBase);
  assert.equal(delta.interdiff.newBaseSha, f.newBase);
  assert.doesNotMatch(delta.rangeDiff ?? '', /upstream-only-noise/);
});

test('the frozen interdiff bound keeps exact limits warm and rejects either excess', () => {
  const receipt = (prior: number, pairs: number): ReviewInterdiffReceipt => ({
    version: 1,
    oldBaseSha: 'a'.repeat(40),
    oldHeadSha: 'b'.repeat(40),
    newBaseSha: 'c'.repeat(40),
    newHeadSha: 'd'.repeat(40),
    rangeDiffHash: 'e'.repeat(64),
    qualification: 'reliable',
    priorCommitCount: prior,
    unmatchedOverlappingPairs: pairs,
    upstreamOverlapFiles: [],
    deltaPaths: [],
  });
  assert.equal(isReliableInterdiff(receipt(12, 3)), true);
  assert.equal(isReliableInterdiff(receipt(20, 4)), false);
  assert.equal(isReliableInterdiff(receipt(4, 1)), true);
  assert.equal(isReliableInterdiff(receipt(3, 1)), false);
  assert.equal(isReliableInterdiff(receipt(0, 0)), true);
  assert.throws(() => parseInterdiffReceipt(receipt(3, 1)), /contradicts/);
});

test('missing prior Git objects record a qualified cold fallback', async (t) => {
  const f = await fixture(t);
  const head = f.git('rev-parse', 'HEAD');
  const delta = await reviewDeltaSinceReviewedHead(f.exec, {
    lastReviewedHeadSha: '9'.repeat(40),
    headSha: head,
    baseRef: 'main',
  });
  assert.ok(delta.interdiff);
  assert.equal(delta.interdiff.qualification, 'missing-objects');
  assert.equal(interdiffFallback(delta.interdiff)?.reason, 'reviewed-objects-unavailable');
  assert.equal(delta.interdiff.newBaseSha, f.newBase);
  assert.equal(delta.interdiff.oldBaseSha, null);
});

test('an inspection transport failure cannot silently choose cold or widen scope', async () => {
  await assert.rejects(
    reviewDeltaSinceReviewedHead(
      async () => ({ exitCode: 1, stdout: '', stderr: 'inspection transport failed' }),
      { lastReviewedHeadSha: 'a'.repeat(40), headSha: 'b'.repeat(40), baseRef: 'main' },
    ),
    /inspection transport failed/,
  );
});

test('upstream overlap is named while its actual changes stay out of author review input', async (t) => {
  const f = await fixture(t, true);
  const head = f.git('rev-parse', 'HEAD');
  const captured = await captureCurrentReviewSnapshot(
    makeVars(),
    { mode: 'warm', lastReviewedHeadSha: f.oldHead, baseRef: 'main' },
    {
      resolveContext: async () => ({ baseRef: 'main', pathspecs: ['.'] }),
      exec: async (_vars, command) => f.exec(command),
    },
  );
  assert.equal(captured.snapshot.source, 'local-git');
  assert.equal(captured.snapshot.headSha, head);
  assert.deepEqual(captured.snapshot.interdiff?.upstreamOverlapFiles, ['author.txt']);
  assert.deepEqual(captured.snapshot.interdiff?.deltaPaths, []);
  assert.equal(captured.snapshot.interdiff?.qualification, 'reliable');
  assert.doesNotMatch(captured.diffText ?? '', /UPSTREAM-ONLY-OVERLAP|upstream-only-noise/);
  const scope = interdiffReviewScope(
    captured.snapshot.interdiff!,
    'inputs/review-interdiff.json',
    [],
    'cold',
  );
  assert.match(scope, /fresh session/);
  assert.doesNotMatch(scope, /Continue this same review/);
});

test('a missing captured prior base records the object fallback without guessing another base', async (t) => {
  const f = await fixture(t);
  const head = f.git('rev-parse', 'HEAD');
  const delta = await reviewDeltaSinceReviewedHead(f.exec, {
    lastReviewedHeadSha: f.oldHead,
    headSha: head,
    baseRef: 'main',
    priorBaseSha: '9'.repeat(40),
  });
  assert.equal(delta.interdiff?.qualification, 'missing-objects');
  assert.match(delta.interdiff?.reason ?? '', /prior base object/);
});

test('merge-only author resolutions are included in a rebased patch series', async (t) => {
  const f = await fixture(t);
  f.git('checkout', '-qb', 'old-side', f.oldBase);
  const side = await f.commit('side.txt', 'side\n', 'feat: side');
  f.git('checkout', '-q', '-B', 'old-merge', f.oldHead);
  f.git('merge', '--no-ff', '--no-commit', 'old-side');
  const old = await f.commit('resolution.txt', 'before resolution\n', 'merge: author resolution');
  f.git('checkout', '-qb', 'new-side', f.newBase);
  f.git('cherry-pick', side);
  f.git('checkout', '-q', 'author');
  f.git('merge', '--no-ff', '--no-commit', 'new-side');
  const head = await f.commit('resolution.txt', 'after resolution\n', 'merge: author resolution');
  const delta = await reviewDeltaSinceReviewedHead(f.exec, {
    lastReviewedHeadSha: old,
    headSha: head,
    baseRef: 'main',
  });
  assert.ok(delta.interdiff?.deltaPaths.includes('resolution.txt'));
  assert.match(delta.rangeDiff ?? '', /resolution/);
  assert.doesNotMatch(delta.rangeDiff ?? '', /upstream-only-noise/);
});

test('a captured prior contribution base prevents rewritten-upstream noise in the old series', async (t) => {
  const f = await fixture(t);
  const head = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-qb', 'captured-upstream', f.oldBase);
  const priorBase = await f.commit(
    'upstream.txt',
    'old upstream branch\n',
    'chore: old upstream only',
  );
  f.git('cherry-pick', f.oldHead);
  const old = f.git('rev-parse', 'HEAD');
  const delta = await reviewDeltaSinceReviewedHead(f.exec, {
    lastReviewedHeadSha: old,
    headSha: head,
    baseRef: 'main',
    priorBaseSha: priorBase,
  });
  assert.equal(delta.interdiff?.oldBaseSha, priorBase);
  assert.equal(delta.interdiff?.newBaseSha, f.newBase);
  assert.equal(delta.interdiff?.qualification, 'reliable');
  assert.doesNotMatch(
    delta.rangeDiff ?? '',
    /old upstream only|old upstream branch|upstream-only-noise/,
  );
});
