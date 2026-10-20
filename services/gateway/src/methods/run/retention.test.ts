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
  type RunRetentionContext,
  runRetentionHold,
  type RunRetentionRoots,
} from '../../runs/retention.js';
import {
  createRun,
  getRun,
  runsDirectory,
  runSessionArchiveDir,
  updateRun,
} from '../../runs/store.js';

import { runRetentionPass } from './retention.js';
import { makeRun } from './test-fixtures.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const settled = new Date(NOW - RUN_RETENTION_AGE_MS - 60_000).toISOString();
const context = (prOpen?: boolean): RunRetentionContext => ({ now: NOW, prOpen: () => prOpen });

const openDecision: RunDecision = {
  id: 'decision-1',
  type: 'engine_human_gate',
  title: 'Approve publication',
  description: 'Gate',
  actions: [],
  createdAt: settled,
};

function nativeContext(runId: string, stateDirectory: string): AgentContext {
  return {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Fix',
    status: 'complete',
    slotId: null,
    runId,
    nativeSession: {
      sessionId: path.basename(stateDirectory),
      executionNodeId: 'local',
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
  assert.equal(
    runRetentionHold({ ...done, decisions: [openDecision] }, context()),
    'still needs its execution storage',
  );
  assert.equal(runRetentionHold({ ...done, tags: ['demo'] }, context()), 'operator-tagged');

  const withPr: Run = { ...done, prNumber: 42 };
  assert.equal(runRetentionHold(withPr, context(true)), 'PR open');
  assert.equal(runRetentionHold(withPr, context(undefined)), 'PR state unknown');
  assert.equal(runRetentionHold(withPr, context(false)), undefined);
  assert.equal(runRetentionHold({ ...withPr, prState: 'MERGED' }, context(true)), undefined);
});

test('a retention plan lists only storage that removable runs alone own on this node', async (t) => {
  const roots = await retentionRoots(t);
  const own = path.join(roots.taskRoots[0], 'feat', 'own');
  const shared = path.join(roots.taskRoots[0], 'feat', 'shared');
  const slotCopy = path.join(path.dirname(roots.taskPins), 'slot', 'temp', 'tasks', 'feat', 'own');
  const native = path.join(roots.nativeSessions, 'workers', 'owner', 'session-1');
  const localWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w1');
  const remoteWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w2');
  const bundleRoot = roots.bundles!.root;
  for (const target of [
    path.join(own, 'TASK.md'),
    path.join(shared, 'TASK.md'),
    path.join(slotCopy, 'TASK.md'),
    path.join(native, 'state.json'),
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
  const remote: Run = {
    ...makeRun({ id: 'remote', status: 'done', taskFile: path.join(shared, 'TASK.md') }),
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
  // The slot checkout's copy and another node's workspace are not this pass's to remove.
  assert.deepEqual(plan.paths['task-dirs'], [own]);
  assert.deepEqual(plan.paths['review-workspaces'], [localWorkspace]);
  assert.deepEqual(plan.paths['native-sessions'], [native]);
  assert.deepEqual(plan.paths['run-bundles'], [path.join(bundleRoot, 'sha256', 'own')]);
  assert.deepEqual(plan.paths['task-pins'], [retired]);
  assert.equal(plan.stores['task-dirs'].entries, 1);
  assert.ok(plan.stores['task-dirs'].bytes >= 4096);
});

test('a retention pass deletes settled runs and their own storage, and keeps what a remaining run uses', async (t) => {
  const roots = await retentionRoots(t, runsDirectory());
  const own = path.join(roots.taskRoots[0], 'feat', 'own');
  const shared = path.join(roots.taskRoots[0], 'feat', 'shared');
  const native = path.join(roots.nativeSessions, 'workers', 'owner', 'session-2');
  const localWorkspace = path.join(roots.reviewWorkspaces, 'owner', 'runs', 'w3');
  for (const target of [
    path.join(own, 'TASK.md'),
    path.join(shared, 'TASK.md'),
    path.join(native, 'state.json'),
    path.join(localWorkspace, 'task', 'report.md'),
  ])
    await file(target);
  const retired = await pin(roots, 'retired', path.join(roots.taskRoots[0], 'gone'), Date.now());

  const params = { flowType: 'fix-bug', project: 'farmslot-farm', mode: 'autonomous' } as const;
  const removed = createRun({ ...params, ticketOrPr: 'RETENTION-1' });
  updateRun(removed.id, {
    status: 'done',
    taskFile: path.join(own, 'TASK.md'),
    agentContexts: [nativeContext(removed.id, native)],
    reviewWorkspace: workspace(localWorkspace),
  });
  const sharer = createRun({ ...params, ticketOrPr: 'RETENTION-2' });
  updateRun(sharer.id, { status: 'done', taskFile: path.join(shared, 'TASK.md') });
  const kept = createRun({ ...params, ticketOrPr: 'RETENTION-3' });
  updateRun(kept.id, {
    status: 'done',
    taskFile: path.join(shared, 'TASK.md'),
    decisions: [openDecision],
  });
  await file(path.join(runSessionArchiveDir(removed.id), 'session.jsonl'));
  t.after(() => rm(runSessionArchiveDir(kept.id), { recursive: true, force: true }));

  const events: [string, unknown][] = [];
  const result = await runRetentionPass({
    apply: true,
    now: Date.now() + RUN_RETENTION_AGE_MS + 60_000,
    roots,
    emit: (event, payload) => events.push([event, payload]),
  });

  assert.deepEqual(result.runs.sort(), [removed.id, sharer.id].sort());
  assert.equal(getRun(removed.id), undefined);
  assert.equal(getRun(sharer.id), undefined);
  assert.ok(getRun(kept.id), 'a run with an open decision keeps its record');
  assert.equal(existsSync(own), false);
  assert.equal(existsSync(shared), true, 'the kept run still uses the shared task directory');
  assert.equal(existsSync(native), false);
  assert.equal(existsSync(localWorkspace), false);
  assert.equal(existsSync(retired), false);
  assert.equal(existsSync(runSessionArchiveDir(removed.id)), false);
  assert.equal(result.stores['session-archives'].entries, 1);
  assert.deepEqual(
    events.map(([event, payload]) => [event, (payload as { runId: string }).runId]).sort(),
    [
      [Events.RUN_DELETED, removed.id],
      [Events.RUN_DELETED, sharer.id],
    ].sort(),
  );
});
