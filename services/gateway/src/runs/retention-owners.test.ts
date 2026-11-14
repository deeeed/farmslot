import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  AgentContext,
  ReviewWorkspaceBinding,
  Run,
  RunArtifactBundleRef,
} from '@farmslot/protocol';
import { resolveRetainedRunBundleRef, runBundleRefs } from '@farmslot/run-bundle';

import { makeRun } from '../methods/run/test-fixtures.js';

import {
  readTaskPins,
  RetentionPathOwners,
  retiredTaskPinsOf,
  type RunRetentionRoots,
} from './retention.js';
import { isTaskDirectoryAdmitting, runTaskDirectories } from './store.js';

// The pass used to recompute every other run's paths for every candidate. These references are
// that code (origin/main before the owner index), kept verbatim so the index is checked against it.
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
const reviewWorkspaceDirs = (run: Run) =>
  run.reviewWorkspace?.executionNodeId === 'local'
    ? [path.resolve(path.dirname(run.reviewWorkspace.checkoutPath))]
    : [];
function nativeDirs(run: Run, nativeRoot: string): string[] {
  const sessions = (run.agentContexts ?? [])
    .flatMap((context) => [context.nativeSession, ...(context.nativeSessionHistory ?? [])])
    .flatMap((session) =>
      session?.executionNodeId === 'local' && session.stateDirectory
        ? [path.resolve(session.stateDirectory)]
        : [],
    );
  const workspace = reviewWorkspaceDirs(run)[0];
  if (workspace) {
    const owner = path.basename(path.dirname(path.dirname(workspace)));
    sessions.push(path.join(nativeRoot, 'workers', owner, path.basename(workspace)));
  }
  return sessions;
}
const bundleDigests = (run: Run, storeId: string) =>
  runBundleRefs(run).flatMap(({ ref }) => {
    const resolved = resolveRetainedRunBundleRef(run, ref);
    return resolved.storeId === storeId ? [resolved.bundleDigest] : [];
  });
function referenceOwnedPaths(removed: Run[], kept: Run[], roots: RunRetentionRoots) {
  const owned = (paths: (run: Run) => string[], allowed: (file: string) => boolean) => {
    const keep = new Set(kept.flatMap(paths));
    return [...new Set(removed.flatMap(paths))].filter((file) => allowed(file) && !keep.has(file));
  };
  const bundles = roots.bundles;
  return {
    'session-archives': removed.map((run) => roots.sessionArchive(run.id)),
    'task-dirs': owned(runTaskDirectories, (dir) =>
      roots.taskRoots.some((root) => inside(root, dir)),
    ),
    'review-workspaces': owned(reviewWorkspaceDirs, (dir) => inside(roots.reviewWorkspaces, dir)),
    'native-sessions': owned(
      (run) => nativeDirs(run, roots.nativeSessions),
      (dir) => inside(path.join(roots.nativeSessions, 'workers'), dir),
    ),
    'run-bundles': bundles
      ? owned(
          (run) => bundleDigests(run, bundles.id),
          () => true,
        ).map((digest) => path.join(bundles.root, 'sha256', digest))
      : [],
  };
}
async function referenceRetiredTaskPins(
  pinRoot: string,
  removedTaskDirs: ReadonlySet<string>,
  { now, ageMs }: { now: number; ageMs: number },
  pendingTaskDirs: ReadonlySet<string>,
): Promise<string[]> {
  const names = await readdir(pinRoot);
  const retired: string[] = [];
  for (const name of names) {
    if (name.startsWith('.retention-')) continue;
    const pin = path.join(pinRoot, name);
    const provenance = path.join(pin, 'provenance.json');
    let taskDir: unknown;
    let writtenAt: number;
    try {
      writtenAt = (await stat(provenance)).mtimeMs;
      taskDir = (JSON.parse(await readFile(provenance, 'utf8')) as { taskDir?: unknown }).taskDir;
    } catch {
      continue;
    }
    if (typeof taskDir !== 'string' || now - writtenAt < ageMs) continue;
    const resolved = path.resolve(taskDir);
    if (pendingTaskDirs.has(resolved) || isTaskDirectoryAdmitting(resolved)) continue;
    const exists = await stat(resolved).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (removedTaskDirs.has(resolved) || !exists) retired.push(pin);
  }
  return retired;
}

