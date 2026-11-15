import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { observeRecipeCaptureSource } from '../src/evidence/comparisons.js';

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  ).trim();
}

async function checkout(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capture-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

async function matchesPreviousObservation(root: string): Promise<void> {
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const sourceDirty = Boolean(
    git(root, 'status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none'),
  );
  assert.deepEqual(await observeRecipeCaptureSource(root), { sourceCommit, sourceDirty });
}

test('capture source remains fresh across tracked edits, stages, renames and commits', async (t) => {
  const root = await checkout(t);
  await matchesPreviousObservation(root);
  await writeFile(path.join(root, 'untracked.txt'), 'not part of tracked dirty state\n');
  assert.equal((await observeRecipeCaptureSource(root)).sourceDirty, false);
  await writeFile(path.join(root, 'source.txt'), 'edited\n');
  await matchesPreviousObservation(root);
  git(root, 'add', 'source.txt');
  await matchesPreviousObservation(root);
  // NUL records keep a filename resembling a header from becoming branch metadata.
  await rename(path.join(root, 'source.txt'), path.join(root, '# branch.oid fake\nname.txt'));
  git(root, 'add', '-A');
  await matchesPreviousObservation(root);
  const before = await observeRecipeCaptureSource(root);
  git(root, 'commit', '-qm', 'moved');
  const after = await observeRecipeCaptureSource(root);
  assert.notEqual(after.sourceCommit, before.sourceCommit);
  assert.equal(after.sourceDirty, false);
  await matchesPreviousObservation(root);
  await rm(path.join(root, '# branch.oid fake\nname.txt'));
  await matchesPreviousObservation(root);
});

test('capture source supports detached HEAD, packed refs, linked worktrees and nested roots', async (t) => {
  const root = await checkout(t);
  git(root, 'pack-refs', '--all', '--prune');
  await matchesPreviousObservation(root);
  const linked = path.join(root, 'linked');
  git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  await matchesPreviousObservation(linked);
  git(root, 'checkout', '-q', '--detach');
  await matchesPreviousObservation(root);
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  await matchesPreviousObservation(nested);
});

test('unborn and non-Git roots retain unknown source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capture-no-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await observeRecipeCaptureSource(root), {});
  git(root, 'init', '-q');
  await writeFile(path.join(root, 'new.txt'), 'staged without a commit\n');
  git(root, 'add', 'new.txt');
  assert.deepEqual(await observeRecipeCaptureSource(root), {});
});

test('capture source sees submodule edits even when the submodule is configured as ignored', async (t) => {
  const child = await checkout(t);
  const root = await checkout(t);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub');
  git(root, 'commit', '-qam', 'submodule');
  git(root, 'config', 'submodule.sub.ignore', 'all');
  await matchesPreviousObservation(root);
  await writeFile(path.join(root, 'sub', 'source.txt'), 'changed inside submodule\n');
  assert.equal((await observeRecipeCaptureSource(root)).sourceDirty, true);
  await matchesPreviousObservation(root);
});

test('each capture source observation stays within one Git subprocess', async (t) => {
  const root = await checkout(t);
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'git-calls.jsonl');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await mkdir(bin);
  await writeFile(
    path.join(bin, 'git'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = cp.spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  for (let count = 1; count <= 2; count += 1) {
    const observation = await observeRecipeCaptureSource(root);
    assert.ok(observation.sourceCommit);
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(calls.length, count, 'every fresh observation uses exactly one Git subprocess');
  }
});

test('capture source handles status v2 output larger than the default subprocess buffer', async (t) => {
  const root = await checkout(t);
  const files = Array.from({ length: 9_000 }, (_, index) => `M 100644 :1 f${index}.txt`);
  // Import the tree without checking it out: every imported file is a tracked deletion.
  execFileSync('git', ['fast-import', '--quiet'], {
    cwd: root,
    input: [
      'blob',
      'mark :1',
      'data 1',
      'x',
      'commit refs/heads/large-status',
      'committer Fixture <fixture@example.test> 1 +0000',
      'data 5',
      'large',
      ...files,
      '',
    ].join('\n'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  git(root, 'reset', '--mixed', 'refs/heads/large-status');
  const previousStatus = git(root, 'status', '--porcelain=v1', '--untracked-files=no');
  assert.ok(Buffer.byteLength(previousStatus) < 1024 * 1024);
  const statusV2 = execFileSync('git', ['status', '--porcelain=v2', '--untracked-files=no'], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.ok(statusV2.byteLength > 1024 * 1024);
  await matchesPreviousObservation(root);
});
