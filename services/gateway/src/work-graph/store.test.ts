import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const testDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-work-graph-test-'));
process.env.FARMSLOT_BACKLOG_FILE = path.join(testDir, 'backlog.json');
process.env.FARMSLOT_DISPATCH_QUEUE_FILE = path.join(testDir, 'queue.json');
process.env.FARMSLOT_WORK_GRAPH_DIR = path.join(testDir, 'graphs');
process.env.FARMSLOT_RUNS_DIR = path.join(testDir, 'runs');

test.after(() => rm(testDir, { recursive: true, force: true }));

async function freshStores() {
  const backlog = await import('../backlog/store.js');
  const queue = await import('../backlog/dispatch-queue.js');
  const runs = await import('../runs/store.js');
  const workGraph = await import('./store.js');
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
    unlock: { kind: 'rebase-onto', flow: 'merge-main' },
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
