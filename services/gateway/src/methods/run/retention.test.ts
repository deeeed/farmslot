import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type AgentContext,
  type ReviewWorkspaceBinding,
  type Run,
  type RunArtifactBundleRef,
  type RunDecision,
} from '@farmslot/protocol';

import {
  planRunRetention,
  RUN_RETENTION_AGE_MS,
  type RunPrState,
  type RunRetentionContext,
  runRetentionHold,
  type RunRetentionRoots,
} from '../../runs/retention.js';
import {
  archiveRun,
  createRun,
  getRunWithArchived,
  persistRunNow,
  runsDirectory,
  runSessionArchiveDir,
  updateRun,
} from '../../runs/store.js';

import { retentionContext, RUN_RETENTION_DEPS, runRetentionPass } from './retention.js';
import { makeRun } from './test-fixtures.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const settled = new Date(NOW - RUN_RETENTION_AGE_MS - 60_000).toISOString();
const context = (pr: RunPrState = 'none'): RunRetentionContext => ({
  now: NOW,
  prState: () => pr,
});

const openDecision: RunDecision = {
  id: 'decision-1',
  type: 'engine_human_gate',
  title: 'Approve publication',
  description: 'Gate',
  actions: [],
  createdAt: settled,
};

function nativeContext(runId: string, stateDirectory: string, node = 'local'): AgentContext {
  return {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Fix',
    status: 'complete',
    slotId: null,
    runId,
    nativeSession: {
      sessionId: path.basename(stateDirectory),
      executionNodeId: node,
      ownerPrincipalId: 'owner',
      leaseId: 'lease',
      commandId: 'command',
      stateDirectory,
      releasedAt: settled,
    },
  };
}

function workspace(dir: string, executionNodeId = 'local'): ReviewWorkspaceBinding {
  return {
    workspaceId: path.basename(dir),
    machine: executionNodeId === 'local' ? 'macwork' : executionNodeId,
    executionNodeId,
    checkoutPath: path.join(dir, 'source'),
    taskPath: path.join(dir, 'task'),
    artifactPath: path.join(dir, 'task', 'artifacts'),
    cleanedAt: settled,
  };
}

const bundle = (bundleDigest: string): RunArtifactBundleRef => ({
  storeId: 'store-1',
  bundleDigest,
  taskKey: 'run',
  manifestDigest: 'manifest',
});

async function file(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'x'.repeat(4096));
}

async function retentionRoots(t: test.TestContext, runsDir?: string): Promise<RunRetentionRoots> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'farmslot-retention-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const archiveRoot = path.join(tmp, 'archive-root');
  await mkdir(archiveRoot);
  return {
    archiveRoot,
    runsDir: runsDir ?? path.join(tmp, 'runs'),
    sessionArchive: runsDir
      ? runSessionArchiveDir
      : (id) => path.join(tmp, 'runs', 'session-archives', id),
    taskRoots: [path.join(tmp, 'tasks')],
    taskPins: path.join(tmp, 'pins'),
    nativeSessions: path.join(tmp, 'native'),
    reviewWorkspaces: path.join(tmp, 'review-workspaces'),
    bundles: { id: 'store-1', root: path.join(tmp, 'bundles') },
  };
}

/** A pin for `taskDir` whose provenance was written at `writtenAt`. */
async function pin(roots: RunRetentionRoots, name: string, taskDir: string, writtenAt: number) {
  const provenance = path.join(roots.taskPins, name, 'provenance.json');
  await mkdir(path.dirname(provenance), { recursive: true });
  await writeFile(provenance, JSON.stringify({ taskDir, receipt: {} }));
  const at = new Date(writtenAt);
  await utimes(provenance, at, at);
  return path.dirname(provenance);
}

