import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

import { cleanupReviewWorkspaceCaches } from './cache-cleanup.js';
import { reclaimReviewWorkspaceStorage, useReviewWorkspaceStorage } from './storage-use.js';

await import('../runtime/mock-pty.test-support.js');

const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-cache-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsDir = path.join(root, '.runs');
  const nativeRoot = path.join(root, 'native-sessions');
  const ownerRoot = path.join(root, 'review-workspaces', hash('owner'));
  const cacheRoot = path.join(runsDir, 'review-workspace-support');
  let runs: Run[] = [];
  const storage = { runsDir, nativeRoot, runs: async () => runs };
  const json = async (file: string, data: unknown) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  };
  const support = async (base = path.join(cacheRoot, 'bundles'), sha = digest) => {
    const directory = path.join(base, sha);
    await json(path.join(directory, 'manifest.json'), { version: 1, sha256: sha, files: [] });
    await writeFile(path.join(directory, 'payload'), 'disposable runtime bytes');
    return directory;
  };
  const run = (id = 'closed', sha = digest) => {
    const result = makeRun({ id, flowType: 'review-pr', status: 'done' });
    result.nativeOwnerPrincipalId = 'owner';
    result.reviewWorkspace = {
      workspaceId: id,
      machine: 'node',
      executionNodeId: 'local',
      checkoutPath: path.join(ownerRoot, 'runs', id, 'source'),
      taskPath: path.join(ownerRoot, 'runs', id, 'task'),
      artifactPath: path.join(ownerRoot, 'runs', id, 'task/artifacts'),
      cleanedAt: '2026-01-01T00:00:00Z',
      support: {
        path: path.join(ownerRoot, 'support', sha),
        sha256: sha,
        sources: [],
        skills: [],
        environment: {},
      },
    };
    return result;
  };
  const repository = async () => {
    const identity = {
      owner: 'owner',
      project: 'farm',
      repositoryUrl: 'https://example.test/repo.git',
    };
    const directory = path.join(ownerRoot, 'repositories', hash(JSON.stringify(identity)));
    await mkdir(path.join(directory, 'objects'), { recursive: true });
    await json(directory + '.json', identity);
    return directory;
  };
  await mkdir(runsDir);
  return {
    root,
    runsDir,
    nativeRoot,
    ownerRoot,
    cacheRoot,
    storage,
    json,
    support,
    run,
    repository,
    setRuns: (next: Run[]) => {
      runs = next;
    },
  };
}

test('dry-run and cleanup reclaim closed/archived caches while retaining reports and admission history', async (t) => {
  const f = await fixture(t);
  const gateway = await f.support();
  const native = await f.support(path.join(f.ownerRoot, 'support'));
  const repository = await f.repository();
  const git = (...args: string[]) =>
    execFileSync('git', ['--git-dir', repository, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    }).trim();
  git('init', '--bare', repository);
  const emptyTree = git('mktree');
  const commit = git('commit-tree', emptyTree, '-m', 'Retained review');
  const closed = f.run();
  closed.archivedAt = '2026-01-02T00:00:00Z';
  f.setRuns([closed]);
  const sourceIndex = path.join(f.cacheRoot, 'sources-v2', 'c'.repeat(64) + '.json');
  await f.json(sourceIndex, { digest });
  const admission = path.join(f.cacheRoot, 'admissions', closed.id + '.json');
  await f.json(admission, { digest });
  const report = path.join(
    f.runsDir,
    'review-workspace-tasks',
    closed.id,
    'view/artifacts/review.md',
  );
  await f.json(report, 'retained report bytes');
  const record = path.join(f.runsDir, 'archive', closed.id + '.json');
  await f.json(record, closed);
  const before = await readFile(record);
  const expected = [gateway, native].sort();
  assert.deepEqual(await cleanupReviewWorkspaceCaches(true, f.storage), expected);
  assert(expected.every(existsSync));
  assert(existsSync(sourceIndex));
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), expected);
  assert(expected.every((file) => !existsSync(file)));
  assert(!existsSync(sourceIndex));
  assert(existsSync(repository));
  assert(existsSync(repository + '.json'));
  assert.equal(git('show', '--format=%s', '--no-patch', commit), 'Retained review');
  assert(existsSync(admission));
  assert(existsSync(report));
  assert.deepEqual(await readFile(record), before);
});

