import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executionTemplateSourceDirty,
  executionTemplateSourceDirtyAsync,
  executionTemplateSourceRevision,
  executionTemplateSourceRevisionAsync,
} from '@farmslot/agent-runtime';

import { runExecutionTemplateGit } from './execution-template-git.js';

test('the gateway git runner answers as the synchronous source reads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'template-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await writeFile(path.join(repo, 'a.md'), '# A\n');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '-m',
    'a',
  ]);
  const plain = path.join(root, 'plain');
  await mkdir(plain);
  const answers = async (dir: string) => ({
    revision: await executionTemplateSourceRevisionAsync(dir, runExecutionTemplateGit),
    dirty: await executionTemplateSourceDirtyAsync(dir, runExecutionTemplateGit),
  });
  const synchronous = (dir: string) => ({
    revision: executionTemplateSourceRevision(dir),
    dirty: executionTemplateSourceDirty(dir),
  });
  assert.deepEqual(await answers(repo), synchronous(repo));
  await writeFile(path.join(repo, 'a.md'), '# A changed\n');
  assert.deepEqual(await answers(repo), synchronous(repo));
  assert.equal(synchronous(repo).dirty, true);
  assert.deepEqual(await answers(plain), { revision: undefined, dirty: undefined });
  assert.deepEqual(synchronous(plain), { revision: undefined, dirty: undefined });
});

test('git stdout over 1 MiB is no answer, as spawnSync reports it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-git-'));
  await writeFile(path.join(dir, 'git'), "#!/bin/sh\nhead -c 1100000 /dev/zero | tr '\\0' a\n", {
    mode: 0o755,
  });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  t.after(async () => {
    process.env.PATH = saved;
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(executionTemplateSourceDirty(dir), undefined);
  assert.equal((await runExecutionTemplateGit(['status'])).status, null);
  assert.equal(await executionTemplateSourceDirtyAsync(dir, runExecutionTemplateGit), undefined);
});
