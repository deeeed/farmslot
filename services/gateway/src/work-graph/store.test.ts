import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { FleetStatus, SlotStatus } from '@farmslot/protocol';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-work-graph-test-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_WORK_GRAPH_DIR = path.join(testDir, 'graphs');
process.env.FARMSLOT_RUNS_DIR = path.join(testDir, 'runs');

test.after(() => rm(testDir, { recursive: true, force: true }));

function testSlot(slot: string, project = 'farmslot-farm'): SlotStatus {
  return {
    slot,
    machine: 'test-machine',
    platform: 'cli',
    project,
    health: { ssh: 'OK', devserver: 'OK', device: 'OK', cdp: 'OK', fixtures: 'OK' },
    branch: 'main',
    session: slot,
    repo: '.',
    linkedWorktree: false,
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'manual',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    currentRunId: null,
    currentFlowType: null,
    currentTicketOrPr: null,
    currentMode: null,
    currentFamilyId: null,
    currentLane: null,
    currentVariant: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    resourceRollup: 'none',
  };
}

function testFleet(): FleetStatus {
  const slots = [testSlot('macwork-ff-1'), testSlot('macwork-ff-2'), testSlot('macwork-ff-3')];
  return {
    checkedAt: '2026-01-01T00:00:00.000Z',
    slots,
    summary: {
      total: slots.length,
      ready: 0,
      busy: 0,
      held: 0,
      manual: slots.length,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  };
}

async function freshStores() {
  const backlog = await import('../backlog/store.js');
  const queue = await import('../backlog/dispatch-queue.js');
  const runs = await import('../runs/store.js');
  const fleetState = await import('../fleet/state.js');
  const workGraph = await import('./store.js');
  fleetState.setCachedFleetForTests(testFleet());
  await rm(process.env.FARMSLOT_BACKLOG_FILE!, { force: true });
  await rm(process.env.FARMSLOT_DISPATCH_QUEUE_FILE!, { force: true });
  await rm(process.env.FARMSLOT_WORK_GRAPH_DIR!, { recursive: true, force: true });
  await rm(process.env.FARMSLOT_RUNS_DIR!, { recursive: true, force: true });
  backlog.initBacklogStore(() => {});
  queue.initDispatchQueue(
    () => {},
    async () => {},
  );
  workGraph.initWorkGraphStore(() => {});
  await queue.loadQueue();
  await backlog.loadBacklog();
  await workGraph.loadWorkGraphs();
  await runs.loadAllRuns();
  return { backlog, queue, runs, workGraph };
}

async function createReadyBacklogItem(
  backlog: Awaited<ReturnType<typeof freshStores>>['backlog'],
  title: string,
  project = 'farmslot-farm',
) {
  return backlog.createBacklogItem({
    project,
    title,
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
  });
}

test('work graph rejects cycles while authoring edges', async () => {
  const { backlog, workGraph } = await freshStores();
  const first = await createReadyBacklogItem(backlog, 'First graph task');
  const second = await createReadyBacklogItem(backlog, 'Second graph task');
  const graph = await workGraph.createWorkGraph({ project: 'farmslot-farm', title: 'Cycle graph' });
  await workGraph.addWorkGraphNode({
    graphId: graph.graph.graph.id,
    id: 'wn_first',
    backlogItemId: first.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId: graph.graph.graph.id,
    id: 'wn_second',
    backlogItemId: second.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId: graph.graph.graph.id,
    fromNodeId: 'wn_first',
    toNodeId: 'wn_second',
    condition: { kind: 'family-done' },
  });

  await assert.rejects(
    () =>
      workGraph.addWorkGraphEdge({
        graphId: graph.graph.graph.id,
        fromNodeId: 'wn_second',
        toNodeId: 'wn_first',
        condition: { kind: 'family-done' },
      }),
    /cycle/i,
  );
});

test('work graph can use an owner scope different from backlog project', async () => {
  const { backlog, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Gateway projection');
  const downstream = await createReadyBacklogItem(backlog, 'Client integration');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Cross project graph',
  });
  const graphId = graph.graph.graph.id;

  await workGraph.addWorkGraphNode({ graphId, id: 'wn_gateway', backlogItemId: upstream.item.id });
  const linked = await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_client',
    backlogItemId: downstream.item.id,
  });

  assert.equal(linked.graph.nodes.length, 2);
  assert.equal(linked.graph.graph.project, 'cross-project-epic');
});

test('work graph keeps launch-plan backlog item as one node and queues baseline only', async () => {
  const { backlog, queue, workGraph } = await freshStores();
  const item = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Compare launch candidates',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'ready',
    launchPlan: {
      id: 'lp_graph',
      version: 1,
      candidates: [
        {
          id: 'baseline',
          role: 'baseline',
          runner: 'claude',
          model: 'opus',
          slotPolicy: { kind: 'exact', slotId: 'macwork-ff-1' },
        },
        {
          id: 'comparison',
          role: 'comparison',
          runner: 'claude',
          model: 'sonnet',
          variant: 'claude-sonnet',
          slotPolicy: { kind: 'spread' },
        },
      ],
    },
  });
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Launch plan graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_launch', backlogItemId: item.item.id });

  await workGraph.activateWorkGraph({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.length, 1);
  assert.equal(projection.nodes[0]?.backlogItemId, item.item.id);
  const queued = queue.getQueueSnapshot().filter((entry) => entry.backlogItemId === item.item.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.launchCandidateId, 'baseline');
});