test('retention archives a settled run storage only after48h with nothing open', () => {
  const done: Run = { ...makeRun({ status: 'done' }), updatedAt: settled };
  assert.equal(runRetentionHold(done, context()), undefined);
  assert.equal(runRetentionHold({ ...done, status: 'cancelled' }, context()), undefined);
  assert.equal(
    runRetentionHold({ ...done, status: 'failed', archivedAt: settled }, context()),
    undefined,
  );
  for (const status of ['monitoring', 'human-gating', 'blocked', 'failed'] as const)
    assert.equal(
      runRetentionHold({ ...done, status }, context()),
      'not done, cancelled or archived',
    );
  const recent = new Date(NOW - RUN_RETENTION_AGE_MS + 60_000).toISOString();
  assert.equal(
    runRetentionHold({ ...done, completedAt: recent }, context()),
    'settled less than 48 h ago',
  );
  // Bookkeeping that touches a long-completed run does not restart its 48 h.
  assert.equal(
    runRetentionHold({ ...done, completedAt: settled, updatedAt: recent }, context()),
    undefined,
  );
  assert.equal(
    runRetentionHold({ ...done, decisions: [openDecision] }, context()),
    'still needs its execution storage',
  );
  assert.equal(runRetentionHold({ ...done, tags: ['demo'] }, context()), 'operator-tagged');
  assert.equal(runRetentionHold(done, context('open')), 'PR open');
  assert.equal(runRetentionHold(done, context('unknown')), 'PR state unknown');
  assert.equal(runRetentionHold(done, context('settled')), undefined);
});

test('a PR keeps its run unless its repository was read and the PR is not open', async () => {
  const run = (id: string, overrides: Partial<Run>): Run => ({ ...makeRun({ id }), ...overrides });
  const runs = [
    run('link-open', { links: [{ label: 'PR', url: 'https://github.com/o/r/pull/1' }] }),
    run('ticket-merged', { ticketOrPr: 'o/r#2' }),
    run('no-repo', { prNumber: 3, project: 'no-ci-repo', ticketOrPr: 'PROJ-3' }),
    run('full-page', { prNumber: 4, project: 'big', ticketOrPr: 'PROJ-4' }),
    run('unreadable', { links: [{ label: 'PR', url: 'https://github.com/o/down/pull/5' }] }),
    run('bad-link', { links: [{ label: 'PR', url: 'not a url' }], ticketOrPr: 'PROJ-6' }),
    run('recorded', { prNumber: 7, prState: 'MERGED', ticketOrPr: 'PROJ-7' }),
    run('no-pr', { ticketOrPr: 'PROJ-8' }),
    // An issue ticket resolves to a closed number, but the run's own PR is open.
    run('issue-and-pr', { ticketOrPr: 'o/r#20', prNumber: 1, project: 'repo' }),
  ];
  const reads: string[] = [];
  const { prState } = await retentionContext(runs, NOW, {
    projectRepo: async (project) => ({ big: 'o/big', repo: 'o/r' })[project],
    openPrs: async (repo) => {
      reads.push(repo);
      if (repo === 'o/down') throw new Error('rate limited');
      return repo === 'o/big' ? Array.from({ length: 1000 }, (_, i) => i + 10) : [1];
    },
  });
  assert.deepEqual(Object.fromEntries(runs.map((r) => [r.id, prState(r)])), {
    'link-open': 'open',
    'ticket-merged': 'settled',
    'no-repo': 'unknown',
    'full-page': 'unknown',
    unreadable: 'unknown',
    'bad-link': 'unknown',
    recorded: 'settled',
    'no-pr': 'none',
    'issue-and-pr': 'open',
  });
  assert.deepEqual(reads.sort(), ['o/big', 'o/down', 'o/r'], 'one read per repository');
});

