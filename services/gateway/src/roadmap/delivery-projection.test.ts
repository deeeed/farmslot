import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  BacklogItem,
  RoadmapItem,
  Run,
  WorkEdge,
  WorkGraphSnapshot,
  WorkNode,
} from '@farmslot/protocol';

import {
  buildPlanningContextProjection,
  buildRoadmapDeliveryProjection,
  buildRunIndexByBacklogItem,
} from './delivery-projection.js';

const NOW = '2026-08-02T10:00:00.000Z';

function backlogItem(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    project: 'farmslot-farm',
    title: `Backlog ${id}`,
    sourceKind: 'manual',
    sourceRef: id.toUpperCase(),
    flowType: 'dev',
    status: 'ready',
    priority: 50,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    familyId: id,
    lane: 'production',
    flowType: 'dev',
    status: 'done',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {} as Run['metrics'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function roadmapItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: 'ri_test',
    kind: 'roadmap-item',
    project: 'farmslot-farm',
    title: 'Roadmap item',
    stage: 'rough',
    source: { kind: 'manual' },
    body: '',
    createdAt: NOW,
    updatedAt: NOW,
    filePath: '.roadmap/inbox/items/roadmap-item.md',
    fileHash: 'hash',
    ...overrides,
  };
}

function project(input: { item: RoadmapItem; backlogItems: BacklogItem[]; runs?: Run[] }) {
  return buildRoadmapDeliveryProjection({
    item: input.item,
    backlogItems: input.backlogItems,
    runsByBacklogItemId: buildRunIndexByBacklogItem(input.runs ?? []),
    generatedAt: NOW,
  });
}

test('canonical backlog link without promotion provenance is included with an explicit finding', () => {
  const item = roadmapItem({ id: 'ri_manual', stage: 'rough' });
  const linked = backlogItem('bk_manual', { roadmapItemId: 'ri_manual', status: 'running' });

  const projection = project({ item, backlogItems: [linked] });

  assert.deepEqual(
    projection.backlogItems.map((entry) => entry.backlogItemId),
    ['bk_manual'],
  );
  assert.equal(projection.backlogItems[0].linkSource, 'backlog');
  const finding = projection.findings.find(
    (entry) => entry.code === 'backlog-link-not-in-promotion',
  );
  assert.ok(finding, 'expected a provenance-mismatch finding for the manual backlink');
  assert.equal(finding.backlogItemId, 'bk_manual');
  assert.match(finding.remediation, /canonical/);
  // A missing promotion record is a provenance gap, not untrustworthy lineage.
  assert.equal(projection.status, 'active');
});

test('promotion entries and canonical links union without duplicates; broken refs stay findings', () => {
  const item = roadmapItem({
    id: 'ri_union',
    stage: 'promoted',
    promotion: [
      { backlogItemId: 'bk_both', createdAt: NOW },
      { backlogItemId: 'bk_gone', createdAt: NOW },
      { backlogItemId: 'bk_moved', createdAt: NOW },
    ],
  });
  const items = [
    backlogItem('bk_both', { roadmapItemId: 'ri_union' }),
    backlogItem('bk_moved', { roadmapItemId: 'ri_other' }),
    backlogItem('bk_only_backlog', { roadmapItemId: 'ri_union' }),
  ];

  const projection = project({ item, backlogItems: items });

  assert.deepEqual(projection.backlogItems.map((entry) => entry.backlogItemId).sort(), [
    'bk_both',
    'bk_gone',
    'bk_moved',
    'bk_only_backlog',
  ]);
  assert.equal(
    projection.backlogItems.find((entry) => entry.backlogItemId === 'bk_both')?.linkSource,
    'both',
  );
  assert.equal(
    projection.backlogItems.find((entry) => entry.backlogItemId === 'bk_gone')?.resolved,
    false,
  );
  assert.deepEqual(projection.findings.map((entry) => entry.code).sort(), [
    'backlog-link-not-in-promotion',
    'promotion-backlog-missing',
    'promotion-roadmap-mismatch',
  ]);
  // Broken provenance is reported, never thrown: roadmap.get still answers.
  assert.equal(projection.status, 'inconsistent');
});