test('reference blockers are v1 graph nodes but never dispatchable', async () => {
  const { backlog, queue, workGraph } = await freshStores();
  const downstream = await createReadyBacklogItem(backlog, 'Client release task');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'External blocker graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_external_pr',
    kind: 'reference',
    reference: {
      kind: 'github-pr',
      title: 'External controller PR',
      ref: 'metamask/core#1842',
      status: 'pending',
      project: 'metamask-core',
      labels: ['external', 'pr'],
    },
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_client_release',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_pr_to_release',
    fromNodeId: 'wn_external_pr',
    toNodeId: 'wn_client_release',
    condition: { kind: 'reference-status' },
    unlock: { kind: 'enqueue' },
  });

  await workGraph.activateWorkGraph({ graphId });
  await workGraph.schedulerTick({ graphId });

  let projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.find((node) => node.id === 'wn_external_pr')?.kind, 'reference');
  assert.equal(projection.nodes.find((node) => node.id === 'wn_external_pr')?.status, 'waiting');
  assert.equal(projection.nodes.find((node) => node.id === 'wn_client_release')?.status, 'waiting');
  assert.equal(queue.getQueueSnapshot().length, 0);

  await workGraph.updateWorkGraphNode({
    graphId,
    nodeId: 'wn_external_pr',
    reference: {
      kind: 'github-pr',
      title: 'External controller PR',
      ref: 'metamask/core#1842',
      status: 'satisfied',
      project: 'metamask-core',
      evidence: 'Merged upstream',
      updatedAt: new Date().toISOString(),
    },
  });
  projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(
    projection.edges.find((edge) => edge.id === 'we_pr_to_release')?.status,
    'satisfied',
  );
  assert.equal(projection.nodes.find((node) => node.id === 'wn_client_release')?.status, 'queued');
  assert.equal(
    projection.ledger.some(
      (entry) => entry.nodeId === 'wn_client_release' && entry.actionKind === 'enqueue',
    ),
    true,
  );

  await workGraph.updateWorkGraphNode({
    graphId,
    nodeId: 'wn_external_pr',
    reference: {
      kind: 'github-pr',
      title: 'External controller PR',
      ref: 'metamask/core#1842',
      status: 'pending',
      project: 'metamask-core',
      updatedAt: new Date().toISOString(),
    },
  });
  projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.edges.find((edge) => edge.id === 'we_pr_to_release')?.status, 'pending');
  assert.equal(
    projection.nodes.find((node) => node.id === 'wn_client_release')?.status,
    'needs-attention',
  );
  assert.equal(projection.graph.status, 'needs-attention');
});

/* Reference evidence can change after a graph looked complete. Re-evaluate instead of leaving stale done state. */
test('reference updates reactivate done graphs and surface regressed dependencies', async () => {
  const { backlog, queue, runs, workGraph } = await freshStores();
  const downstream = await createReadyBacklogItem(backlog, 'Client already completed');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Completed reference graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_external_pr',
    kind: 'reference',
    reference: {
      kind: 'github-pr',
      title: 'External controller PR',
      ref: 'metamask/core#1842',
      status: 'satisfied',
      project: 'metamask-core',
    },
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_client_release',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_pr_to_release',
    fromNodeId: 'wn_external_pr',
    toNodeId: 'wn_client_release',
    condition: { kind: 'reference-status' },
    unlock: { kind: 'enqueue' },
  });
  await workGraph.activateWorkGraph({ graphId });

  const queued = queue
    .getQueueSnapshot()
    .find((item) => item.workGraphId === graphId && item.workNodeId === 'wn_client_release');
  assert.ok(queued);
  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: downstream.item.sourceRef,
    backlogItemId: downstream.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_client_release',
  });
  await backlog.markBacklogRunStarted(queued, run);
  queue.removeQueueItemInternal(queued.id, 'test-dispatch-started');
  runs.updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  await workGraph.schedulerTick({ graphId });

  let projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.graph.status, 'done');
  assert.ok(
    projection.nodes.find((node) => node.id === 'wn_client_release')?.schedulerAuthorizedAt,
  );

  // Simulate a snapshot written before schedulerAuthorizedAt existed. The
  // completed enqueue ledger must restore scheduler ownership on reload so a
  // later prerequisite regression is still surfaced.
  const graphFile = path.join(process.env.FARMSLOT_WORK_GRAPH_DIR!, `${graphId}.json`);
  const persisted = JSON.parse(await readFile(graphFile, 'utf-8')) as {
    nodes: Array<{ id: string; schedulerAuthorizedAt?: string }>;
  };
  const persistedNode = persisted.nodes.find((node) => node.id === 'wn_client_release');
  assert.ok(persistedNode);
  delete persistedNode.schedulerAuthorizedAt;
  await writeFile(graphFile, JSON.stringify(persisted, null, 2), 'utf-8');
  workGraph.initWorkGraphStore(() => {});
  await workGraph.loadWorkGraphs();
  assert.equal(
    workGraph.getWorkGraph({ graphId }).graph.nodes.find((node) => node.id === 'wn_client_release')
      ?.schedulerAuthorizedAt,
    undefined,
  );

  await workGraph.updateWorkGraphNode({
    graphId,
    nodeId: 'wn_external_pr',
    reference: {
      kind: 'github-pr',
      title: 'External controller PR',
      ref: 'metamask/core#1842',
      status: 'pending',
      project: 'metamask-core',
      updatedAt: new Date().toISOString(),
    },
  });

  projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.graph.status, 'needs-attention');
  assert.equal(projection.edges.find((edge) => edge.id === 'we_pr_to_release')?.status, 'pending');
  assert.equal(
    projection.nodes.find((node) => node.id === 'wn_client_release')?.status,
    'needs-attention',
  );
  assert.ok(
    projection.nodes.find((node) => node.id === 'wn_client_release')?.schedulerAuthorizedAt,
  );
});

test('completed runs stay succeeded when historical reconciliation bypassed a start dependency', async () => {
  const { backlog, runs, workGraph } = await freshStores();
  const downstream = await createReadyBacklogItem(backlog, 'Historically completed work');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Historical reconciliation graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_external_pr',
    kind: 'reference',
    reference: {
      kind: 'github-pr',
      title: 'Pending prerequisite',
      ref: 'metamask/core#1842',
      status: 'pending',
      project: 'metamask-core',
    },
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_historical_run',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_pr_to_historical_run',
    fromNodeId: 'wn_external_pr',
    toNodeId: 'wn_historical_run',
    condition: { kind: 'reference-status' },
    unlock: { kind: 'enqueue' },
  });
  await workGraph.activateWorkGraph({ graphId });

  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: downstream.item.sourceRef,
    backlogItemId: downstream.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_historical_run',
  });
  runs.updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });

  const projection = await workGraph.schedulerTick({ graphId });
  const node = projection.graphs[0]?.nodes.find(
    (candidate) => candidate.id === 'wn_historical_run',
  );
  assert.equal(node?.status, 'succeeded');
  assert.deepEqual(node?.waitingOn, []);
  assert.equal(node?.schedulerAuthorizedAt, undefined);
  assert.equal(projection.graphs[0]?.graph.status, 'waiting');
});

