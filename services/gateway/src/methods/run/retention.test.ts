import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type AgentContext,
  Events,
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
  getAllRunsWithArchived,
  runsDirectory,
  runSessionArchiveDir,
  updateRun,
  withTaskAdmission,
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
  return {
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

test('retention removes a done, cancelled or archived run only once it settled 48 h with nothing open', () => {
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

test('a retention pass deletes settled runs with their own storage and keeps what any run still uses', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const task = (name: string) => path.join(roots.taskRoots[0], 'feat', name);
  const workers = path.join(roots.nativeSessions, 'workers', 'owner');
  const localWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w3');
  const names = ['own', 'shared', 'refused', 'late', 'archived', 'admitting', 'far'];
  for (const target of [
    ...names.map((name) => path.join(task(name), 'TASK.md')),
    path.join(workers, 'session-2', 'state.json'),
    path.join(workers, 'far', 'state.json'),
    path.join(localWorkspace, 'task', 'report.md'),
  ])
    await file(target);
  const retired = await pin(roots, 'retired', task('gone'), Date.now());

  const done = (ticket: string, name: string, extra: Partial<Run> = {}) => {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      mode: 'autonomous',
      ticketOrPr: ticket,
    });
    updateRun(run.id, { status: 'done', taskFile: path.join(task(name), 'TASK.md'), ...extra });
    return run.id;
  };
  // Processed first: while its record is deleted, a new run starts on `late`'s task.
  const racer = done('RETENTION-RACE', 'own');
  const removed = done('RETENTION-1', 'own', {
    agentContexts: [nativeContext('removed', path.join(workers, 'session-2'))],
    reviewWorkspace: workspace(localWorkspace),
  });
  const sharer = done('RETENTION-2', 'shared');
  const kept = done('RETENTION-3', 'shared', { decisions: [openDecision] });
  const refused = done('RETENTION-4', 'refused');
  const late = done('RETENTION-5', 'late');
  const archived = done('RETENTION-6', 'archived');
  assert.equal(await archiveRun(archived), true);
  // Run creation is admitting a new run on this task while the pass runs.
  const admitting = done('RETENTION-8', 'admitting');
  // Its native state is on another volume, so it cannot be moved reversibly.
  const far = done('RETENTION-9', 'far', {
    agentContexts: [nativeContext('far', path.join(workers, 'far'))],
  });
  // An interrupted pass left two staged directories: one of a run it never deleted,
  // since tagged, and one of a run it did delete.
  const trash = path.join(roots.runsDir, 'retention-trash');
  const tagged = done('RETENTION-10', 'tagged', { tags: ['demo'] });
  const interrupted = async (name: string, runId: string, original: string) => {
    await file(path.join(trash, name, 'TASK.md'));
    await writeFile(
      path.join(trash, `${name}.json`),
      JSON.stringify({ runId, store: 'task-dirs', path: original }),
    );
  };
  await interrupted('never-deleted', tagged, task('tagged'));
  await interrupted('deleted', 'a-deleted-run', task('deleted'));
  await file(path.join(runSessionArchiveDir(removed), 'session.jsonl'));
  t.after(() => rm(runSessionArchiveDir(kept), { recursive: true, force: true }));

  let restarted: string | undefined;
  const order: string[] = [];
  const result = await withTaskAdmission(path.join(task('admitting'), 'TASK.md'), () =>
    runRetentionPass(
      {
        apply: true,
        now: Date.now() + RUN_RETENTION_AGE_MS + 60_000,
        roots,
        emit: (event, payload) => order.push(`${event}:${(payload as { runId: string }).runId}`),
      },
      {
        ...RUN_RETENTION_DEPS,
        deleteRecord: async (id) => {
          if (id === refused) return false;
          if (id === racer) restarted = done('RETENTION-7', 'late', { status: 'monitoring' });
          return RUN_RETENTION_DEPS.deleteRecord(id);
        },
        releaseBacklogLink: async (id) => {
          order.push(`release:${id}`);
        },
        collectGarbage: async () => {},
        move: (from, to) => {
          if (from === path.join(workers, 'far'))
            throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
          RUN_RETENTION_DEPS.move(from, to);
        },
      },
    ),
  );

  assert.deepEqual(
    result.runs.sort(),
    [racer, removed, sharer, late, archived, admitting].sort(),
    'the refused, kept, tagged and cross-volume runs stay',
  );
  const remaining = new Set((await getAllRunsWithArchived()).map((run) => run.id));
  for (const id of result.runs) assert.equal(remaining.has(id), false);
  for (const id of [kept, refused, restarted!, far, tagged]) assert.ok(remaining.has(id));
  assert.equal(existsSync(task('own')), false);
  assert.equal(existsSync(task('archived')), false);
  assert.ok(existsSync(task('shared')), 'the kept run still uses it');
  assert.ok(existsSync(task('refused')), 'a refused delete restores its directories');
  assert.ok(existsSync(task('late')), 'a run registered during the pass uses it');
  assert.ok(existsSync(task('admitting')), 'a run being admitted holds its task directory');
  assert.ok(existsSync(task('far')), 'a run that cannot move reversibly keeps its directories');
  assert.ok(existsSync(path.join(workers, 'far')));
  assert.ok(existsSync(path.join(task('tagged'), 'TASK.md')), 'a never-deleted run gets it back');
  assert.equal(existsSync(path.join(trash, 'deleted')), false, 'a deleted run leaves nothing');
  assert.equal(existsSync(path.join(workers, 'session-2')), false);
  assert.equal(existsSync(localWorkspace), false);
  assert.equal(existsSync(retired), false);
  assert.equal(existsSync(runSessionArchiveDir(removed)), false);
  assert.equal(result.stores['session-archives'].entries, 1);
  assert.ok(result.stores['task-dirs'].bytes > 0);
  // The backlog link is released (without requeueing) before each deletion is announced.
  for (const id of result.runs) {
    assert.ok(order.includes(`release:${id}`));
    assert.ok(order.indexOf(`release:${id}`) < order.indexOf(`${Events.RUN_DELETED}:${id}`));
  }
  assert.equal(order.filter((entry) => entry.startsWith(Events.RUN_DELETED)).length, 6);
});