for (const reason of [
  'active',
  'open gate',
  'unclosed worker',
  'recovery',
  'pending closeout',
  'uncleaned checkout',
] as const) {
  test(`preserves shared execution bytes for ${reason}`, async (t) => {
    const f = await fixture(t);
    const gateway = await f.support();
    const native = await f.support(path.join(f.ownerRoot, 'support'));
    const repository = await f.repository();
    const held = f.run('held');
    if (reason === 'active') held.status = 'monitoring';
    if (reason === 'open gate')
      held.decisions = [
        {
          id: 'gate',
          type: 'engine_output_review',
          title: 'Review',
          description: 'Retain captured review inputs',
          actions: [],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ];
    if (reason === 'uncleaned checkout') delete held.reviewWorkspace!.cleanedAt;
    if (reason === 'pending closeout')
      held.output = {
        capturedAt: held.updatedAt,
        workerFinished: true,
        artifactManifest: [],
        manifestDigest: 'c'.repeat(64),
        cleanupPending: true,
      };
    if (reason === 'unclosed worker' || reason === 'recovery')
      held.agentContexts = [
        {
          id: 'review',
          role: 'review',
          label: 'Review',
          status: 'complete',
          runId: held.id,
          slotId: null,
          updatedAt: held.updatedAt,
          nativeSession: {
            sessionId: 'session',
            commandId: 'command',
            leaseId: 'lease',
            ownerPrincipalId: 'owner',
            executionNodeId: 'local',
            ...(reason === 'recovery'
              ? {
                  closedAt: held.updatedAt,
                  recovery: { fromGeneration: 'old', commandId: 'recover' },
                }
              : {}),
          },
        },
      ];
    f.setRuns([f.run(), held]);
    assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), []);
    assert([gateway, native, repository].every(existsSync));
  });
}

test('protects an admitted digest before its run support binding exists', async (t) => {
  const f = await fixture(t);
  const cached = await f.support();
  const held = f.run('admitting');
  held.status = 'writing-task';
  delete held.reviewWorkspace!.support;
  f.setRuns([held]);
  await f.json(path.join(f.cacheRoot, 'admissions', held.id + '.json'), { digest });
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), []);
  assert(existsSync(cached));
});

test('retained artifact references preserve bytes even after their owner completed', async (t) => {
  const f = await fixture(t);
  const cached = await f.support();
  const closed = f.run();
  closed.reviewResult = {
    recommendation: 'approve',
    reviewMd: 'Retained evidence',
    lineComments: [],
    artifactManifest: [{ path: path.join(cached, 'payload'), purpose: 'report', sizeBytes: 24 }],
  };
  f.setRuns([closed]);
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), []);
  assert(existsSync(cached));
});

test('refuses symlinked caches and unknown metadata instead of following or deleting them', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await f.support(outside);
  await mkdir(path.join(f.cacheRoot, 'bundles'), { recursive: true });
  await symlink(path.join(outside, digest), path.join(f.cacheRoot, 'bundles', digest));
  await f.json(path.join(f.cacheRoot, 'bundles', otherDigest, 'manifest.json'), {
    version: 1,
    sha256: digest,
  });
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), []);
  assert(existsSync(path.join(outside, digest, 'payload')));
  assert(existsSync(path.join(f.cacheRoot, 'bundles', otherDigest)));
});

for (const blocker of ['allocator lock', 'registered worktree'] as const) {
  test(`preserves native cache with ${blocker}`, async (t) => {
    const f = await fixture(t);
    const repository = await f.repository();
    if (blocker === 'allocator lock') await f.json(path.join(f.ownerRoot, 'locks', 'active'), {});
    else await f.json(path.join(repository, 'worktrees', 'source', 'gitdir'), {});
    assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), []);
    assert(existsSync(repository));
  });
}