test('failed required edges targeting reference nodes keep graph attention visible', async () => {
  const { workGraph } = await freshStores();
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Failed reference dependency graph',
  });
  const graphId = graph.graph.graph.id;
  for (const id of ['wn_reference_upstream', 'wn_reference_downstream']) {
    await workGraph.addWorkGraphNode({
      graphId,
      id,
      kind: 'reference',
      reference: {
        kind: 'github-pr',
        title: id,
        ref: `metamask/core#${id === 'wn_reference_upstream' ? '1842' : '1843'}`,
        status: 'satisfied',
        project: 'metamask-core',
      },
    });
  }
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_failed_reference_gate',
    fromNodeId: 'wn_reference_upstream',
    toNodeId: 'wn_reference_downstream',
    condition: { kind: 'manual', gateId: 'reference-gate' },
  });
  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_failed_reference_gate',
    gateId: 'reference-gate',
    reason: 'reference dependency rejected',
    decision: 'rejected',
  });
  await workGraph.activateWorkGraph({ graphId });

  const projection = await workGraph.schedulerTick({ graphId });
  assert.equal(projection.graphs[0]?.graph.status, 'needs-attention');
  assert.equal(
    projection.graphs[0]?.nodes.find((node) => node.id === 'wn_reference_downstream')?.status,
    'needs-attention',
  );
});

test('completion edges do not block downstream start enqueue', async () => {
  const { backlog, workGraph } = await freshStores();
  const contract = await createReadyBacklogItem(backlog, 'Shared contract');
  const gateway = await createReadyBacklogItem(backlog, 'Gateway projection');
  const client = await createReadyBacklogItem(backlog, 'Client can start early');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Completion blocker graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_contract', backlogItemId: contract.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_gateway', backlogItemId: gateway.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_client', backlogItemId: client.item.id });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_contract_to_client_start',
    fromNodeId: 'wn_contract',
    toNodeId: 'wn_client',
    condition: { kind: 'manual', gateId: 'start-approved' },
    unlock: { kind: 'enqueue' },
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_gateway_to_client_completion',
    fromNodeId: 'wn_gateway',
    toNodeId: 'wn_client',
    condition: { kind: 'merged', targetRef: 'main' },
    blocks: 'completion',
    unlock: { kind: 'rebase-onto', flow: 'update-branch' },
  });
  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_contract_to_client_start',
    gateId: 'start-approved',
    reason: 'start dependency is satisfied',
    decision: 'approved',
  });

  await workGraph.activateWorkGraph({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.find((node) => node.id === 'wn_client')?.status, 'queued');
  assert.equal(
    projection.edges.find((edge) => edge.id === 'we_gateway_to_client_completion')?.status,
    'pending',
  );
  assert.equal(projection.graph.status, 'waiting');
});

test('satisfied completion rebase edges surface operator attention', async () => {
  const { backlog, workGraph } = await freshStores();
  const gateway = await createReadyBacklogItem(backlog, 'Gateway projection');
  const client = await createReadyBacklogItem(backlog, 'Client already started');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Completion rebase graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_gateway', backlogItemId: gateway.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_client', backlogItemId: client.item.id });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_gateway_to_client_rebase',
    fromNodeId: 'wn_gateway',
    toNodeId: 'wn_client',
    condition: { kind: 'manual', gateId: 'gateway-merged' },
    blocks: 'completion',
    unlock: { kind: 'rebase-onto', flow: 'update-branch' },
  });
  await workGraph.updateWorkGraphNode({ graphId, nodeId: 'wn_client', status: 'succeeded' });
  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_gateway_to_client_rebase',
    gateId: 'gateway-merged',
    reason: 'upstream merged after client started',
    decision: 'approved',
  });

  await workGraph.activateWorkGraph({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.graph.status, 'needs-attention');
  assert.equal(projection.nodes.find((node) => node.id === 'wn_client')?.status, 'needs-attention');
  assert.match(
    projection.nodes.find((node) => node.id === 'wn_client')?.waitingOn[0]?.detail ?? '',
    /rebase-onto unlock requires/,
  );
  assert.equal(
    projection.ledger.find((entry) => entry.nodeId === 'wn_client')?.actionKind,
    'rebase-onto',
  );

  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_gateway_to_client_rebase',
    gateId: 'gateway-merged',
    reason: 'operator re-opened the same completion gate',
    decision: 'approved',
  });
  const afterReopen = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(
    afterReopen.ledger.filter(
      (entry) => entry.nodeId === 'wn_client' && entry.actionKind === 'rebase-onto',
    ).length,
    1,
  );
});

test('failed completion edges move dependents to needs-attention', async () => {
  const { backlog, workGraph } = await freshStores();
  const gateway = await createReadyBacklogItem(backlog, 'Gateway projection');
  const client = await createReadyBacklogItem(backlog, 'Client blocked at completion');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Failed completion graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_gateway', backlogItemId: gateway.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_client', backlogItemId: client.item.id });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_gateway_to_client_completion_gate',
    fromNodeId: 'wn_gateway',
    toNodeId: 'wn_client',
    condition: { kind: 'manual', gateId: 'completion-rejected' },
    blocks: 'completion',
    unlock: { kind: 'rebase-onto', flow: 'update-branch' },
  });
  await workGraph.updateWorkGraphNode({ graphId, nodeId: 'wn_client', status: 'succeeded' });
  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_gateway_to_client_completion_gate',
    gateId: 'completion-rejected',
    reason: 'completion gate rejected',
    decision: 'rejected',
  });

  await workGraph.activateWorkGraph({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  const clientNode = projection.nodes.find((node) => node.id === 'wn_client');
  assert.equal(projection.graph.status, 'needs-attention');
  assert.equal(clientNode?.status, 'needs-attention');
  assert.equal(clientNode?.waitingOn[0]?.edgeId, 'we_gateway_to_client_completion_gate');
});