test('delivery is partial until every linked non-archived item is done or shipped', () => {
  const item = roadmapItem({ id: 'ri_multi', stage: 'promoted' });
  const first = backlogItem('bk_one', { roadmapItemId: 'ri_multi', status: 'done' });
  const second = backlogItem('bk_two', { roadmapItemId: 'ri_multi', status: 'running' });
  const archived = backlogItem('bk_archived', {
    roadmapItemId: 'ri_multi',
    status: 'archived',
  });

  const partial = project({ item, backlogItems: [first, second, archived] });
  assert.equal(partial.status, 'partial');

  const shipped: BacklogItem = {
    ...second,
    status: 'needs-attention',
    shipped: { prRef: 'deeeed/farmslot#900', closedAt: NOW },
  };
  const delivered = project({ item, backlogItems: [first, shipped, archived] });
  assert.equal(delivered.status, 'delivered');
  // Planning stage never participates in the delivery decision.
  const roughStage = project({
    item: roadmapItem({ id: 'ri_multi', stage: 'rough' }),
    backlogItems: [first, shipped, archived],
  });
  assert.equal(roughStage.status, 'delivered');
  assert.ok(
    roughStage.findings.some((entry) => entry.code === 'planning-stage-behind-delivery'),
    'a delivered item still in discovery must report a reconcile finding',
  );
  assert.equal(
    delivered.findings.some((entry) => entry.code === 'planning-stage-behind-delivery'),
    false,
    'stage promoted is already reconciled',
  );
});

test('historical run and PR evidence survives outside the default run page and dedupes', () => {
  const item = roadmapItem({ id: 'ri_history', stage: 'promoted' });
  const linked = backlogItem('bk_history', {
    roadmapItemId: 'ri_history',
    status: 'done',
    shipped: { prRef: 'deeeed/farmslot#421', closedAt: NOW },
  });
  // Two attempts in one family plus a retry family; none of them would be in a
  // default `run.list` page, and all three must still be projected.
  const runs = [
    run('run_old', {
      familyId: 'fam_a',
      backlogItemId: 'bk_history',
      updatedAt: '2026-07-01T00:00:00.000Z',
      status: 'failed',
    }),
    run('run_new', {
      familyId: 'fam_a',
      backlogItemId: 'bk_history',
      updatedAt: '2026-07-02T00:00:00.000Z',
      prNumber: 421,
      links: [{ label: 'PR', url: 'https://github.com/deeeed/farmslot/pull/421' }],
    }),
    run('run_retry', {
      familyId: 'fam_b',
      backlogItemId: 'bk_history',
      updatedAt: '2026-07-03T00:00:00.000Z',
      links: [{ label: 'PR', url: 'https://github.com/deeeed/farmslot/pull/421' }],
    }),
  ];

  const projection = project({ item, backlogItems: [linked], runs });

  assert.deepEqual(
    projection.runFamilies.map((family) => family.familyId),
    ['fam_b', 'fam_a'],
  );
  const familyA = projection.runFamilies.find((family) => family.familyId === 'fam_a')!;
  assert.deepEqual(familyA.runIds, ['run_new', 'run_old']);
  assert.equal(familyA.latestRunId, 'run_new');
  assert.equal(familyA.latestStatus, 'done');

  assert.deepEqual(
    projection.prs.map((pr) => pr.ref),
    ['deeeed/farmslot#421'],
  );
  assert.deepEqual(projection.prs[0].sources.sort(), [
    'backlog-shipped',
    'run-link',
    'run-pr-number',
  ]);
  assert.equal(projection.prs[0].url, 'https://github.com/deeeed/farmslot/pull/421');
});

