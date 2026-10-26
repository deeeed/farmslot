import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GIT_DIFF_COMMAND } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import { reviewSnapshotIdentityText } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

import {
  captureCurrentReviewSnapshot,
  parseReviewSnapshotArtifact,
  parseUntrackedFileManifest,
  preferredRemoteReviewBaseRef,
  reviewAttemptFromResult,
  reviewDeltaSinceReviewedHead,
  tmuxListReviewWindowIdsSnippet,
} from './snapshots.js';

test('untracked manifest binds paths, modes, and blob identities into the review diff', () => {
  const emptyBlob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  const files = parseUntrackedFileManifest(
    [
      '100644',
      emptyBlob,
      'empty file.ts',
      '100755',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'src/a.ts',
      '',
    ].join('\0'),
  );

  assert.deepEqual(files, [
    { path: 'empty file.ts', blobSha: emptyBlob, mode: '100644' },
    { path: 'src/a.ts', blobSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: '100755' },
  ]);
  const diff = reviewSnapshotIdentityText('', files);
  assert.match(diff, new RegExp(emptyBlob));
  assert.match(diff, /"empty file\.ts"/);
  assert.notEqual(
    diff,
    reviewSnapshotIdentityText('', [{ path: 'renamed.ts', blobSha: emptyBlob, mode: '100644' }]),
  );
  assert.notEqual(
    diff,
    reviewSnapshotIdentityText('', [
      { path: 'empty file.ts', blobSha: emptyBlob, mode: '100755' },
      { path: 'src/a.ts', blobSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: '100755' },
    ]),
  );
});

test('untracked manifest rejects truncated entries', () => {
  assert.throws(
    () => parseUntrackedFileManifest('100644\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0'),
    /field count/i,
  );
  assert.throws(() => parseUntrackedFileManifest('100644\0'), /field count/i);
});

test('parseReviewSnapshotArtifact rejects a missing or invalid launch snapshot', () => {
  assert.equal(parseReviewSnapshotArtifact(''), null);
  assert.equal(
    parseReviewSnapshotArtifact(
      JSON.stringify({ source: 'local-git', capturedAt: '2026-08-03T00:00:00.000Z' }),
    ),
    null,
  );
  assert.equal(
    parseReviewSnapshotArtifact(
      JSON.stringify({
        source: 'local-git',
        capturedAt: '2026-08-03T00:00:00.000Z',
        headSha: 'deadbeef',
      }),
    )?.headSha,
    'deadbeef',
  );
});

test('tmuxListReviewWindowIdsSnippet lists review windows by id, not ambiguous name target', () => {
  const snippet = tmuxListReviewWindowIdsSnippet('mme-1');

  assert.match(snippet, /list-windows -t 'mme-1'/);
  assert.match(snippet, /window_id/);
  assert.match(snippet, /window_name/);
  assert.match(snippet, /review/);
  assert.doesNotMatch(snippet, /list-panes -t .*:review/);
  assert.doesNotMatch(snippet, /kill-window/);
});

test('preferredRemoteReviewBaseRef refreshes remote branches without rewriting explicit refs', () => {
  assert.equal(preferredRemoteReviewBaseRef('main'), 'origin/main');
  assert.equal(preferredRemoteReviewBaseRef('release/1.2'), 'origin/release/1.2');
  assert.equal(preferredRemoteReviewBaseRef('origin/main'), 'origin/main');
  assert.equal(preferredRemoteReviewBaseRef('refs/heads/main'), null);
});

test('incomplete reviewer output records a skipped attempt, never a pass', () => {
  const attempt = reviewAttemptFromResult({ verdict: 'pass', issues: [], incomplete: true }, 3);
  assert.equal(attempt.verdict, 'skipped');
  assert.equal(attempt.unresolvedCount, 0);
  assert.deepEqual(attempt.artifactPaths, []);
  assert.ok(attempt.completedAt);
});