test('work graph rejects unsafe explicit ids', async () => {
  const { workGraph } = await freshStores();

  await assert.rejects(
    () =>
      workGraph.createWorkGraph({
        id: '../escape',
        project: 'farmslot-farm',
        title: 'Unsafe graph id',
      }),
    /Invalid identifier/,
  );
});

test('scheduler ignores stale backlog runs that were not graph-authorized', async () => {
  const { backlog, runs, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Previously run task');
  const downstream = await createReadyBacklogItem(backlog, 'Dependent task');
  const staleRun = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: upstream.item.sourceRef,
    backlogItemId: upstream.item.id,
  });
  runs.updateRun(staleRun.id, { status: 'done', completedAt: new Date().toISOString() });
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Stale run graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_stale_upstream',
    backlogItemId: upstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_stale_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_requires_fresh_graph_run',
    fromNodeId: 'wn_stale_upstream',
    toNodeId: 'wn_stale_downstream',
    condition: { kind: 'family-done' },
  });

  await workGraph.activateWorkGraph({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.notEqual(
    projection.nodes.find((node) => node.id === 'wn_stale_upstream')?.status,
    'succeeded',
  );
  assert.equal(
    projection.edges.find((edge) => edge.id === 'we_requires_fresh_graph_run')?.status,
    'pending',
  );
  assert.equal(
    projection.nodes.find((node) => node.id === 'wn_stale_downstream')?.status,
    'waiting',
  );
});

test('graph-linked backlog items reject manual enqueue and auto-dispatch skips them', async () => {
  const { backlog, queue, workGraph } = await freshStores();
  const item = await createReadyBacklogItem(backlog, 'Graph owned task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Protected graph',
  });
  await workGraph.addWorkGraphNode({
    graphId: graph.graph.graph.id,
    id: 'wn_owned',
    backlogItemId: item.item.id,
  });

  await assert.rejects(
    () => backlog.enqueueBacklogItem({ itemId: item.item.id }),
    /linked to a work graph/,
  );
  const tick = await backlog.autoDispatchBacklogReady({ project: 'farmslot-farm' });
  assert.equal(tick.enqueued.length, 0);
  assert.equal(
    queue.getQueueSnapshot().filter((entry) => entry.backlogItemId === item.item.id).length,
    0,
  );
});

test('scheduler respects graph node auto-dispatch opt-out until re-enabled', async () => {
  const { backlog, queue, workGraph } = await freshStores();
  const item = await createReadyBacklogItem(backlog, 'Operator staged graph task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Operator controlled graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_staged',
    backlogItemId: item.item.id,
  });
  await backlog.updateBacklogItem({ itemId: item.item.id, autoDispatch: false });
  await workGraph.activateWorkGraph({ graphId });

  await workGraph.schedulerTick({ graphId });

  let projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.find((node) => node.id === 'wn_staged')?.status, 'ready');
  assert.equal(queue.getQueueSnapshot().length, 0);

  await backlog.updateBacklogItem({ itemId: item.item.id, autoDispatch: true });
  await workGraph.schedulerTick({ graphId });

  projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.find((node) => node.id === 'wn_staged')?.status, 'queued');
});

test('manual schedulerTick forceEnqueue bypasses auto-dispatch opt-out', async () => {
  const { backlog, queue, workGraph } = await freshStores();
  const item = await createReadyBacklogItem(backlog, 'Manual force enqueue graph task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Manual force enqueue graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_force',
    backlogItemId: item.item.id,
  });
  await backlog.updateBacklogItem({ itemId: item.item.id, autoDispatch: false });
  await workGraph.activateWorkGraph({ graphId });

  await workGraph.schedulerTick({ graphId });
  assert.equal(
    workGraph.getWorkGraph({ graphId }).graph.nodes.find((node) => node.id === 'wn_force')?.status,
    'ready',
  );
  assert.equal(queue.getQueueSnapshot().length, 0);

  await workGraph.schedulerTick({ graphId, forceEnqueue: true });
  assert.equal(
    workGraph.getWorkGraph({ graphId }).graph.nodes.find((node) => node.id === 'wn_force')?.status,
    'queued',
  );
  assert.equal(queue.getQueueSnapshot().length, 1);
});

test('scheduler reconciles restart/idempotency and does not duplicate graph enqueues', async () => {
  const { backlog, runs, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Upstream task');
  const downstream = await createReadyBacklogItem(backlog, 'Downstream task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Fan out graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_upstream', backlogItemId: upstream.item.id });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    fromNodeId: 'wn_upstream',
    toNodeId: 'wn_downstream',
    condition: { kind: 'family-done' },
  });
  await workGraph.activateWorkGraph({ graphId });

  const upstreamRun = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: upstream.item.sourceRef,
    backlogItemId: upstream.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_upstream',
  });
  runs.updateRun(upstreamRun.id, { status: 'done', completedAt: new Date().toISOString() });

  await workGraph.schedulerTick({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.find((node) => node.id === 'wn_downstream')?.status, 'queued');
  assert.equal(
    projection.ledger.filter(
      (entry) =>
        entry.nodeId === 'wn_downstream' &&
        entry.actionKind === 'enqueue' &&
        entry.status === 'completed',
    ).length,
    1,
  );
  assert.match(
    projection.ledger.find(
      (entry) =>
        entry.nodeId === 'wn_downstream' &&
        entry.actionKind === 'enqueue' &&
        entry.status === 'completed',
    )?.result ?? '',
    /^queue:/,
  );
});