test('ri_790ea3508ba4 regression: manual backlink to MANUAL-000059 reads delivered', () => {
  // Regression fixture for the reported drift: the backlog item carried the
  // roadmapItemId, run 2e357072 completed and deeeed/farmslot#421 merged, but
  // the roadmap item had no promotion entry and still looked rough.
  const item = roadmapItem({
    id: 'ri_790ea3508ba4',
    stage: 'rough',
    title: 'Roadmap delivery lineage',
  });
  const linked = backlogItem('bk_manual_000059', {
    roadmapItemId: 'ri_790ea3508ba4',
    sourceRef: 'MANUAL-000059',
    status: 'done',
    specPath: '.backlog/specs/manual-000059.md',
  });
  const historical = run('2e357072-36f3-4586-91c4-8e5b6bf362fe', {
    familyId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
    backlogItemId: 'bk_manual_000059',
    ticketOrPr: 'MANUAL-000059',
    prNumber: 421,
    links: [{ label: 'PR', url: 'https://github.com/deeeed/farmslot/pull/421' }],
  });

  const projection = project({ item, backlogItems: [linked], runs: [historical] });

  assert.equal(projection.status, 'delivered');
  assert.equal(projection.backlogItems[0].ref, 'MANUAL-000059');
  assert.equal(projection.backlogItems[0].linkSource, 'backlog');
  assert.equal(projection.runFamilies[0].latestRunId, '2e357072-36f3-4586-91c4-8e5b6bf362fe');
  assert.deepEqual(
    projection.prs.map((pr) => pr.ref),
    ['deeeed/farmslot#421'],
  );
  const stageFinding = projection.findings.find(
    (entry) => entry.code === 'planning-stage-behind-delivery',
  );
  assert.ok(stageFinding, 'delivered work with a rough stage must surface the inconsistency');
  assert.match(stageFinding.remediation, /archived/);
});

// ─── Planning context ───

function workNode(id: string, overrides: Partial<WorkNode> = {}): WorkNode {
  return {
    id,
    graphId: 'wg_test',
    kind: 'backlog',
    status: 'planned',
    waitingOn: [],
    updatedAt: NOW,
    ...overrides,
  };
}

function workEdge(
  id: string,
  from: string,
  to: string,
  overrides: Partial<WorkEdge> = {},
): WorkEdge {
  return {
    id,
    graphId: 'wg_test',
    fromNodeId: from,
    toNodeId: to,
    condition: { kind: 'merged' },
    required: true,
    status: 'pending',
    unlock: { kind: 'enqueue' },
    ...overrides,
  };
}

test('planning context labels WorkGraph relations and marks scheduler authority', () => {
  const upstream = backlogItem('bk_upstream', {
    sourceRef: 'MANUAL-000010',
    status: 'done',
    specPath: '.backlog/specs/manual-000010.md',
  });
  const target = backlogItem('bk_target', {
    sourceRef: 'MANUAL-000011',
    roadmapItemId: 'ri_ctx',
    specPath: '.backlog/specs/manual-000011.md',
    workGraphId: 'wg_test',
    workNodeId: 'node_target',
  });
  const graph: WorkGraphSnapshot = {
    graph: {
      id: 'wg_test',
      version: 1,
      project: 'farmslot-farm',
      title: 'Delivery graph',
      source: { kind: 'manual' },
      status: 'active',
      defaultFailurePolicy: 'halt',
      scheduler: {},
      createdAt: NOW,
      updatedAt: NOW,
    },
    nodes: [
      workNode('node_upstream', { backlogItemId: 'bk_upstream', status: 'succeeded' }),
      workNode('node_target', { backlogItemId: 'bk_target', status: 'ready' }),
      workNode('node_ref', {
        kind: 'reference',
        reference: {
          kind: 'github-pr',
          title: 'Upstream protocol release',
          ref: 'deeeed/farmslot#421',
          status: 'satisfied',
          url: 'https://github.com/deeeed/farmslot/pull/421',
        },
      }),
    ],
    edges: [
      workEdge('edge_dep', 'node_upstream', 'node_target'),
      workEdge('edge_ref', 'node_ref', 'node_target', {
        condition: { kind: 'reference-status', status: 'satisfied' },
      }),
    ],
    gates: [],
    ledger: [],
  };
  const roadmap = roadmapItem({ id: 'ri_ctx', title: 'Parent roadmap item', stage: 'promoted' });
  const sibling = backlogItem('bk_sibling', {
    sourceRef: 'MANUAL-000012',
    roadmapItemId: 'ri_ctx',
    specPath: '.backlog/specs/manual-000012.md',
  });

  const context = buildPlanningContextProjection({
    backlogItem: target,
    roadmapItem: roadmap,
    backlogItems: [upstream, target, sibling],
    graph,
    generatedAt: NOW,
  });

  const byLabel = new Map(context.relations.map((relation) => [relation.label, relation]));

  const parent = byLabel.get('parent-roadmap')!;
  assert.equal(parent.targetKind, 'roadmap');
  assert.equal(parent.specPath, '.roadmap/inbox/items/roadmap-item.md');
  assert.equal(parent.targetStatus, 'promoted');
  assert.equal(parent.schedulerAuthority, false);

  const siblingRelation = byLabel.get('promoted-sibling')!;
  assert.equal(siblingRelation.targetRef, 'MANUAL-000012');
  assert.equal(siblingRelation.specPath, '.backlog/specs/manual-000012.md');
  assert.equal(siblingRelation.schedulerAuthority, false);

  const dependency = context.relations.find(
    (relation) => relation.label === 'depends-on' && relation.targetKind === 'backlog',
  )!;
  assert.equal(dependency.direction, 'upstream');
  assert.equal(dependency.targetRef, 'MANUAL-000010');
  assert.equal(dependency.targetStatus, 'done');
  assert.equal(dependency.specPath, '.backlog/specs/manual-000010.md');
  assert.equal(dependency.source, 'work-graph-edge');
  assert.equal(dependency.schedulerAuthority, true, 'active graph edges gate the scheduler');

  const reference = context.relations.find((relation) => relation.targetKind === 'reference')!;
  assert.equal(reference.targetRef, 'deeeed/farmslot#421');
  assert.equal(reference.targetStatus, 'satisfied');
  assert.equal(reference.targetUrl, 'https://github.com/deeeed/farmslot/pull/421');
  assert.equal(reference.source, 'work-graph-reference');

  assert.equal(context.workGraphId, 'wg_test');
  assert.equal(context.workNodeId, 'node_target');
  assert.equal(context.roadmapItemId, 'ri_ctx');
  assert.equal(context.snapshotHash.length, 16);
});