/** A deterministic generator, so a failure names a reproducible seed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const root = '/farm';
const roots: RunRetentionRoots = {
  archiveRoot: `${root}/archive`,
  runsDir: `${root}/runs`,
  sessionArchive: (id) => `${root}/sessions/${id}`,
  taskRoots: [`${root}/tasks`],
  taskPins: `${root}/pins`,
  nativeSessions: `${root}/native`,
  reviewWorkspaces: `${root}/review-workspaces`,
  bundles: { id: 'store-1', root: `${root}/bundles` },
};
const bundle = (bundleDigest: string, storeId = 'store-1'): RunArtifactBundleRef => ({
  storeId,
  bundleDigest,
  taskKey: 'run',
  manifestDigest: 'manifest',
});

function session(present: number, node: number, n: number): AgentContext['nativeSession'] {
  if (present === 0) return undefined;
  return {
    sessionId: `s${n}`,
    executionNodeId: node === 0 ? 'macpro' : 'local',
    ownerPrincipalId: 'owner',
    leaseId: 'lease',
    commandId: 'command',
    stateDirectory: `${root}/native/workers/owner/s${n}`,
  };
}

function agentContext(
  runId: string,
  taskFile: string,
  nativeSession: AgentContext['nativeSession'],
): AgentContext {
  return {
    id: `${runId}-agent`,
    role: 'fix-bug',
    label: 'Fix',
    status: 'complete',
    slotId: null,
    runId,
    taskFile,
    nativeSession,
  };
}

function reviewWorkspace(checkoutPath: string): ReviewWorkspaceBinding {
  const dir = path.dirname(checkoutPath);
  return {
    workspaceId: path.basename(dir),
    machine: 'macwork',
    executionNodeId: 'local',
    checkoutPath,
    taskPath: path.join(dir, 'task'),
    artifactPath: path.join(dir, 'task', 'artifacts'),
  };
}

/** A run that shares a few task dirs, review workspaces, native sessions and bundles. */
function sharingRun(id: string, next: () => number): Run {
  const pick = (count: number) => Math.floor(next() * count);
  const task = (n: number) =>
    // Some task dirs sit outside the farm task root: only the farm's own are removable.
    `${n % 7 === 0 ? '/elsewhere' : `${root}/tasks`}/t${n}/TASK.md`;
  const workspace =
    pick(4) === 0 ? undefined : `${root}/review-workspaces/owner/runs/w${pick(12)}/source`;
  return {
    ...makeRun({ id, familyId: id }),
    taskFile: task(pick(30)),
    activeTaskFile: pick(2) ? task(pick(30)) : undefined,
    agentContexts: [agentContext(id, task(pick(30)), session(pick(3), pick(5), pick(15)))],
    reviewWorkspace: workspace ? reviewWorkspace(workspace) : undefined,
    artifactBundle:
      pick(3) === 0 ? undefined : bundle(`d${pick(10)}`, pick(6) ? 'store-1' : 'other'),
  };
}

test('the owner index keeps exactly what the old per-candidate scan kept', () => {
  for (const seed of [1, 7, 42, 1_000, 31_337]) {
    const next = random(seed);
    const stable = Array.from({ length: 120 }, (_, i) => sharingRun(`a${i}`, next));
    const live = Array.from({ length: 30 }, (_, i) => sharingRun(`l${i}`, next));
    const owners = new RetentionPathOwners(roots, stable);
    const processed = new Set<string>();
    const held = new Set(stable.filter(() => next() < 0.1).map((run) => run.id));
    for (const run of [...stable, ...live]) {
      // Live runs change in place between candidates, as updateRun does.
      for (const other of live)
        if (next() < 0.2) Object.assign(other, sharingRun(other.id, next), { id: other.id });
      // A run created mid-pass.
      const current = [...live, sharingRun(`new-${run.id}`, next)];
      const keeps = (other: Run) =>
        other.id !== run.id && (!processed.has(other.id) || held.has(other.id));
      const expected = referenceOwnedPaths([run], [...stable, ...current].filter(keeps), roots);
      const view = owners.view(current.filter(keeps), keeps);
      assert.deepEqual(view.owned(run), expected, `seed ${seed}, run ${run.id}`);
      const pending = new Set([...stable, ...current].filter(keeps).flatMap(runTaskDirectories));
      for (const dir of [...pending, ...runTaskDirectories(run), `${root}/tasks/none`])
        assert.equal(view.keepsTaskDirectory(dir), pending.has(dir), `seed ${seed}, ${dir}`);
      if (next() < 0.5) processed.add(run.id);
    }
  }
});

test('pins read once and filtered per candidate match a fresh read, and skip staged pins', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'retention-pins-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pinRoot = path.join(dir, 'pins');
  const now = Date.now();
  const ageMs = 7 * 86_400_000;
  const old = new Date(now - 2 * ageMs);
  const tasks = Array.from({ length: 8 }, (_, i) => path.join(dir, 'tasks', `t${i}`));
  for (const [i, task] of tasks.entries()) {
    if (i % 2 === 0) await mkdir(task, { recursive: true });
    const pin = path.join(pinRoot, `p${i}`);
    await mkdir(pin, { recursive: true });
    await writeFile(path.join(pin, 'provenance.json'), JSON.stringify({ taskDir: task }));
    // Every third pin is too young to retire.
    if (i % 3) await utimes(path.join(pin, 'provenance.json'), old, old);
  }
  await mkdir(path.join(pinRoot, 'unreadable'));
  await mkdir(path.join(pinRoot, '.retention-staged'), { recursive: true });
  const entries = await readTaskPins(pinRoot);
  const present = (pin: string) =>
    stat(pin).then(
      () => true,
      () => false,
    );
  for (const [removed, pending] of [
    [new Set<string>(), new Set<string>()],
    [new Set([tasks[2], tasks[4]]), new Set([tasks[1]])],
    [new Set(tasks), new Set([tasks[6], tasks[7]])],
  ]) {
    const context = { now, ageMs };
    assert.deepEqual(
      await retiredTaskPinsOf(entries, removed, context, (task) => pending.has(task), present),
      await referenceRetiredTaskPins(pinRoot, removed, context, pending),
    );
  }
  // A pin staged since the pins were read is not offered again.
  await rm(path.join(pinRoot, 'p1'), { recursive: true });
  const all = await retiredTaskPinsOf(
    entries,
    new Set(tasks),
    { now, ageMs },
    () => false,
    present,
  );
  assert.equal(all.includes(path.join(pinRoot, 'p1')), false);
  assert.deepEqual(
    all,
    await referenceRetiredTaskPins(pinRoot, new Set(tasks), { now, ageMs }, new Set()),
  );
});
