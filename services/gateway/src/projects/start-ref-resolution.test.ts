import assert from 'node:assert/strict';
import { exec as execCb } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  __startRefResolutionTest,
  resolveStartRefInRepo,
  sanitizeStartRef,
} from './start-ref-resolution.js';

const exec = promisify(execCb);

async function sh(command: string, cwd?: string) {
  const { stdout, stderr } = await exec(command, { cwd });
  return { stdout, stderr, exitCode: 0 };
}

async function shResult(command: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    execCb(command, (error, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: typeof error?.code === 'number' ? error.code : 0 });
    });
  });
}

test('sanitizeStartRef rejects shell-shaped and refspec-shaped input', () => {
  for (const ref of [
    '',
    'main branch',
    'main..other',
    'main^{commit}',
    '-main',
    'main:other',
    'main;echo nope',
  ]) {
    assert.throws(() => sanitizeStartRef(ref));
  }
});

test('start ref candidate refs ignore local branches and target fetched remote refs/tags', () => {
  assert.deepEqual(__startRefResolutionTest.startRefCandidateRefs('feature/a'), [
    'refs/remotes/origin/feature/a',
  ]);
  assert.deepEqual(__startRefResolutionTest.startRefCandidateRefs('refs/heads/feature/a'), [
    'refs/remotes/origin/feature/a',
  ]);
  assert.deepEqual(__startRefResolutionTest.startRefCandidateRefs('origin/feature/a'), [
    'refs/remotes/origin/feature/a',
  ]);
  assert.deepEqual(__startRefResolutionTest.startRefCandidateRefs('refs/tags/v1.0.0'), []);
  assert.equal(__startRefResolutionTest.shouldResolveFetchedRemoteTag('feature/a'), true);
  assert.equal(__startRefResolutionTest.shouldResolveFetchedRemoteTag('origin/feature/a'), false);
  assert.equal(
    __startRefResolutionTest.shouldResolveFetchedRemoteTag('refs/heads/feature/a'),
    false,
  );
  assert.equal(__startRefResolutionTest.shouldResolveFetchedRemoteTag('refs/tags/v1.0.0'), true);
});

test('resolveStartRefInRepo resolves fetched remote branch and rejects local-only branch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  await sh('git checkout -b feature/replay', source);
  await sh('printf feature > file.txt && git commit -am feature', source);
  await sh('git tag replay-tag', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main feature/replay --tags', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);
  await sh('git checkout -b local-only', clone);

  const execInRepo = (command: string) => shResult(command);
  const resolved = await resolveStartRefInRepo({
    repo: clone,
    requestedRef: 'feature/replay',
    exec: execInRepo,
  });
  const expected = (
    await sh('git rev-parse refs/remotes/origin/feature/replay^{commit}', clone)
  ).stdout.trim();
  assert.equal(resolved.resolvedSha, expected);

  await assert.rejects(
    () => resolveStartRefInRepo({ repo: clone, requestedRef: 'local-only', exec: execInRepo }),
    /not found on fetched origin branches\/tags/,
  );
});

test('resolveStartRefInRepo rejects local-only commit SHA', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-sha-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);
  await sh('git config user.email test@example.com', clone);
  await sh('git config user.name Test', clone);
  await sh('git checkout -b local-only-work', clone);
  await sh('printf local > local.txt && git add local.txt && git commit -m local-only', clone);
  const localSha = (await sh('git rev-parse HEAD', clone)).stdout.trim();

  await assert.rejects(
    () =>
      resolveStartRefInRepo({
        repo: clone,
        requestedRef: localSha,
        exec: (command) => shResult(command),
      }),
    /not reachable from fetched origin refs\/tags/,
  );
});

test('resolveStartRefInRepo rejects SHA reachable only from a local tag', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-local-tag-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);
  await sh('git config user.email test@example.com', clone);
  await sh('git config user.name Test', clone);
  await sh('git checkout -b local-only-work', clone);
  await sh('printf local > local.txt && git add local.txt && git commit -m local-only', clone);
  await sh('git tag local-only-tag', clone);
  const localSha = (await sh('git rev-parse HEAD', clone)).stdout.trim();

  await assert.rejects(
    () =>
      resolveStartRefInRepo({
        repo: clone,
        requestedRef: localSha,
        exec: (command) => shResult(command),
      }),
    /not reachable from fetched origin refs\/tags/,
  );
});