test('scheduler isolates an unenqueueable node and continues scheduling siblings', async () => {
  const { backlog, workGraph } = await freshStores();
  const blocked = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Candidate task',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'candidate',
  });
  const ready = await createReadyBacklogItem(backlog, 'Ready sibling task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Isolation graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_blocked', backlogItemId: blocked.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_ready', backlogItemId: ready.item.id });

  await workGraph.activateWorkGraph({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.graph.status, 'needs-attention');
  assert.equal(
    projection.nodes.find((node) => node.id === 'wn_blocked')?.status,
    'needs-attention',
  );
  assert.equal(projection.nodes.find((node) => node.id === 'wn_ready')?.status, 'queued');
  assert.equal(
    projection.ledger.filter(
      (entry) =>
        entry.nodeId === 'wn_ready' &&
        entry.actionKind === 'enqueue' &&
        entry.status === 'completed',
    ).length,
    1,
  );
  assert.match(
    projection.ledger.find(
      (entry) =>
        entry.nodeId === 'wn_blocked' &&
        entry.actionKind === 'enqueue' &&
        entry.status === 'failed',
    )?.result ?? '',
    /Cannot enqueue backlog item in status candidate/,
  );
});

test('scheduler retries enqueue when completed ledger is stale after backlog reset', async () => {
  const { backlog, queue, runs, workGraph } = await freshStores();
  const created = await createReadyBacklogItem(backlog, 'Retry stale ledger');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Retry stale ledger graph',
  });
  const graphId = graph.graph.graph.id;
  const nodeId = 'wn_retry';
  await workGraph.addWorkGraphNode({ graphId, id: nodeId, backlogItemId: created.item.id });
  await workGraph.activateWorkGraph({ graphId });

  const queued = queue
    .getQueueSnapshot()
    .find((item) => item.workGraphId === graphId && item.workNodeId === nodeId);
  assert.ok(queued);

  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    workGraphId: graphId,
    workNodeId: nodeId,
  });
  await backlog.markBacklogRunStarted(queued, run);
  queue.removeQueueItemInternal(queued.id, 'test-dispatch-started');
  runs.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
  backlog.markBacklogRunObserved({ ...run, status: 'failed' } as never);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await runs.deleteRun(run.id);
  await backlog.markBacklogRunReleased(run.id);

  const retick = await workGraph.schedulerTick({ graphId });
  const node = retick.graphs[0]?.nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.status, 'queued');
  assert.equal(
    backlog.listBacklogItems().items.find((item) => item.id === created.item.id)?.status,
    'queued',
  );
});

test('scheduler resets an orphaned running node once its run is deleted', async () => {
  const { backlog, queue, runs, workGraph } = await freshStores();
  const created = await createReadyBacklogItem(backlog, 'Orphaned running node');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Orphan running graph',
  });
  const graphId = graph.graph.graph.id;
  const nodeId = 'wn_orphan_running';
  await workGraph.addWorkGraphNode({ graphId, id: nodeId, backlogItemId: created.item.id });
  await workGraph.activateWorkGraph({ graphId });

  const queued = queue
    .getQueueSnapshot()
    .find((item) => item.workGraphId === graphId && item.workNodeId === nodeId);
  assert.ok(queued);
  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    workGraphId: graphId,
    workNodeId: nodeId,
  });
  await backlog.markBacklogRunStarted(queued, run);
  queue.removeQueueItemInternal(queued.id, 'test-dispatch-started');
  runs.updateRun(run.id, { status: 'monitoring' });

  // While the run is active the node reads running.
  const started = await workGraph.schedulerTick({ graphId });
  assert.equal(started.graphs[0]?.nodes.find((n) => n.id === nodeId)?.status, 'running');

  // Deleting the run releases the backlog item and makes the node orphaned.
  runs.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
  await runs.deleteRun(run.id);
  await backlog.markBacklogRunReleased(run.id);

  // The orphaned running node must not stay stuck — it is actually re-enqueued
  // and drops the dead run reference. Asserting `ready || queued` would pass on
  // a node that reconciled but never redispatched, which is the stall itself.
  const retick = await workGraph.schedulerTick({ graphId });
  const node = retick.graphs[0]?.nodes.find((n) => n.id === nodeId);
  assert.equal(node?.status, 'queued');
  assert.equal(node?.latestRunId, undefined);
  assert.ok(
    queue
      .getQueueSnapshot()
      .some((item) => item.workGraphId === graphId && item.workNodeId === nodeId),
  );
});

test('operator cancellation holds graph work until an explicit retry', async () => {
  const { backlog, queue, runs, workGraph } = await freshStores();
  const created = await createReadyBacklogItem(backlog, 'Cancelled graph node');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Cancelled graph',
  });
  const graphId = graph.graph.graph.id;
  const nodeId = 'wn_cancelled';
  await workGraph.addWorkGraphNode({ graphId, id: nodeId, backlogItemId: created.item.id });
  await workGraph.activateWorkGraph({ graphId });

  const queued = queue
    .getQueueSnapshot()
    .find((item) => item.workGraphId === graphId && item.workNodeId === nodeId);
  assert.ok(queued);
  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    workGraphId: graphId,
    workNodeId: nodeId,
  });
  await backlog.markBacklogRunStarted(queued, run);
  queue.removeQueueItemInternal(queued.id, 'test-dispatch-started');
  const cancelled = runs.updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
  });
  backlog.markBacklogRunObserved(cancelled);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const held = await workGraph.schedulerTick({ graphId });
  const heldNode = held.graphs[0]?.nodes.find((node) => node.id === nodeId);
  assert.equal(heldNode?.status, 'needs-attention');
  assert.equal(heldNode?.latestRunId, run.id);
  assert.equal(
    queue.getQueueSnapshot().some((item) => item.workNodeId === nodeId),
    false,
  );
  assert.equal(
    backlog.listBacklogItems().items.find((item) => item.id === created.item.id)?.status,
    'needs-attention',
  );

  await backlog.markBacklogItemReady({ itemId: created.item.id });
  const retried = await workGraph.schedulerTick({ graphId });
  assert.equal(retried.graphs[0]?.nodes.find((node) => node.id === nodeId)?.status, 'queued');
  assert.ok(queue.getQueueSnapshot().some((item) => item.workNodeId === nodeId));
});

