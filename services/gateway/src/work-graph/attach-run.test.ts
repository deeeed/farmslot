import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { AttachmentDependencies } from './attach-run.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'retained-attachment-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(root, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(root, 'queue.json');
process.env.FARMSLOT_WORK_GRAPH_DIR = path.join(root, 'graphs');
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
await mkdir(process.env.FARMSLOT_POOL_DIR, { recursive: true });
await import('../runtime/mock-pty.test-support.js');
const backlog = await import('../backlog/store.js');
const queue = await import('../backlog/dispatch-queue.js');
const runs = await import('../runs/store.js');
const graphs = await import('./store.js');
test.after(() => rm(root, { recursive: true, force: true }));

const childHead = 'a'.repeat(40);
const parentHead = 'b'.repeat(40);
const deps: AttachmentDependencies = {
  source: async () => ({
    headSha: childHead,
    upstreamSha: parentHead,
    publicationRefreshRequired: true,
  }),
  progress: async () => ({ kind: 'idle' }),
};

async function fixture() {
  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await rm(process.env.FARMSLOT_DISPATCH_QUEUE_FILE!, { force: true });
  await rm(process.env.FARMSLOT_WORK_GRAPH_DIR!, { force: true, recursive: true });
  await rm(process.env.FARMSLOT_RUNS_DIR!, { force: true, recursive: true });
  backlog.initBacklogStore(() => {});
  queue.initDispatchQueue(
    () => {},
    async () => {},
  );
  graphs.initWorkGraphStore(() => {});
  await backlog.loadBacklog();
  await queue.loadQueue();
  await runs.loadAllRuns();
  await graphs.loadWorkGraphs();
  const parentItem = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Parent',
      flowType: 'dev',
      sourceKind: 'manual',
      status: 'ready',
      autoDispatch: false,
    },
    { kind: 'system' },
  );
  const childItem = await backlog.createBacklogItem(
    {
      project: 'farmslot-farm',
      title: 'Retained child',
      flowType: 'dev',
      sourceKind: 'manual',
      status: 'ready',
      autoDispatch: false,
    },
    { kind: 'system' },
  );
  const created = await graphs.createWorkGraph(
    { project: 'farmslot-farm', title: 'Retained work' },
    { kind: 'system' },
  );
  const graphId = created.graph.graph.id;
  await graphs.addWorkGraphNode({ graphId, id: 'parent', backlogItemId: parentItem.item.id });
  await graphs.addWorkGraphNode({ graphId, id: 'child', backlogItemId: childItem.item.id });
  await graphs.addWorkGraphEdge({
    graphId,
    fromNodeId: 'parent',
    toNodeId: 'child',
    condition: { kind: 'published' },
  });
  await graphs.addWorkGraphEdge({
    graphId,
    fromNodeId: 'parent',
    toNodeId: 'child',
    condition: { kind: 'merged' },
    blocks: 'completion',
    unlock: { kind: 'rebase-onto', flow: 'update-branch' },
  });
  const parent = runs.createRun({
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'Parent',
    backlogItemId: parentItem.item.id,
    workGraphId: graphId,
    workNodeId: 'parent',
  });
  runs.updateRun(parent.id, { status: 'done', prNumber: 17, branch: 'feat/parent' });
  await runs.persistRunNow(parent);
  const run = runs.createRun({
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'Retained child',
    backlogItemId: childItem.item.id,
  });
  runs.updateRun(run.id, { status: 'human-gating', branch: 'feat/child' });
  await runs.persistRunNow(run);
  // Seed only the upstream projection for this unit fixture. The tested RPC,
  // Run transaction and graph projection remain the production implementations.
  const snapshot = graphs.getWorkGraph({ graphId }).graph;
  const upstream = snapshot.nodes.find((node) => node.id === 'parent')!;
  upstream.currentFamilyId = parent.familyId;
  upstream.currentRootRunId = parent.id;
  upstream.latestRunId = parent.id;
  upstream.status = 'succeeded';
  await writeFile(
    path.join(process.env.FARMSLOT_WORK_GRAPH_DIR!, `${graphId}.json`),
    JSON.stringify(snapshot),
  );
  await graphs.loadWorkGraphs();
  const params = { graphId, nodeId: 'child', runId: run.id, expectedHeadSha: childHead };
  return {
    params,
    run,
    parent,
    before: structuredClone(run),
    graphBefore: graphs.getWorkGraph({ graphId }).graph,
  };
}

test('publication-gate attachment preserves execution and proof while binding the existing graph', async () => {
  const { params, before } = await fixture();
  const result = await graphs.attachWorkGraphRun(params, deps);
  assert.equal(result.run.stack?.resolvedSha, parentHead);
  assert.equal(result.run.stack?.baseBranch, 'feat/parent');
  assert.equal(result.run.workGraphId, params.graphId);
  assert.equal(result.publicationRefreshRequired, true);
  const { workGraphId: _graph, workNodeId: _node, stack: _stack, ...execution } = result.run;
  const { workGraphId: _oldGraph, workNodeId: _oldNode, stack: _oldStack, ...prior } = before;
  assert.deepEqual(execution, prior);
  assert.equal(result.graph.nodes.find((node) => node.id === 'child')?.status, 'gated');
  assert.equal(queue.getQueueSnapshot().length, 0);
  assert.equal(runs.getAllRuns().length, 2);
});