test('resolveStartRefInRepo rejects local-only tag names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-local-tag-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);
  await sh('git tag local-only-tag', clone);

  await assert.rejects(
    () =>
      resolveStartRefInRepo({
        repo: clone,
        requestedRef: 'local-only-tag',
        exec: (command) => shResult(command),
      }),
    /not found on fetched origin branches\/tags/,
  );
});

test('resolveStartRefInRepo accepts SHA reachable only from a fetched remote tag', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-remote-tag-sha-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main', source);
  await sh(
    'printf tag-only > tag-only.txt && git add tag-only.txt && git commit -m tag-only',
    source,
  );
  await sh('git tag tag-only-release', source);
  const tagOnlySha = (await sh('git rev-parse HEAD', source)).stdout.trim();
  await sh('git push origin refs/tags/tag-only-release:refs/tags/tag-only-release', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);

  const resolved = await resolveStartRefInRepo({
    repo: clone,
    requestedRef: tagOnlySha,
    exec: (command) => shResult(command),
  });

  assert.equal(resolved.resolvedSha, tagOnlySha);
});

test('resolveStartRefInRepo rejects unqualified branch and tag name collisions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  await sh('git checkout -b collision', source);
  await sh(
    'printf branch > branch.txt && git add branch.txt && git commit -m branch-collision',
    source,
  );
  const branchSha = (await sh('git rev-parse HEAD', source)).stdout.trim();
  await sh('git checkout main', source);
  await sh('printf tag > tag.txt && git add tag.txt && git commit -m tag-collision', source);
  const tagSha = (await sh('git rev-parse HEAD', source)).stdout.trim();
  assert.notEqual(branchSha, tagSha);
  await sh('git tag collision', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main', source);
  await sh('git push origin refs/heads/collision:refs/heads/collision', source);
  await sh('git push origin refs/tags/collision:refs/tags/collision', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);

  await assert.rejects(
    () =>
      resolveStartRefInRepo({
        repo: clone,
        requestedRef: 'collision',
        exec: (command) => shResult(command),
      }),
    /ambiguous between fetched remote refs\/tags/,
  );
});

test('resolveStartRefInRepo fetches remote tags without clobbering local tags', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-start-ref-tag-clobber-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'source');
  const remote = path.join(root, 'origin.git');
  const clone = path.join(root, 'clone');

  await sh(`git init --bare ${remote}`);
  await sh(`git init -b main ${source}`);
  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('printf base > file.txt && git add file.txt && git commit -m base', source);
  const baseSha = (await sh('git rev-parse HEAD', source)).stdout.trim();
  await sh('git tag clashing-tag', source);
  await sh(`git remote add origin ${remote}`, source);
  await sh('git push origin main --tags', source);
  await sh(`git --git-dir=${remote} symbolic-ref HEAD refs/heads/main`);
  await sh(`git clone ${remote} ${clone}`);

  await sh('git config user.email test@example.com', source);
  await sh('git config user.name Test', source);
  await sh('git tag -f clashing-tag', source);
  await sh('printf remote-tag > tag.txt && git add tag.txt && git commit -m remote-tag', source);
  const remoteTagSha = (await sh('git rev-parse HEAD', source)).stdout.trim();
  await sh('git tag -f clashing-tag', source);
  await sh('git push --force origin refs/tags/clashing-tag:refs/tags/clashing-tag', source);

  assert.equal((await sh('git rev-parse clashing-tag^{commit}', clone)).stdout.trim(), baseSha);
  const resolved = await resolveStartRefInRepo({
    repo: clone,
    requestedRef: 'clashing-tag',
    exec: (command) => shResult(command),
  });

  assert.equal(resolved.resolvedSha, remoteTagSha);
  assert.equal((await sh('git rev-parse clashing-tag^{commit}', clone)).stdout.trim(), baseSha);
});