test('a retention plan lists only storage that removable runs alone own on this node', async (t) => {
  const roots = await retentionRoots(t);
  const own = path.join(roots.taskRoots[0], 'feat', 'own');
  const shared = path.join(roots.taskRoots[0], 'feat', 'shared');
  const slotCopy = path.join(path.dirname(roots.taskPins), 'slot', 'temp', 'tasks', 'feat', 'own');
  const native = path.join(roots.nativeSessions, 'workers', 'owner', 'session-1');
  const remoteNative = path.join(roots.nativeSessions, 'workers', 'owner', 'session-remote');
  const localWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w1');
  const workspaceNative = path.join(roots.nativeSessions, 'workers', 'owner', 'w1');
  const remoteWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w2');
  const bundleRoot = roots.bundles!.root;
  for (const target of [
    path.join(own, 'TASK.md'),
    path.join(shared, 'TASK.md'),
    path.join(slotCopy, 'TASK.md'),
    path.join(native, 'state.json'),
    path.join(remoteNative, 'state.json'),
    path.join(workspaceNative, 'state.json'),
    path.join(localWorkspace, 'task', 'report.md'),
    path.join(remoteWorkspace, 'task', 'report.md'),
    path.join(bundleRoot, 'sha256', 'own', 'manifest.json'),
    path.join(bundleRoot, 'sha256', 'shared', 'manifest.json'),
  ])
    await file(target);
  const old = RUN_RETENTION_AGE_MS + 60_000;
  const retired = await pin(roots, 'retired', path.join(roots.taskRoots[0], 'gone'), NOW - old);
  await pin(roots, 'fresh', path.join(roots.taskRoots[0], 'gone'), NOW - 60_000);
  await pin(roots, 'in-use', slotCopy, NOW - old);

  const removable: Run = {
    ...makeRun({
      id: 'removable',
      status: 'done',
      taskFile: path.join(own, 'TASK.md'),
      activeTaskFile: path.join(slotCopy, 'TASK.md'),
      agentContexts: [nativeContext('removable', native)],
    }),
    updatedAt: settled,
    reviewWorkspace: workspace(localWorkspace),
    artifactBundle: bundle('own'),
  };
  // Another node's paths look identical to this node's; they are not this pass's to remove.
  const remote: Run = {
    ...makeRun({
      id: 'remote',
      status: 'done',
      taskFile: path.join(shared, 'TASK.md'),
      agentContexts: [nativeContext('remote', remoteNative, 'macpro')],
    }),
    updatedAt: settled,
    reviewWorkspace: workspace(remoteWorkspace, 'macpro'),
    artifactBundle: bundle('shared'),
  };
  const live: Run = {
    ...makeRun({ id: 'live', status: 'monitoring', taskFile: path.join(shared, 'TASK.md') }),
    artifactBundle: bundle('shared'),
  };
  const slotHolder: Run = {
    ...makeRun({ id: 'slot-holder', status: 'cancelled', slotId: 'slot-1' }),
    updatedAt: settled,
  };

  const { plan } = await planRunRetention(
    [removable, remote, live, slotHolder],
    context(),
    roots,
    async (run) => run.slotId === 'slot-1',
  );

  assert.deepEqual(plan.runs, ['removable', 'remote']);
  assert.deepEqual(plan.held, { 'not done, cancelled or archived': 1, 'holds its slot': 1 });
  assert.deepEqual(plan.paths['task-dirs'], [own], 'not the shared one or the slot copy');
  assert.deepEqual(plan.paths['review-workspaces'], [localWorkspace]);
  assert.deepEqual(plan.paths['native-sessions'].sort(), [native, workspaceNative].sort());
  assert.deepEqual(plan.paths['run-bundles'], [path.join(bundleRoot, 'sha256', 'own')]);
  assert.deepEqual(plan.paths['task-pins'], [retired]);
  assert.equal(plan.stores['task-dirs'].entries, 1);
  assert.ok(plan.stores['task-dirs'].bytes >= 4096);
});

const privateDeps = {
  ...RUN_RETENTION_DEPS,
  withBundleLock: async <T>(operation: () => Promise<T>) => operation(),
};