test('manual gate resolution rejects ambiguous gate ids and can disambiguate by graph and edge', async () => {
  const { backlog, workGraph } = await freshStores();
  const firstUpstream = await createReadyBacklogItem(backlog, 'First upstream');
  const firstDownstream = await createReadyBacklogItem(backlog, 'First downstream');
  const secondUpstream = await createReadyBacklogItem(backlog, 'Second upstream');
  const secondDownstream = await createReadyBacklogItem(backlog, 'Second downstream');
  const firstGraph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'First gated graph',
  });
  const secondGraph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Second gated graph',
  });
  const firstGraphId = firstGraph.graph.graph.id;
  const secondGraphId = secondGraph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId: firstGraphId,
    id: 'wn_first_upstream',
    backlogItemId: firstUpstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId: firstGraphId,
    id: 'wn_first_downstream',
    backlogItemId: firstDownstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId: secondGraphId,
    id: 'wn_second_upstream',
    backlogItemId: secondUpstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId: secondGraphId,
    id: 'wn_second_downstream',
    backlogItemId: secondDownstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId: firstGraphId,
    id: 'we_first_gate',
    fromNodeId: 'wn_first_upstream',
    toNodeId: 'wn_first_downstream',
    condition: { kind: 'manual', gateId: 'shared-gate' },
  });
  await workGraph.addWorkGraphEdge({
    graphId: secondGraphId,
    id: 'we_second_gate',
    fromNodeId: 'wn_second_upstream',
    toNodeId: 'wn_second_downstream',
    condition: { kind: 'manual', gateId: 'shared-gate' },
  });

  await assert.rejects(
    () =>
      workGraph.gateResolve({
        gateId: 'shared-gate',
        reason: 'operator approval',
        decision: 'approved',
      }),
    /ambiguous/,
  );

  const resolved = await workGraph.gateResolve({
    graphId: secondGraphId,
    edgeId: 'we_second_gate',
    gateId: 'shared-gate',
    reason: 'operator approval',
    decision: 'approved',
  });

  assert.equal(resolved.graph.graph.id, secondGraphId);
  assert.equal(workGraph.getWorkGraph({ graphId: firstGraphId }).graph.gates.length, 0);
  assert.equal(
    workGraph.getWorkGraph({ graphId: secondGraphId }).graph.gates[0]?.edgeId,
    'we_second_gate',
  );
});

test('manual gate evaluation uses the latest resolution for the edge', async () => {
  const { backlog, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Gate upstream');
  const downstream = await createReadyBacklogItem(backlog, 'Gate downstream');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Corrected gate graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_gate_upstream',
    backlogItemId: upstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_gate_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_corrected_gate',
    fromNodeId: 'wn_gate_upstream',
    toNodeId: 'wn_gate_downstream',
    condition: { kind: 'manual', gateId: 'corrected-gate' },
  });
  await workGraph.activateWorkGraph({ graphId });

  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_corrected_gate',
    gateId: 'corrected-gate',
    reason: 'not yet',
    decision: 'rejected',
  });
  assert.equal(
    workGraph.getWorkGraph({ graphId }).graph.edges.find((edge) => edge.id === 'we_corrected_gate')
      ?.status,
    'failed',
  );

  await workGraph.gateResolve({
    graphId,
    edgeId: 'we_corrected_gate',
    gateId: 'corrected-gate',
    reason: 'approved after correction',
    decision: 'approved',
  });
  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(
    projection.edges.find((edge) => edge.id === 'we_corrected_gate')?.status,
    'satisfied',
  );
  assert.equal(projection.nodes.find((node) => node.id === 'wn_gate_downstream')?.status, 'queued');
  assert.equal(
    projection.ledger.some(
      (entry) => entry.nodeId === 'wn_gate_downstream' && entry.actionKind === 'enqueue',
    ),
    true,
  );
  assert.equal(projection.gates.length, 2);
  assert.equal(projection.gates[1]?.decision, 'approved');
});

test('mark-ready unlock is idempotent across repeated scheduler ticks', async () => {
  const { backlog, runs, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Mark ready upstream');
  const downstream = await backlog.createBacklogItem({
    project: 'farmslot-farm',
    title: 'Mark ready downstream',
    sourceKind: 'manual',
    flowType: 'dev',
    status: 'candidate',
  });
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Mark ready graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_mark_upstream',
    backlogItemId: upstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_mark_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_mark_ready',
    fromNodeId: 'wn_mark_upstream',
    toNodeId: 'wn_mark_downstream',
    condition: { kind: 'family-done' },
    unlock: { kind: 'mark-ready' },
  });
  await workGraph.activateWorkGraph({ graphId });
  const upstreamRun = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: upstream.item.sourceRef,
    backlogItemId: upstream.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_mark_upstream',
  });
  runs.updateRun(upstreamRun.id, { status: 'done', completedAt: new Date().toISOString() });

  await workGraph.schedulerTick({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.nodes.find((node) => node.id === 'wn_mark_downstream')?.status, 'ready');
  assert.equal(
    projection.ledger.filter(
      (entry) =>
        entry.nodeId === 'wn_mark_downstream' &&
        entry.actionKind === 'mark-ready' &&
        entry.status === 'completed',
    ).length,
    1,
  );
});

test('failed required upstream edges move dependents to needs-attention', async () => {
  const { backlog, runs, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Failed upstream task');
  const downstream = await createReadyBacklogItem(backlog, 'Blocked downstream task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Failure graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_failed_upstream',
    backlogItemId: upstream.item.id,
  });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_blocked_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_failed_dependency',
    fromNodeId: 'wn_failed_upstream',
    toNodeId: 'wn_blocked_downstream',
    condition: { kind: 'family-done' },
  });
  await workGraph.activateWorkGraph({ graphId });
  const upstreamRun = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: upstream.item.sourceRef,
    backlogItemId: upstream.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_failed_upstream',
  });
  runs.updateRun(upstreamRun.id, { status: 'failed', completedAt: new Date().toISOString() });

  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(projection.graph.status, 'needs-attention');
  assert.equal(
    projection.edges.find((edge) => edge.id === 'we_failed_dependency')?.status,
    'failed',
  );
  const blocked = projection.nodes.find((node) => node.id === 'wn_blocked_downstream');
  assert.equal(blocked?.status, 'needs-attention');
  assert.equal(blocked?.waitingOn[0]?.edgeId, 'we_failed_dependency');
});