test('completed allocator pointers permit reclamation while unfinished receipts preserve it', async (t) => {
  const f = await fixture(t);
  const native = await f.support(path.join(f.ownerRoot, 'support'));
  const repository = await f.repository();
  const operation = path.join(f.ownerRoot, 'operations', '12345678-1234-1234-1234-123456789abc');
  await f.json(path.join(operation, 'state.json'), { state: 'complete' });
  await mkdir(path.join(f.ownerRoot, 'locks'), { recursive: true });
  await symlink(operation, path.join(f.ownerRoot, 'locks', 'cache'));
  const receipt = path.join(f.ownerRoot, 'runs', 'historical', 'allocation.json');
  await f.json(receipt, { state: 'ready' });
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), []);
  await f.json(receipt, { state: 'cleaned' });
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), [native]);
  assert(existsSync(repository));
});

test('an interrupted deletion is reclaimed without touching a newly admitted copy', async (t) => {
  const f = await fixture(t);
  const current = await f.support();
  const retired = path.join(
    f.cacheRoot,
    'bundles',
    '.reclaim-' + digest + '-12345678-1234-1234-1234-123456789abc',
  );
  await f.json(path.join(retired, 'leftover'), { partialDeletion: true });
  const active = f.run('new-admission');
  active.status = 'monitoring';
  f.setRuns([active]);
  assert.deepEqual(await cleanupReviewWorkspaceCaches(false, f.storage), [retired]);
  assert(!existsSync(retired));
  assert(existsSync(path.join(current, 'manifest.json')));
});

test('admission and allocation uses stay concurrent but cannot overlap cache reclamation', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const first = useReviewWorkspaceStorage(async () => {
    started++;
    await waiting;
  });
  const second = useReviewWorkspaceStorage(async () => {
    started++;
    await waiting;
  });
  assert.equal(started, 2);
  let swept = false;
  assert.deepEqual(
    await reclaimReviewWorkspaceStorage(async () => {
      swept = true;
      return ['cache'];
    }),
    [],
  );
  assert.equal(swept, false);
  release();
  await Promise.all([first, second]);
  let finish!: () => void;
  const sweeping = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sweep = reclaimReviewWorkspaceStorage(async () => {
    await sweeping;
    return ['cache'];
  });
  let admitted = false;
  const admission = useReviewWorkspaceStorage(async () => {
    admitted = true;
  });
  assert.equal(admitted, false);
  finish();
  assert.deepEqual(await sweep, ['cache']);
  await admission;
  assert.equal(admitted, true);
});

test('public run.cleanup reclaims an archived review cache through the existing API', async (t) => {
  const f = await fixture(t);
  const cache = await f.support();
  const closed = f.run('public-cleanup');
  closed.archivedAt = '2026-01-02T00:00:00Z';
  await f.json(path.join(f.runsDir, 'archive', closed.id + '.json'), closed);
  const previous = {
    runs: process.env.FARMSLOT_RUNS_DIR,
    native: process.env.FARMSLOT_NATIVE_STATE_DIR,
  };
  process.env.FARMSLOT_RUNS_DIR = f.runsDir;
  process.env.FARMSLOT_NATIVE_STATE_DIR = f.nativeRoot;
  t.after(() => {
    if (previous.runs === undefined) delete process.env.FARMSLOT_RUNS_DIR;
    else process.env.FARMSLOT_RUNS_DIR = previous.runs;
    if (previous.native === undefined) delete process.env.FARMSLOT_NATIVE_STATE_DIR;
    else process.env.FARMSLOT_NATIVE_STATE_DIR = previous.native;
  });
  const { runCleanup } = await import('../methods/run/admin.js');
  const preview = await runCleanup({ dryRun: true });
  assert(existsSync(cache));
  const result = await runCleanup({ dryRun: false });
  assert(!existsSync(cache), 'archived execution cache must be reclaimed by run.cleanup');
  assert(result.cacheDirsRemoved?.includes(cache));
  assert(preview.cacheDirsRemoved?.includes(cache));
  assert(existsSync(path.join(f.runsDir, 'archive', closed.id + '.json')));
});