test('a settled untagged48h run keeps both live and archived records while all eligible storage moves', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const runIds: string[] = [];
  const originals: string[] = [];
  for (const archived of [false, true]) {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr: `RETENTION-${archived}`,
    });
    const task = path.join(roots.taskRoots[0], run.id);
    const native = path.join(roots.nativeSessions, 'workers', run.id);
    const review = path.join(roots.reviewWorkspaces, 'owner', 'runs', run.id);
    updateRun(run.id, {
      status: 'done',
      completedAt: settled,
      taskFile: path.join(task, 'TASK.md'),
      agentContexts: [nativeContext(run.id, native)],
      reviewWorkspace: workspace(review),
      artifactBundle: bundle(run.id),
    });
    await persistRunNow(run);
    if (archived) assert.equal(await archiveRun(run.id), true);
    const record = path.join(roots.runsDir, ...(archived ? ['archive'] : []), `${run.id}.json`);
    assert.ok(existsSync(record));
    originals.push(record);
    runIds.push(run.id);
    for (const directory of [
      task,
      native,
      review,
      roots.sessionArchive(run.id),
      path.join(roots.bundles!.root, 'sha256', run.id),
    ])
      await file(path.join(directory, 'bytes'));
    await symlink('bytes', path.join(task, 'linked'));
    await pin(roots, run.id, task, NOW - RUN_RETENTION_AGE_MS - 60000);
  }
  const passNow = Date.now() + RUN_RETENTION_AGE_MS + 60000;
  const events: string[] = [];
  const plan = await runRetentionPass({ apply: false, roots, now: passNow }, privateDeps);
  assert.equal('run-records' in plan.stores, false);
  assert.equal('run-records' in plan.paths, false);
  const result = await runRetentionPass(
    { apply: true, roots, now: passNow, emit: (event) => events.push(event) },
    privateDeps,
  );
  assert.deepEqual(new Set(result.runs), new Set(runIds));
  assert.deepEqual(events, [], 'storage archival does not announce run deletion');
  for (const [index, id] of runIds.entries()) {
    assert.ok(
      existsSync(originals[index]),
      'history record stays in exactly its original location',
    );
    const record = JSON.parse(await readFile(originals[index], 'utf8'));
    assert.equal(record.id, id);
    const manifestFile = path.join(roots.archiveRoot, id, 'manifest.json');
    assert.ok(
      record.links.some(
        (link: { url: string }) => link.url === new URL(`file://${manifestFile}`).href,
      ),
    );
    assert.ok(await getRunWithArchived(id));
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.ok(manifest.entries.length >= 5);
    for (const entry of manifest.entries) {
      assert.equal(existsSync(entry.source), false);
      assert.ok(existsSync(entry.destination));
      assert.ok(entry.destination.endsWith(entry.source));
      if (entry.store !== 'task-pins')
        assert.equal(
          await readFile(path.join(entry.destination, 'bytes'), 'utf8'),
          'x'.repeat(4096),
        );
      assert.ok(entry.completedAt);
    }
  }
  const after = await runRetentionPass({ apply: true, roots, now: passNow }, privateDeps);
  assert.deepEqual(after.runs, [], 'a repeat pass never destroys or duplicates archived storage');
  for (const record of originals) assert.ok(existsSync(record));
});

test('missing and unwritable archive roots fail before touching run records or storage', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    mode: 'autonomous',
    ticketOrPr: 'RETENTION-ROOT',
  });
  const task = path.join(roots.taskRoots[0], run.id);
  updateRun(run.id, { status: 'done', completedAt: settled, taskFile: path.join(task, 'TASK.md') });
  await persistRunNow(run);
  await file(path.join(task, 'bytes'));
  const record = path.join(roots.runsDir, `${run.id}.json`);
  const before = await readFile(record, 'utf8');
  await assert.rejects(
    runRetentionPass(
      {
        apply: true,
        roots: { ...roots, archiveRoot: path.join(roots.archiveRoot, 'missing') },
        now: NOW,
      },
      privateDeps,
    ),
    /ENOENT/,
  );
  const { chmod } = await import('node:fs/promises');
  await chmod(roots.archiveRoot, 0o500);
  try {
    await assert.rejects(
      runRetentionPass({ apply: true, roots, now: NOW }, privateDeps),
      /cannot write/,
    );
  } finally {
    await chmod(roots.archiveRoot, 0o700);
  }
  assert.equal(await readFile(record, 'utf8'), before);
  assert.equal(await readFile(path.join(task, 'bytes'), 'utf8'), 'x'.repeat(4096));
});