test('paused WorkGraph edges are context only and never claim scheduler authority', () => {
  const target = backlogItem('bk_target', { workGraphId: 'wg_test', workNodeId: 'node_target' });
  const upstream = backlogItem('bk_upstream');
  const graph: WorkGraphSnapshot = {
    graph: {
      id: 'wg_test',
      version: 1,
      project: 'farmslot-farm',
      title: 'Paused graph',
      source: { kind: 'manual' },
      status: 'paused',
      defaultFailurePolicy: 'halt',
      scheduler: {},
      createdAt: NOW,
      updatedAt: NOW,
    },
    nodes: [
      workNode('node_upstream', { backlogItemId: 'bk_upstream' }),
      workNode('node_target', { backlogItemId: 'bk_target' }),
    ],
    edges: [workEdge('edge_dep', 'node_upstream', 'node_target')],
    gates: [],
    ledger: [],
  };

  const context = buildPlanningContextProjection({
    backlogItem: target,
    backlogItems: [upstream, target],
    graph,
    generatedAt: NOW,
  });

  assert.equal(context.relations.length, 1);
  assert.equal(context.relations[0].schedulerAuthority, false);
});

test('planning context snapshot hash ignores generatedAt so briefs can be compared', () => {
  const target = backlogItem('bk_target', { roadmapItemId: 'ri_ctx' });
  const roadmap = roadmapItem({ id: 'ri_ctx' });
  const first = buildPlanningContextProjection({
    backlogItem: target,
    roadmapItem: roadmap,
    backlogItems: [target],
    generatedAt: '2026-08-02T10:00:00.000Z',
  });
  const later = buildPlanningContextProjection({
    backlogItem: target,
    roadmapItem: roadmap,
    backlogItems: [target],
    generatedAt: '2026-08-02T18:30:00.000Z',
  });
  assert.equal(first.snapshotHash, later.snapshotHash);

  const changed = buildPlanningContextProjection({
    backlogItem: target,
    roadmapItem: roadmap,
    backlogItems: [target, backlogItem('bk_new', { roadmapItemId: 'ri_ctx' })],
    generatedAt: '2026-08-02T10:00:00.000Z',
  });
  assert.notEqual(first.snapshotHash, changed.snapshotHash);
});

test('standalone backlog item without roadmap or graph has no relations', () => {
  const context = buildPlanningContextProjection({
    backlogItem: backlogItem('bk_standalone'),
    backlogItems: [backlogItem('bk_standalone')],
    generatedAt: NOW,
  });
  assert.deepEqual(context.relations, []);
  assert.equal(context.roadmapItemId, undefined);
  assert.equal(context.workGraphId, undefined);
});