test('COLD captures the full immutable PR range; WARM uses exactly the verified prior head', async () => {
  const commands: string[] = [];
  const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const base = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const prior = 'cccccccccccccccccccccccccccccccccccccccc';
  const deps: NonNullable<Parameters<typeof captureCurrentReviewSnapshot>[2]> = {
    resolveContext: async () => ({ baseRef: 'origin/main', pathspecs: ['.', ':(exclude)tasks'] }),
    exec: async (_vars, command) => {
      commands.push(command);
      let stdout = '';
      if (command === 'git rev-parse HEAD') stdout = head;
      else if (command.startsWith('git merge-base') && !command.includes('--is-ancestor'))
        stdout = base;
      else if (command.includes('--abbrev-ref')) stdout = 'feature';
      else if (command.includes('--numstat')) stdout = '1\t1\tsrc/a.ts';
      else if (command.startsWith(GIT_DIFF_COMMAND)) stdout = 'diff --git a/src/a.ts b/src/a.ts';
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
  const cold = await captureCurrentReviewSnapshot(makeVars(), { mode: 'cold' }, deps);
  assert.equal(cold.snapshot.baseSha, base);
  assert.equal(cold.snapshot.headSha, head);
  assert.ok(
    commands
      .filter((command) => command.startsWith(GIT_DIFF_COMMAND))
      .every((command) => command.includes(base) && command.includes(head)),
  );
  assert.ok(!commands.some((command) => command.includes('ls-files')));
  commands.length = 0;
  const warm = await captureCurrentReviewSnapshot(
    makeVars(),
    { mode: 'warm', lastReviewedHeadSha: prior },
    deps,
  );
  assert.equal(warm.snapshot.baseSha, prior);
  assert.equal(warm.snapshot.headSha, head);
  assert.ok(commands.some((command) => command.includes(`--is-ancestor '${prior}' '${head}'`)));
  assert.ok(
    commands
      .filter((command) => command.startsWith(GIT_DIFF_COMMAND))
      .every((command) => command.includes(prior) && command.includes(head)),
  );
  const invalid = await captureCurrentReviewSnapshot(
    makeVars(),
    { mode: 'warm', lastReviewedHeadSha: prior },
    {
      ...deps,
      exec: async (...args) =>
        args[1].includes('--is-ancestor')
          ? { exitCode: 1, stdout: '', stderr: '' }
          : deps.exec(...args),
    },
  );
  assert.equal(invalid.snapshot.source, 'unavailable');
  assert.match(invalid.snapshot.error ?? '', /not an ancestor/);
});

// A real diff proves that source-only filters cannot hide changed documentation.
test('immutable review ranges include committed text and docs excluded by source filters', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-whole-diff-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    await writeFile(path.join(repo, 'README.md'), 'old guide\n');
    await writeFile(path.join(repo, 'message.txt'), 'old message\n');
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
    const prior = git('rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'README.md'), 'new guide\n');
    await writeFile(path.join(repo, 'message.txt'), 'new message\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'test: change',
    );
    const deps: NonNullable<Parameters<typeof captureCurrentReviewSnapshot>[2]> = {
      resolveContext: async () => ({ baseRef: prior, pathspecs: ['*.ts'] }),
      exec: async (_vars, command) => ({
        exitCode: 0,
        stdout: execFileSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' }),
        stderr: '',
      }),
    };
    for (const range of [
      { mode: 'cold' as const },
      { mode: 'warm' as const, lastReviewedHeadSha: prior },
    ]) {
      const captured = await captureCurrentReviewSnapshot(makeVars(), range, deps);
      assert.equal(captured.snapshot.diffStat?.files, 2);
      assert.match(captured.diffText!, /README\.md/);
      assert.match(captured.diffText!, /message\.txt/);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ADR-063 Amendment 5: after a rebase the delta is the branch's own change at both heads.
test('a rebased lineage delta compares its own change with range-diff and leaves base-only changes out', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-range-diff-'));
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
  git('init', '-q', '-b', 'main');
  const forkPoint = await commit('base.txt', 'base\n', 'test: base');
  git('checkout', '-qb', 'feature');
  const reviewed = await commit('feature.txt', 'first\n', 'feat: reviewed change');
  git('checkout', '-q', 'main');
  const mainHead = await commit('main-only.txt', 'from the base branch\n', 'chore: base only');
  git('checkout', '-q', 'feature');
  git('rebase', '-q', 'main');
  const rebased = git('rev-parse', 'HEAD');
  const current = await commit('feature.txt', 'fixed\n', 'fix: address finding');
  const exec = async (command: string) => {
    try {
      return {
        exitCode: 0,
        stdout: execFileSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' }),
        stderr: '',
      };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: failed.status ?? 1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      };
    }
  };

  const delta = await reviewDeltaSinceReviewedHead(exec, {
    lastReviewedHeadSha: reviewed,
    headSha: current,
    baseRef: 'main',
  });
  assert.deepEqual(delta.comparedRanges, [`${forkPoint}..${reviewed}`, `${mainHead}..${current}`]);
  // The reviewed commit carried over unchanged; the fix is the only new commit.
  assert.match(delta.rangeDiff ?? '', /= 1: +[0-9a-f]+ feat: reviewed change/);
  assert.match(delta.rangeDiff ?? '', /> 2: +[0-9a-f]+ fix: address finding/);
  assert.doesNotMatch(delta.rangeDiff ?? '', /main-only|from the base branch|chore: base only/);
  // While the head descends from the reviewed head, the delta is last..head.
  assert.deepEqual(
    await reviewDeltaSinceReviewedHead(exec, {
      lastReviewedHeadSha: rebased,
      headSha: current,
      baseRef: 'main',
    }),
    { comparedRanges: [`${rebased}..${current}`] },
  );
});

test('working-tree review counts tracked and real untracked identities without patch rows', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-numstat-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  await writeFile(path.join(repo, 'tracked.ts'), 'export const value = 1;\n');
  git('add', '.');
  git(
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'test: seed',
  );
  const base = git('rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'tracked.ts'), 'export const value = 2;\n');
  await writeFile(path.join(repo, 'new file.ts'), 'export const added = true;\n');
  await writeFile(path.join(repo, 'empty.ts'), '');
  const deps: NonNullable<Parameters<typeof captureCurrentReviewSnapshot>[2]> = {
    resolveContext: async () => ({ baseRef: base, pathspecs: [] }),
    exec: async (_vars, command) => ({
      exitCode: 0,
      stdout: execFileSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' }),
      stderr: '',
    }),
  };
  const captured = await captureCurrentReviewSnapshot(makeVars(), undefined, deps);
  assert.deepEqual(captured.snapshot.diffStat, { files: 3, additions: 2, deletions: 1 });
  assert.deepEqual(
    captured.snapshot.untrackedFiles?.map(({ path }) => path),
    ['empty.ts', 'new file.ts'],
  );
  assert.match(captured.diffText ?? '', /diff --git/);
  assert(captured.snapshot.diffHash);
});

test('a base-only override preserves source pathspecs and untracked identities', async () => {
  const commands: string[] = [];
  const base = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const blob = 'cccccccccccccccccccccccccccccccccccccccc';
  const result = await captureCurrentReviewSnapshot(
    makeVars(),
    { baseRef: 'feature/parent' },
    {
      resolveContext: async (_vars, requestedBase) => {
        assert.equal(requestedBase, 'feature/parent');
        return { baseRef: 'origin/feature/parent', pathspecs: ['src'] };
      },
      exec: async (_vars, command) => {
        commands.push(command);
        const stdout =
          command === 'git rev-parse HEAD'
            ? head
            : command.startsWith('git merge-base')
              ? base
              : command.includes('--abbrev-ref')
                ? 'fix/child'
                : command.includes('--numstat')
                  ? '1\t0\tsrc/changed.ts\n'
                  : command.includes('ls-files')
                    ? `100644\0${blob}\0src/new.ts\0`
                    : 'diff --git a/src/changed.ts b/src/changed.ts\n';
        return { exitCode: 0, stdout, stderr: '' };
      },
    },
  );
  assert.equal(result.snapshot.baseRef, 'origin/feature/parent');
  assert.equal(result.snapshot.baseSha, base);
  assert.deepEqual(result.snapshot.untrackedFiles, [
    { path: 'src/new.ts', blobSha: blob, mode: '100644' },
  ]);
  assert.ok(commands.some((command) => command.includes('ls-files')));
  assert.ok(
    commands
      .filter((command) => command.includes('--numstat') || command.includes('--full-index'))
      .every((command) => command.includes("'src'")),
  );
});

test('a committed maintenance range never resolves or reads mutable endpoints', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const commands: string[] = [];
  const result = await captureCurrentReviewSnapshot(
    makeVars(),
    {
      baseRef: 'parent',
      committedBaseSha: base,
      committedHeadSha: head,
    },
    {
      resolveContext: async () => {
        throw new Error('Mutable base resolution must not run');
      },
      exec: async (_vars, command) => {
        commands.push(command);
        const stdout = command.includes('--abbrev-ref')
          ? 'child'
          : command.includes('--numstat')
            ? '1\t0\towned.txt\n'
            : 'verified committed diff\n';
        return { exitCode: 0, stdout, stderr: '' };
      },
    },
  );
  assert.equal(result.snapshot.baseSha, base);
  assert.equal(result.snapshot.headSha, head);
  assert.equal(result.snapshot.baseRef, 'parent');
  assert.ok(commands.some((command) => command.includes(`'${base}' '${head}' -- '.'`)));
  assert.ok(commands.every((command) => !/merge-base|rev-parse HEAD|ls-files/.test(command)));
});
