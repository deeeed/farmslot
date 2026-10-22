// Real Git history exceeds the default per-test budget on loaded farm nodes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { gitDiffArgs } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import type { ReviewDiffSnapshot } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';

import { assertReviewCommentLines, readReviewCommentDiff } from './validate-comments.js';
const snapshot: ReviewDiffSnapshot = {
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  capturedAt: '2026-10-22T00:00:00.000Z',
  source: 'github-pr',
};
const comment = {
  path: 'src/translate-error.ts',
  line: 381,
  severity: 'minor',
  body: 'Handle the missing value.',
};
test('renamed files admit only their actual diff hunks', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'review-rename-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: repo });
  await git(['init', '-q']);
  const content =
    Array.from({ length: 30 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join('\n') +
    '\n';
  await writeFile(path.join(repo, 'old.ts'), content);
  const commit = async () => {
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Fixture',
    ]);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  };
  const baseSha = await commit();
  await rename(path.join(repo, 'old.ts'), path.join(repo, 'new.ts'));
  await writeFile(path.join(repo, 'new.ts'), content.replace('value15 = 15', 'value15 = 150'));
  const headSha = await commit();
  const run = makeRun();
  run.reviewWorkspace = {
    workspaceId: 'rename',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: repo,
    taskPath: repo,
    artifactPath: repo,
  };
  const frozen = { ...snapshot, baseSha, headSha };
  const read = (_run: typeof run, scope: ReviewDiffSnapshot, file: string) =>
    readReviewCommentDiff(run, scope, file, {
      runCommand: (args) => git(args[0] === 'diff' ? gitDiffArgs(args.slice(1)) : args),
    });
  await assert.rejects(
    assertReviewCommentLines(run, [{ ...comment, path: 'new.ts', line: 1 }], frozen, read),
    /RIGHT-side diff/,
  );
  await assertReviewCommentLines(run, [{ ...comment, path: 'new.ts', line: 15 }], frozen, read);
});