test('implicit backlog node ids stay unique for long similar titles', async () => {
  const { backlog, workGraph } = await freshStores();
  const first = await createReadyBacklogItem(
    backlog,
    'Roadmap graph composer implementation shared prefix API slice',
  );
  const second = await createReadyBacklogItem(
    backlog,
    'Roadmap graph composer implementation shared prefix UI slice',
  );
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Implicit node id graph',
  });
  const graphId = graph.graph.graph.id;

  await workGraph.addWorkGraphNode({ graphId, backlogItemId: first.item.id });
  const projection = await workGraph.addWorkGraphNode({ graphId, backlogItemId: second.item.id });

  assert.equal(projection.graph.nodes.length, 2);
  assert.equal(new Set(projection.graph.nodes.map((node) => node.id)).size, 2);
});

test('planning graph removal detaches backlog nodes and removes incident edges', async () => {
  const { backlog, workGraph } = await freshStores();
  const first = await createReadyBacklogItem(backlog, 'Composable first task');
  const second = await createReadyBacklogItem(backlog, 'Composable second task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Editable planning graph',
  });
  const graphId = graph.graph.graph.id;

  await workGraph.addWorkGraphNode({ graphId, id: 'wn_first', backlogItemId: first.item.id });
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_second', backlogItemId: second.item.id });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_first_second',
    fromNodeId: 'wn_first',
    toNodeId: 'wn_second',
    condition: { kind: 'family-done' },
  });

  let linked = backlog.getBacklogItemSnapshot(first.item.id);
  assert.equal(linked?.workGraphId, graphId);
  assert.equal(linked?.workNodeId, 'wn_first');
  await assert.rejects(() => backlog.deleteBacklogItem(first.item.id), /linked to a work graph/);

  const withoutEdge = await workGraph.removeWorkGraphEdge({ graphId, edgeId: 'we_first_second' });
  assert.equal(withoutEdge.graph.edges.length, 0);

  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_first_second_again',
    fromNodeId: 'wn_first',
    toNodeId: 'wn_second',
    condition: { kind: 'family-done' },
  });
  const withoutNode = await workGraph.removeWorkGraphNode({ graphId, nodeId: 'wn_first' });
  assert.equal(
    withoutNode.graph.nodes.some((node) => node.id === 'wn_first'),
    false,
  );
  assert.equal(withoutNode.graph.edges.length, 0);
  linked = backlog.getBacklogItemSnapshot(first.item.id);
  assert.equal(linked?.workGraphId, undefined);
  assert.equal(linked?.workNodeId, undefined);
});

test('active graph removal is rejected', async () => {
  const { backlog, workGraph } = await freshStores();
  const item = await createReadyBacklogItem(backlog, 'Active graph task');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Active graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_active', backlogItemId: item.item.id });
  await workGraph.activateWorkGraph({ graphId });

  await assert.rejects(
    () => workGraph.removeWorkGraphNode({ graphId, nodeId: 'wn_active' }),
    /planning status/,
  );
  await assert.rejects(
    () => workGraph.removeWorkGraphEdge({ graphId, edgeId: 'we_missing' }),
    /planning status/,
  );
});

