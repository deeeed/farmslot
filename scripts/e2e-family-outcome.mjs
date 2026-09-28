// Prove family and work-graph outcome agreement through the real gateway.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
assert.equal(process.env.FARMSLOT_VALIDATION_ROOT, root);
assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:8001');
assert.notEqual(
  execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  'main',
);
const fixture = path.join(root, 'temp/family-outcome-proof.json');
const rpc = (method, params) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { encoding: 'utf8' },
    ),
  );
if (process.argv.includes('--seed')) {
  const cases = [];
  for (const [name, outcome, siblingStatus, expectedEdge, expectedFamily] of [
    ['partial-only', 'partial', null, 'failed', 'failed'],
    ['partial-then-success', 'partial', 'done', 'satisfied', 'complete'],
    ['failure-then-success', 'failure', 'done', 'satisfied', 'complete'],
    ['active-sibling', 'success', 'monitoring', 'pending', 'active'],
  ]) {
    const graphId = rpc('workGraph.create', {
      project: 'farmslot-farm',
      title: `Disposable family outcome ${name}`,
    }).graph.graph.id;
    for (const id of ['producer', 'consumer']) {
      const item = rpc('backlog.create', {
        project: 'farmslot-farm',
        title: `Disposable ${name} ${id}`,
        sourceKind: 'manual',
        flowType: 'dev',
        status: 'ready',
        autoDispatch: false,
      }).item;
      rpc('workGraph.addNode', { graphId, id, backlogItemId: item.id });
    }
    rpc('workGraph.addEdge', {
      graphId,
      id: 'family',
      fromNodeId: 'producer',
      toNodeId: 'consumer',
      condition: { kind: 'family-done' },
    });
    const familyId = randomUUID();
    const run = {
      id: familyId,
      familyId,
      parentRunId: null,
      familyRootTicketOrPr: name,
      createdByPrincipalId: 'legacy-env',
      lane: 'production',
      flowType: 'dev',
      mode: 'autonomous',
      status: 'done',
      project: 'farmslot-farm',
      ticketOrPr: name,
      slotId: null,
      taskFile: null,
      branch: null,
      steps: [],
      decisions: [],
      metrics: { nudgeCount: 0, model: null, runner: null, outcome },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:00:00.000Z',
      workGraphId: graphId,
      workNodeId: 'producer',
    };
    const runsDir = path.join(root, 'temp/results-validation/runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(path.join(runsDir, `${run.id}.json`), JSON.stringify(run));
    if (siblingStatus) {
      const id = randomUUID();
      const sibling = {
        ...run,
        id,
        parentRunId: run.id,
        status: siblingStatus,
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        completedAt: siblingStatus === 'done' ? '2026-09-02T00:00:00.000Z' : undefined,
        metrics: { ...run.metrics, outcome: siblingStatus === 'done' ? 'success' : undefined },
      };
      await writeFile(path.join(runsDir, `${id}.json`), JSON.stringify(sibling));
    }
    cases.push({ name, graphId, familyId, expectedEdge, expectedFamily });
  }
  await writeFile(fixture, JSON.stringify(cases));
  console.log(JSON.stringify({ seeded: cases.length, restartIsolatedGateway: true }));
} else {
  const cases = JSON.parse(await readFile(fixture, 'utf8'));
  const results = [];
  for (const scenario of cases) {
    rpc('workGraph.schedulerTick', { graphId: scenario.graphId });
    const graph = rpc('workGraph.get', { graphId: scenario.graphId }).graph;
    assert.ok(
      graph.nodes.every((node) => node.status !== 'dispatched'),
      'Validation must not dispatch workers',
    );
    const edge = graph.edges.find((edge) => edge.id === 'family');
    const family = rpc('family.observability.get', { familyId: scenario.familyId }).snapshot;
    assert.equal(edge.status, scenario.expectedEdge, scenario.name);
    assert.equal(family.workflowState, scenario.expectedFamily, scenario.name);
    assert.ok(
      !rpc('dispatch.queue.list', {}).items.some((item) => item.workGraphId === scenario.graphId),
      'Fixture policy must prevent enqueueing',
    );
    results.push({ name: scenario.name, edge: edge.status, family: family.workflowState });
    rpc('workGraph.pause', { graphId: scenario.graphId });
  }
  console.log(JSON.stringify({ pass: true, gatewayDerivation: results }));
}
