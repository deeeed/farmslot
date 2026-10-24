import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  armLocalWorkspace,
  type WorkspaceBinding,
  WorkspaceObservations,
} from './workspace-observations.js';

const key = { family: 'workspace' as const, slotId: 'slot-a' };
test('panels share a single source; changes during I/O, failure, recovery and reuse fence reads', async () => {
  let changed!: () => void;
  let fail!: (e: Error) => void;
  let arms = 0;
  let stops = 0;
  let current = true;
  const publications: unknown[] = [];
  const owner = new WorkspaceObservations((key) => publications.push(key));
  const binding: WorkspaceBinding = {
    root: '/owned',
    sourceId: 'same',
    keys: [key],
    current: async () => current,
    arm: async (onChange, onFailure) => {
      arms++;
      changed = onChange;
      fail = onFailure;
      return () => {
        stops++;
      };
    },
  };
  const [a, b] = await Promise.all([owner.capture(binding), owner.capture(binding)]);
  assert.equal(arms, 1);
  await a();
  await b();
  changed();
  await assert.rejects(a(), /changed during/);
  assert.equal(publications.length, 1);
  const after = await owner.capture(binding);
  fail(new Error('watch lost'));
  await assert.rejects(after(), /changed during/);
  const recovered = await owner.capture(binding);
  assert.equal(arms, 2);
  await recovered();
  current = false;
  await assert.rejects(recovered(), /changed during/);
  owner.release('same');
  assert.ok(stops >= 2);
});

test('unsupported/failed arm never grants readiness', async () => {
  const owner = new WorkspaceObservations(() => {});
  await assert.rejects(
    owner.capture({
      root: '/old-node',
      sourceId: 'old',
      keys: [key],
      current: async () => true,
      arm: async () => {
        throw new Error('workspace producer unsupported');
      },
    }),
    /unsupported/,
  );
});

test('real recursive source sees arbitrary nested creation, byte replacement and deletion without rereads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'workspace-observer-'));
  let revision = 0;
  let failure: Error | undefined;
  const stop = await armLocalWorkspace(
    root,
    () => revision++,
    (e) => {
      failure = e;
    },
  );
  t.after(async () => {
    stop();
    await rm(root, { recursive: true, force: true });
  });
  const untilChanged = async (before: number) => {
    const end = Date.now() + 900;
    while (revision === before && !failure && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(failure, undefined);
    assert.ok(revision > before, 'source event must follow the causal filesystem mutation');
  };
  let before = revision;
  await mkdir(path.join(root, 'new'));
  await untilChanged(before);
  before = revision;
  await writeFile(path.join(root, 'new', 'file.txt'), 'first');
  await untilChanged(before);
  before = revision;
  await writeFile(path.join(root, 'new', 'file.txt'), 'replacement');
  await untilChanged(before);
  before = revision;
  await rm(path.join(root, 'new'), { recursive: true });
  await untilChanged(before);
});

test('linked worktree git index and HEAD live outside cwd but invalidate the same source', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const git = promisify(execFile);
  const home = await mkdtemp(path.join(tmpdir(), 'workspace-git-observer-'));
  const repository = path.join(home, 'repository');
  const worktree = path.join(home, 'worktree');
  await mkdir(repository);
  const run = (cwd: string, args: string[]) =>
    git(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Workspace Test',
        '-c',
        'user.email=workspace@example.test',
        ...args,
      ],
      { cwd },
    );
  await run(repository, ['init']);
  await writeFile(path.join(repository, 'file'), 'base');
  await run(repository, ['add', 'file']);
  await run(repository, ['commit', '-m', 'base']);
  await run(repository, ['worktree', 'add', '-b', 'workspace-proof', worktree]);
  let revision = 0;
  let failure: Error | undefined;
  const stop = await armLocalWorkspace(
    worktree,
    () => revision++,
    (error) => {
      failure = error;
    },
  );
  t.after(async () => {
    stop();
    await rm(home, { recursive: true, force: true });
  });
  const changed = async (before: number) => {
    const deadline = Date.now() + 900;
    while (revision === before && !failure && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(failure, undefined);
    assert.ok(revision > before);
  };
  // No worktree byte write: --intent-to-add changes the external index only.
  await writeFile(path.join(worktree, 'untracked'), 'new');
  await new Promise((resolve) => setTimeout(resolve, 20));
  let before = revision;
  await run(worktree, ['add', '-N', 'untracked']);
  await changed(before);
  // Empty commit moves external HEAD/refs without changing workspace file bytes.
  before = revision;
  await run(worktree, ['commit', '--allow-empty', '-m', 'head-only']);
  await changed(before);
});

test('release during a pending arm closes the late handle and ignores former callbacks', async () => {
  let finish!: (stop: () => void) => void;
  let change!: () => void;
  let closed = 0;
  const published: unknown[] = [];
  const owner = new WorkspaceObservations((key) => published.push(key));
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = owner.capture({
    root: '/owned',
    sourceId: 'pending',
    keys: [key],
    current: async () => true,
    arm: async (changed) => {
      change = changed;
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await entering;
  owner.release('pending');
  const afterRelease = published.length;
  change();
  finish(() => {
    closed++;
  });
  await assert.rejects(pending, /replaced while arming/);
  assert.equal(closed, 1);
  assert.equal(published.length, afterRelease);
});

test('live failure closes its owned watcher before publishing invalidation', async () => {
  let fail!: (error: Error) => void;
  let closed = false;
  const published: boolean[] = [];
  const owner = new WorkspaceObservations(() => published.push(closed));
  await owner.capture({
    root: '/owned',
    sourceId: 'live',
    keys: [key],
    current: async () => true,
    arm: async (_, failed) => {
      fail = failed;
      return () => {
        closed = true;
      };
    },
  });
  fail(new Error('lost source'));
  assert.deepEqual(published, [true]);
  owner.release('live');
});
