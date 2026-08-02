import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlanningContextProjection, RoadmapDeliveryProjection } from '@farmslot/protocol';

import type { CommandContext } from '../context.js';

import {
  renderDeliveryLineage,
  renderPlanningContext,
  resolveRoadmapGetResult,
  resolveRoadmapItem,
} from './roadmap.js';

function ctxWith(
  items: Array<{ id: string; title?: string; stage?: string }>,
  getExact: boolean = true,
): CommandContext {
  return {
    client: {
      call: async (method: string, params: { itemId?: string }) => {
        if (method === 'roadmap.get') {
          const item = items.find((entry) => entry.id === params.itemId);
          if (item && getExact) return { item };
          throw new Error(`Roadmap item not found: ${params.itemId}`);
        }
        if (method === 'roadmap.list') return { items };
        throw new Error(`unexpected method ${method}`);
      },
    },
    output: {},
    target: {},
  } as unknown as CommandContext;
}

test('resolveRoadmapItem prefers exact roadmap.get id matches', async () => {
  const ctx = ctxWith([
    { id: 'ri_aaa111', title: 'A' },
    { id: 'ri_aaa222', title: 'B' },
  ]);
  assert.equal((await resolveRoadmapItem(ctx, 'ri_aaa222')).id, 'ri_aaa222');
});

test('resolveRoadmapItem accepts unique id prefixes via list fallback', async () => {
  const ctx = ctxWith(
    [
      { id: 'ri_aaa111', title: 'A' },
      { id: 'ri_bbb222', title: 'B' },
    ],
    false,
  );
  assert.equal((await resolveRoadmapItem(ctx, 'ri_bbb')).id, 'ri_bbb222');
});

test('resolveRoadmapItem rethrows non-not-found roadmap.get failures', async () => {
  const ctx = {
    client: {
      call: async () => {
        throw Object.assign(new Error('gateway unauthorized'), { code: 'AUTH' });
      },
    },
    output: {},
    target: {},
  } as unknown as CommandContext;
  await assert.rejects(
    () => resolveRoadmapItem(ctx, 'ri_anything'),
    (err: unknown) => /unauthorized/i.test((err as Error).message),
  );
});

test('resolveRoadmapItem rejects ambiguous id prefixes with a teach-the-escape error', async () => {
  const ctx = ctxWith(
    [
      { id: 'ri_aaa111', title: 'A' },
      { id: 'ri_aaa222', title: 'B' },
    ],
    false,
  );
  await assert.rejects(
    () => resolveRoadmapItem(ctx, 'ri_aaa'),
    (err: unknown) => {
      const rich = err as { code?: string; userAction?: string };
      assert.equal(rich.code, 'ROADMAP_ITEM_AMBIGUOUS');
      assert.ok(rich.userAction && rich.userAction.length > 0);
      return true;
    },
  );
  await assert.rejects(
    () => resolveRoadmapItem(ctx, 'ri_zzz'),
    (err: unknown) => (err as { code?: string }).code === 'ROADMAP_ITEM_NOT_FOUND',
  );
});

/**
 * Regression fixture for MANUAL-000072: ri_790ea3508ba4 → MANUAL-000059 →
 * run 2e357072 → deeeed/farmslot#421, delivered while still staged rough.
 */
const DELIVERY: RoadmapDeliveryProjection = {
  roadmapItemId: 'ri_790ea3508ba4',
  status: 'delivered',
  backlogItems: [
    {
      backlogItemId: 'bk_manual_000059',
      ref: 'MANUAL-000059',
      title: 'Roadmap delivery lineage',
      project: 'farmslot-farm',
      status: 'done',
      specPath: '.backlog/specs/manual-000059.md',
      archived: false,
      delivered: true,
      resolved: true,
      linkSource: 'backlog',
      runFamilies: [],
      prs: [],
    },
  ],
  runFamilies: [
    {
      familyId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
      runIds: ['2e357072-36f3-4586-91c4-8e5b6bf362fe'],
      latestRunId: '2e357072-36f3-4586-91c4-8e5b6bf362fe',
      latestStatus: 'done',
      latestUpdatedAt: '2026-08-01T00:00:00.000Z',
    },
  ],
  prs: [
    {
      ref: 'deeeed/farmslot#421',
      url: 'https://github.com/deeeed/farmslot/pull/421',
      sources: ['run-link', 'run-pr-number'],
    },
  ],
  findings: [
    {
      code: 'planning-stage-behind-delivery',
      detail: "Delivery is complete but the authored planning stage is still 'rough'.",
      remediation: "Edit ri_790ea3508ba4 to stage 'promoted' or 'archived'.",
    },
  ],
  generatedAt: '2026-08-01T00:00:00.000Z',
};

const PLANNING_CONTEXT: PlanningContextProjection = {
  backlogItemId: 'bk_manual_000059',
  roadmapItemId: 'ri_790ea3508ba4',
  relations: [
    {
      label: 'depends-on',
      direction: 'upstream',
      targetKind: 'backlog',
      targetId: 'bk_upstream',
      targetRef: 'MANUAL-000010',
      targetStatus: 'done',
      specPath: '.backlog/specs/manual-000010.md',
      source: 'work-graph-edge',
      schedulerAuthority: true,
      reason: 'WorkGraph edge edge_dep (merged, blocks start, status satisfied).',
    },
  ],
  generatedAt: '2026-08-01T00:00:00.000Z',
  snapshotHash: 'f00dcafef00dcafe',
};

test('human roadmap get prints implementation lineage from the shared projection', () => {
  const out = renderDeliveryLineage(DELIVERY);
  assert.match(out, /status: delivered/);
  assert.match(out, /MANUAL-000059/);
  assert.match(out, /\.backlog\/specs\/manual-000059\.md/);
  assert.match(out, /2e357072-36f3-4586-91c4-8e5b6bf362fe/);
  assert.match(out, /deeeed\/farmslot#421/);
  assert.match(out, /https:\/\/github\.com\/deeeed\/farmslot\/pull\/421/);
  assert.match(out, /planning-stage-behind-delivery/);

  const context = renderPlanningContext(PLANNING_CONTEXT);
  assert.match(context, /snapshot: f00dcafef00dcafe/);
  assert.match(context, /depends-on upstream MANUAL-000010 \(done\) \[scheduler authority\]/);
});

test('human roadmap get stays quiet when the gateway returned no projection', () => {
  assert.equal(renderDeliveryLineage(undefined), '');
  assert.equal(renderPlanningContext(undefined), '');
  assert.equal(
    renderPlanningContext({ ...PLANNING_CONTEXT, relations: [] }),
    '',
    'an empty relation set prints nothing rather than an empty heading',
  );
});

test('machine roadmap get returns the shared projection unchanged', async () => {
  const item = { id: 'ri_790ea3508ba4', stage: 'rough' };
  const ctx = {
    client: {
      call: async (method: string) => {
        if (method === 'roadmap.get') {
          return { item, delivery: DELIVERY, planningContext: PLANNING_CONTEXT };
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
    output: {},
    target: {},
  } as unknown as CommandContext;

  const result = await resolveRoadmapGetResult(ctx, 'ri_790ea3508ba4');
  // Byte-identical to what the gateway sent: no client-side re-derivation.
  assert.deepEqual(result.delivery, DELIVERY);
  assert.deepEqual(result.planningContext, PLANNING_CONTEXT);
});
