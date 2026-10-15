import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GIT_DIFF_COMMAND, gitDiffArgs } from '@farmslot/agent-runtime/scripts/git-diff.cjs';

import { reviewDiffHash } from '../core/review-diff-identity.js';
import { captureCurrentReviewSnapshot } from '../review/snapshots.js';
import { makeVars } from '../runners/test-fixtures.js';

import { cappedGitDiffCommand, cappedRunSourceDiffCommand } from './diff-artifacts.js';

function fixture(t: TestContext) {
  const repo = mkdtempSync(path.join(tmpdir(), 'farmslot-diff-config-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const shell = (command: string) =>
    execFileSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' });
  const write = (file: string, content: string) => writeFileSync(path.join(repo, file), content);
  const configure = (sections: Record<string, string[]>) =>
    appendFileSync(
      path.join(repo, '.git/config'),
      Object.entries(sections)
        .map(([section, entries]) => `[${section}]\n${entries.join('\n')}\n`)
        .join(''),
    );
  const commit = () => {
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
      'test: fixture',
    );
    return git('rev-parse', 'HEAD').trim();
  };
  git('init', '-q');
  write('tracked.ts', 'export const value = 1;\n');
  const base = commit();
  write('tracked.ts', 'export const value = 2;\n');
  return { repo, git, shell, write, commit, configure, base };
}

test('workspace, COLD and WARM captures share identity under mnemonic and no-prefix config', async (t) => {
  const f = fixture(t);
  const expected = reviewDiffHash(f.shell(cappedRunSourceDiffCommand(f.base, [])));
  f.configure({ diff: ['mnemonicPrefix=true'] });
  const inherited = f.git('diff', f.base);
  assert.match(inherited, /diff --git c\/tracked.ts w\/tracked.ts/);
  assert.notEqual(reviewDiffHash(inherited), expected);
  assert.equal(reviewDiffHash(f.shell(cappedRunSourceDiffCommand(f.base, []))), expected);
  const head = f.commit();
  f.configure({ diff: ['noprefix=true'], color: ['ui=always'] });
  const deps: NonNullable<Parameters<typeof captureCurrentReviewSnapshot>[2]> = {
    resolveContext: async () => ({ baseRef: f.base, pathspecs: [] }),
    exec: async (_vars, command) => ({ exitCode: 0, stdout: f.shell(command), stderr: '' }),
  };
  for (const range of [
    { mode: 'cold' as const, committedBaseSha: f.base, committedHeadSha: head },
    {
      mode: 'warm' as const,
      lastReviewedHeadSha: f.base,
      committedBaseSha: f.base,
      committedHeadSha: head,
    },
  ]) {
    const capture = await captureCurrentReviewSnapshot(makeVars(), range, deps);
    assert.equal(capture.snapshot.diffHash, expected);
    assert.deepEqual(capture.snapshot.diffStat, { files: 1, additions: 1, deletions: 1 });
    assert.match(capture.diffText ?? '', /diff --git a\/tracked.ts b\/tracked.ts/);
    assert.doesNotMatch(capture.diffText ?? '', /\u001b\[/);
  }
  // This is also the base-to-worktree producer used by review fix-delta capture.
  assert.equal(reviewDiffHash(f.shell(cappedRunSourceDiffCommand(f.base, []))), expected);
  f.write('tracked.ts', 'export const value = 3;\n');
  assert.notEqual(reviewDiffHash(f.shell(cappedRunSourceDiffCommand(f.base, []))), expected);
});

test('tracked and untracked patches ignore external diff, textconv, color and formatting config', (t) => {
  const f = fixture(t);
  f.write('untracked.ts', 'export const added = true;\n');
  const expected = f.shell(cappedRunSourceDiffCommand(f.base, []));
  const marker = path.join(f.repo, 'helper-ran');
  const converter = path.join(f.repo, 'converter.sh');
  writeFileSync(converter, '#!/bin/sh\ntouch "$0.ran"\nprintf altered\\n\n', { mode: 0o755 });
  f.write('.gitattributes', '*.ts diff=hostile\n');
  f.configure({
    diff: [
      `external=touch ${marker}`,
      'noprefix=true',
      'context=0',
      'algorithm=histogram',
      'outputIndicatorNew=>',
    ],
    'diff "hostile"': [`textconv=${converter}`],
    color: ['diff=always'],
  });
  // Restrict pathspecs so the config fixture itself does not change the source identity.
  const actual = f.shell(cappedRunSourceDiffCommand(f.base, ['*.ts']));
  assert.equal(actual, expected);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(`${converter}.ran`), false);
  assert.match(actual, /diff --git a\/untracked.ts b\/untracked.ts/);
  assert.doesNotMatch(actual, /\u001b\[/);
  assert.equal(
    f.git(...gitDiffArgs([f.base, '--', 'tracked.ts'])),
    f.shell(`${GIT_DIFF_COMMAND} ${f.base} -- tracked.ts`),
  );
  assert.equal(
    f.shell(cappedGitDiffCommand(f.base, ['tracked.ts'])),
    f.git(...gitDiffArgs(['--binary', '--full-index', f.base, '--', 'tracked.ts'])),
  );
  f.write('untracked.ts', 'export const added = false;\n');
  assert.notEqual(f.shell(cappedRunSourceDiffCommand(f.base, ['*.ts'])), expected);
});
