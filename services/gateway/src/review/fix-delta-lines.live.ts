// Manual Git capture proof; subprocess-heavy checks stay outside the default suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeVars } from '../runners/test-fixtures.js';

import { captureFixDeltaSnapshot } from './snapshots.js';

for (const kind of ['text', 'binary', 'untracked', 'evidence'] as const) {
  test(`fix source-line measurement distinguishes ${kind} changes`, async (t) => {
    const repo = await mkdtemp(path.join(tmpdir(), 'review-fix-lines-'));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    await writeFile(
      path.join(repo, 'a.ts'),
      kind === 'binary' ? Buffer.from([0, 1, 2]) : 'export const value = 1;\n',
    );
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: seed',
    );
    const base = git('rev-parse', 'HEAD');
    if (kind === 'text')
      await writeFile(
        path.join(repo, 'a.ts'),
        Array.from({ length: 49 }, (_, i) => `const item${i} = ${i};\n`).join(''),
      );
    if (kind === 'binary') await writeFile(path.join(repo, 'a.ts'), Buffer.from([0, 9, 2]));
    if (kind === 'untracked')
      await writeFile(path.join(repo, 'new.ts'), 'export const added = 1;\n');
    if (kind === 'evidence') {
      await mkdir(path.join(repo, '.task'), { recursive: true });
      await writeFile(path.join(repo, '.task/proof.json'), '{"passed":true}\n');
    }
    const captured = await captureFixDeltaSnapshot(
      makeVars({ repo, remoteRepo: repo }),
      '.task/review',
      2,
      base,
    );
    assert.equal(captured.snapshot.source, 'local-git');
    assert.equal(
      captured.sourceLinesChanged,
      kind === 'text' ? 50 : kind === 'evidence' ? 0 : undefined,
    );
  });
}