test('identical retry preserves the recorded upstream after merge and restart', async () => {
  const { params, parent } = await fixture();
  const first = await graphs.attachWorkGraphRun(params, deps);
  runs.updateRun(parent.id, { prState: 'MERGED' });
  await runs.persistRunNow(parent);
  await runs.loadAllRuns();
  await graphs.loadWorkGraphs();
  const retry = await graphs.attachWorkGraphRun(params, {
    ...deps,
    source: async (_run, stack, _head, existing) => {
      assert.equal(existing, true);
      assert.deepEqual(stack, first.run.stack);
      return { headSha: childHead, publicationRefreshRequired: true };
    },
    progress: async () => {
      throw new Error('New-attachment progress admission must not repeat');
    },
  });
  assert.deepEqual(retry.run.stack, first.run.stack);
  assert.equal(queue.getQueueSnapshot().length, 0);
});

test('progress and uncertain source refuse before any relationship writes', async () => {
  const { params, before, graphBefore } = await fixture();
  for (const kind of ['making-progress', 'unproven', 'awaiting-input'] as const) {
    await assert.rejects(
      graphs.attachWorkGraphRun(params, { ...deps, progress: async () => ({ kind }) }),
      { code: 'WORK_GRAPH_ATTACH_PROGRESS_UNCONFIRMED' },
    );
    assert.deepEqual(runs.getRun(params.runId), before);
  }
  await assert.rejects(
    graphs.attachWorkGraphRun(params, {
      ...deps,
      source: async () => ({
        headSha: 'c'.repeat(40),
        upstreamSha: parentHead,
        publicationRefreshRequired: false,
      }),
    }),
    { code: 'WORK_GRAPH_ATTACH_SOURCE_UNVERIFIED' },
  );
  assert.deepEqual(graphs.getWorkGraph({ graphId: params.graphId }).graph, graphBefore);
});

test('published work and a mismatched backlog or graph cannot be attached', async () => {
  const { params, run } = await fixture();
  await assert.rejects(graphs.attachWorkGraphRun({ ...params, nodeId: 'parent' }, deps), {
    code: 'WORK_GRAPH_ATTACH_BACKLOG_MISMATCH',
  });
  runs.updateRun(run.id, { prNumber: 18 });
  await assert.rejects(graphs.attachWorkGraphRun(params, deps), {
    code: 'WORK_GRAPH_ATTACH_ALREADY_PUBLISHED',
  });
  runs.updateRun(run.id, { prNumber: undefined, workGraphId: 'other-graph' });
  await assert.rejects(graphs.attachWorkGraphRun(params, deps), {
    code: 'WORK_GRAPH_ATTACH_BINDING_CONFLICT',
  });
  assert.equal(run.stack, undefined);
});

test('a run or graph change during verification refuses the stale subject', async () => {
  const { params, run } = await fixture();
  await assert.rejects(
    graphs.attachWorkGraphRun(params, {
      ...deps,
      source: async (...args) => {
        runs.updateRun(run.id, { branch: 'feat/changed' });
        return deps.source(...args);
      },
    }),
    { code: 'WORK_GRAPH_ATTACH_SUBJECT_CHANGED' },
  );
  assert.equal(run.stack, undefined);
});

test('failed Run persistence leaves both relationship and graph unchanged', async () => {
  const { params, before, graphBefore } = await fixture();
  const directory = process.env.FARMSLOT_RUNS_DIR!;
  await rename(directory, `${directory}.saved`);
  await writeFile(directory, 'not a directory');
  try {
    await assert.rejects(graphs.attachWorkGraphRun(params, deps));
    assert.deepEqual(runs.getRun(params.runId), before);
    assert.deepEqual(graphs.getWorkGraph({ graphId: params.graphId }).graph, graphBefore);
  } finally {
    await rm(directory);
    await rename(`${directory}.saved`, directory);
  }
});

test('durable Run binding recovers from a failed graph write through the same RPC', async () => {
  const { params } = await fixture();
  const file = path.join(process.env.FARMSLOT_WORK_GRAPH_DIR!, `${params.graphId}.json`);
  const previous = await readFile(file);
  await rm(file);
  await mkdir(file);
  try {
    await assert.rejects(graphs.attachWorkGraphRun(params, deps));
    assert.equal(runs.getRun(params.runId)?.workGraphId, params.graphId);
  } finally {
    await rm(file, { recursive: true });
    await writeFile(file, previous);
  }
  await runs.loadAllRuns();
  await graphs.loadWorkGraphs();
  const result = await graphs.attachWorkGraphRun(params, deps);
  assert.equal(
    result.graph.nodes.find((node) => node.id === 'child')?.currentRootRunId,
    params.runId,
  );
  assert.equal(queue.getQueueSnapshot().length, 0);
});

test('scheduling graphs and foreign native ownership refuse before source reads', async () => {
  const { params, run } = await fixture();
  const graph = graphs.getWorkGraph({ graphId: params.graphId }).graph;
  graph.graph.status = 'active';
  const file = path.join(process.env.FARMSLOT_WORK_GRAPH_DIR!, `${params.graphId}.json`);
  await writeFile(file, JSON.stringify(graph));
  await graphs.loadWorkGraphs();
  await assert.rejects(graphs.attachWorkGraphRun(params, deps), {
    code: 'WORK_GRAPH_ATTACH_GRAPH_SCHEDULING',
  });
  graph.graph.status = 'planning';
  await writeFile(file, JSON.stringify(graph));
  await graphs.loadWorkGraphs();
  // A retained native record owned by another principal, seeded as test data.
  run.transport = 'native';
  run.nativeOwnerPrincipalId = 'foreign-owner';
  await assert.rejects(graphs.attachWorkGraphRun(params, deps), { code: 'AUTH_FORBIDDEN' });
  assert.equal(run.stack, undefined);
});