test('a succeeded node is reclaimed once its run is deleted and the item reopened', async () => {
  const { backlog, queue, runs, workGraph } = await freshStores();
  const created = await createReadyBacklogItem(backlog, 'Redispatch after delete');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Redispatch graph',
  });
  const graphId = graph.graph.graph.id;
  const nodeId = 'wn_succeeded_reclaim';
  await workGraph.addWorkGraphNode({ graphId, id: nodeId, backlogItemId: created.item.id });
  await workGraph.activateWorkGraph({ graphId });

  const queued = queue
    .getQueueSnapshot()
    .find((item) => item.workGraphId === graphId && item.workNodeId === nodeId);
  assert.ok(queued);
  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    workGraphId: graphId,
    workNodeId: nodeId,
  });
  await backlog.markBacklogRunStarted(queued, run);
  queue.removeQueueItemInternal(queued.id, 'test-dispatch-started');
  runs.updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  await workGraph.schedulerTick({ graphId });

  // The run is deleted and the operator reopens the item to run it again — the
  // exact recovery after a run that finished wrongly.
  await runs.deleteRun(run.id);
  await backlog.markBacklogItemReady({ itemId: created.item.id });

  // Without reclaiming a succeeded node this returns nothing to do, and the UI
  // reports only that the node succeeded while no run is ever created.
  const retick = await workGraph.schedulerTick({ graphId });
  const node = retick.graphs[0]?.nodes.find((n) => n.id === nodeId);
  assert.notEqual(node?.status, 'succeeded');
  assert.equal(node?.latestRunId, undefined);
  assert.equal(node?.currentFamilyId, undefined);

  // The tick's snapshot write is fire-and-forget; let it land before the suite's
  // after-hook removes the temp dir, or the write races rmdir into ENOTEMPTY.
  await queue.persistQueueNow();
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test('waiting node after fail+delete reclaims and re-enqueues despite completed ledger', async () => {
  // Live bug: TAT-3214 stayed status=waiting with empty waitingOn after the run
  // was deleted. Upstream edges were satisfied and enqueue ledger was completed,
  // so Dispatch reported "still waiting on upstream" and never re-queued.
  const { backlog, queue, runs, workGraph } = await freshStores();
  const created = await createReadyBacklogItem(backlog, 'Waiting stuck after delete');
  const graph = await workGraph.createWorkGraph({
    project: 'farmslot-farm',
    title: 'Waiting reclaim graph',
  });
  const graphId = graph.graph.graph.id;
  const nodeId = 'wn_waiting_reclaim';
  await workGraph.addWorkGraphNode({ graphId, id: nodeId, backlogItemId: created.item.id });
  await workGraph.activateWorkGraph({ graphId });

  const queued = queue
    .getQueueSnapshot()
    .find((item) => item.workGraphId === graphId && item.workNodeId === nodeId);
  assert.ok(queued);
  const run = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: created.item.sourceRef,
    backlogItemId: created.item.id,
    workGraphId: graphId,
    workNodeId: nodeId,
  });
  await backlog.markBacklogRunStarted(queued, run);
  queue.removeQueueItemInternal(queued.id, 'test-dispatch-started');
  runs.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
  backlog.markBacklogRunObserved({ ...run, status: 'failed' } as never);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await runs.deleteRun(run.id);
  await backlog.markBacklogRunReleased(run.id);
  await backlog.markBacklogItemReady({ itemId: created.item.id });

  // Force the stuck shape: waiting + empty waitingOn + no latestRunId, while the
  // completed enqueue ledger from the first dispatch remains.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const graphFile = path.join(process.env.FARMSLOT_WORK_GRAPH_DIR!, `${graphId}.json`);
  const snapshot = JSON.parse(await readFile(graphFile, 'utf-8')) as {
    nodes: Array<{
      id: string;
      status: string;
      waitingOn?: unknown[];
      latestRunId?: string;
      currentFamilyId?: string;
      currentRootRunId?: string;
    }>;
    ledger: Array<{ nodeId: string; actionKind: string; status: string }>;
  };
  const persisted = snapshot.nodes.find((node) => node.id === nodeId);
  assert.ok(persisted);
  persisted.status = 'waiting';
  persisted.waitingOn = [];
  delete persisted.latestRunId;
  delete persisted.currentFamilyId;
  delete persisted.currentRootRunId;
  assert.ok(
    snapshot.ledger.some(
      (entry) =>
        entry.nodeId === nodeId && entry.actionKind === 'enqueue' && entry.status === 'completed',
    ),
    'expected completed enqueue ledger from the first dispatch',
  );
  await writeFile(graphFile, JSON.stringify(snapshot, null, 2), 'utf-8');
  await workGraph.loadWorkGraphs();

  const retick = await workGraph.schedulerTick({ graphId, forceEnqueue: true });
  const node = retick.graphs[0]?.nodes.find((candidate) => candidate.id === nodeId);
  assert.equal(node?.status, 'queued');
  assert.equal(node?.latestRunId, undefined);
  assert.ok(
    queue
      .getQueueSnapshot()
      .some((item) => item.workGraphId === graphId && item.workNodeId === nodeId),
  );
  await queue.persistQueueNow();
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test('a merged upstream unblocks its dependent', async () => {
  // The evidence check used to cast Run to a shape carrying prState/mergedAt.
  // Run declared neither and nothing wrote them, so this edge stayed pending no
  // matter what shipped — every `merged` edge in every graph was unsatisfiable.
  const { backlog, runs, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Upstream that ships');
  const downstream = await createReadyBacklogItem(backlog, 'Dependent waiting on the merge');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Merged evidence graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_upstream', backlogItemId: upstream.item.id });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_upstream_merged',
    fromNodeId: 'wn_upstream',
    toNodeId: 'wn_downstream',
    condition: { kind: 'merged', targetRef: 'main' },
    unlock: { kind: 'enqueue' },
  });
  await workGraph.activateWorkGraph({ graphId });

  const upstreamRun = runs.createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: upstream.item.sourceRef,
    backlogItemId: upstream.item.id,
    workGraphId: graphId,
    workNodeId: 'wn_upstream',
  });

  runs.updateRun(upstreamRun.id, { status: 'done', completedAt: new Date().toISOString() });
  await workGraph.schedulerTick({ graphId });
  assert.equal(
    workGraph.getWorkGraph({ graphId }).graph.edges.find((e) => e.id === 'we_upstream_merged')
      ?.status,
    'pending',
    'a done run is not evidence of a merge on its own',
  );

  runs.updateRun(upstreamRun.id, {
    prNumber: 404,
    prState: 'MERGED',
    mergedAt: new Date().toISOString(),
  });
  await workGraph.schedulerTick({ graphId });
  await workGraph.schedulerTick({ graphId });

  const projection = workGraph.getWorkGraph({ graphId }).graph;
  const edge = projection.edges.find((e) => e.id === 'we_upstream_merged');
  assert.equal(edge?.status, 'satisfied');
  assert.equal(edge?.evidence?.prNumber, 404);
  assert.notEqual(
    projection.nodes.find((node) => node.id === 'wn_downstream')?.status,
    'waiting',
    'the dependent must not still be waiting on an upstream that merged',
  );
});

test('a targeted tick recomputes a graph stranded in needs-attention', async () => {
  // needs-attention was excluded from every tick, so a graph that reached it
  // could never be reprocessed — not even after the flagged condition cleared.
  const { backlog, workGraph } = await freshStores();
  const upstream = await createReadyBacklogItem(backlog, 'Upstream');
  const downstream = await createReadyBacklogItem(backlog, 'Dependent');
  const graph = await workGraph.createWorkGraph({
    project: 'cross-project-epic',
    title: 'Stranded graph',
  });
  const graphId = graph.graph.graph.id;
  await workGraph.addWorkGraphNode({ graphId, id: 'wn_upstream', backlogItemId: upstream.item.id });
  await workGraph.addWorkGraphNode({
    graphId,
    id: 'wn_downstream',
    backlogItemId: downstream.item.id,
  });
  await workGraph.addWorkGraphEdge({
    graphId,
    id: 'we_upstream_gate',
    fromNodeId: 'wn_upstream',
    toNodeId: 'wn_downstream',
    condition: { kind: 'manual', gateId: 'needs-approval' },
    unlock: { kind: 'enqueue' },
  });
  await workGraph.activateWorkGraph({ graphId });

  // Force the regression the scheduler punishes: a blocked node that had already
  // gone active. This flags both node and graph needs-attention.
  await workGraph.updateWorkGraphNode({ graphId, nodeId: 'wn_downstream', status: 'ready' });
  await workGraph.schedulerTick({ graphId });
  assert.equal(workGraph.getWorkGraph({ graphId }).graph.graph.status, 'needs-attention');

  await workGraph.schedulerTick({ graphId });
  const stranded = workGraph.getWorkGraph({ graphId }).graph;
  assert.equal(
    stranded.nodes
      .find((node) => node.id === 'wn_downstream')
      ?.waitingOn.filter((entry) => entry.kind === 'policy').length,
    0,
    'a targeted tick must recompute the node instead of leaving the policy strand pinned',
  );
  assert.equal(stranded.graph.status, 'waiting');
});
