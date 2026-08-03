import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  RoadmapDeliveryProjection,
  RoadmapDeliverySummary,
  RoadmapItem,
} from '@farmslot/protocol';

import {
  inventoryShowsBackAffordance,
  inventoryShowsDetail,
  inventoryShowsList,
  nextSortState,
} from '../shared/work-inventory-table.js';

import {
  deliveryBadgeLabel,
  deliveryBadgeTone,
  deliverySummaryFor,
  roadmapDeliveryBacklinks,
  sortRoadmapItems,
} from './roadmap-panel-model.js';

function item(id: string, overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id,
    kind: 'roadmap-item',
    project: 'farmslot-farm',
    title: `Title ${id}`,
    stage: 'rough',
    source: { kind: 'manual' },
    body: 'body',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    filePath: `.roadmap/items/${id}.md`,
    fileHash: id,
    ...overrides,
  } as RoadmapItem;
}

/**
 * Rendered-selection contract for roadmap inventory (AC names roadmap-panel.test.ts).
 * Pure state machine mirroring roadmap-panel's layout + selection + sort wiring.
 */
function roadmapInventoryView(state: {
  selectedId: string;
  narrowViewport: boolean;
  forceList: boolean;
  sortKey: 'stage' | 'title' | 'updated';
  sortDirection: 'asc' | 'desc';
  items: RoadmapItem[];
}) {
  const sorted = sortRoadmapItems(state.items, state.sortKey, state.sortDirection);
  const selected = sorted.find((row) => row.id === state.selectedId) ?? null;
  const layout = {
    hasSelection: Boolean(selected),
    narrowViewport: state.narrowViewport,
    forceList: state.forceList,
  };
  return {
    sortedIds: sorted.map((row) => row.id),
    selectedId: selected?.id ?? '',
    showList: inventoryShowsList(layout),
    showDetail: inventoryShowsDetail(layout),
    showBack: inventoryShowsBackAffordance(layout),
    layoutMode:
      inventoryShowsList(layout) && inventoryShowsDetail(layout)
        ? 'split'
        : inventoryShowsDetail(layout)
          ? 'detail-only'
          : 'list-only',
  };
}

test('roadmap inventory selection opens detail while keeping list on wide layout', () => {
  const items = [item('ri_a', { title: 'Alpha' }), item('ri_b', { title: 'Beta' })];
  const view = roadmapInventoryView({
    selectedId: 'ri_b',
    narrowViewport: false,
    forceList: false,
    sortKey: 'title',
    sortDirection: 'asc',
    items,
  });
  assert.deepEqual(view.sortedIds, ['ri_a', 'ri_b']);
  assert.equal(view.selectedId, 'ri_b');
  assert.equal(view.layoutMode, 'split');
  assert.equal(view.showBack, false);
});

test('roadmap inventory narrow selection replaces list and Back restores list', () => {
  const items = [item('ri_a'), item('ri_b')];
  const selected = roadmapInventoryView({
    selectedId: 'ri_a',
    narrowViewport: true,
    forceList: false,
    sortKey: 'updated',
    sortDirection: 'desc',
    items,
  });
  assert.equal(selected.layoutMode, 'detail-only');
  assert.equal(selected.showList, false);
  assert.equal(selected.showDetail, true);
  assert.equal(selected.showBack, true);

  const afterBack = roadmapInventoryView({
    selectedId: 'ri_a',
    narrowViewport: true,
    forceList: true,
    sortKey: 'updated',
    sortDirection: 'desc',
    items,
  });
  assert.equal(afterBack.layoutMode, 'list-only');
  assert.equal(afterBack.showList, true);
  assert.equal(afterBack.showDetail, false);
  assert.equal(afterBack.showBack, false);
  // Selection identity is preserved across Back (canonical browsing state).
  assert.equal(afterBack.selectedId, 'ri_a');
});

test('roadmap inventory sort toggle preserves row identity for selection', () => {
  const items = [
    item('ri_z', { title: 'Zulu', stage: 'refined' }),
    item('ri_a', { title: 'Alpha', stage: 'rough' }),
  ];
  const sort = nextSortState(
    { key: 'title' as 'title' | 'stage' | 'updated', direction: 'asc' as const },
    'stage',
    (key) => (key === 'updated' ? 'desc' : 'asc'),
  );
  const view = roadmapInventoryView({
    selectedId: 'ri_z',
    narrowViewport: false,
    forceList: false,
    sortKey: sort.key as 'stage' | 'title' | 'updated',
    sortDirection: sort.direction,
    items,
  });
  assert.ok(view.sortedIds.includes('ri_z'));
  assert.equal(view.selectedId, 'ri_z');
});

/**
 * Regression fixture for MANUAL-000072: ri_790ea3508ba4 was manually backlinked
 * from MANUAL-000059, run 2e357072 completed and deeeed/farmslot#421 merged, but
 * the roadmap item still read as rough with no promotion entry.
 */
const DELIVERED_PROJECTION: RoadmapDeliveryProjection = {
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

test('roadmap list badge reads delivered for a manually backlinked item still staged rough', () => {
  const rough = item('ri_790ea3508ba4', { stage: 'rough', promotion: undefined });
  // No run-page cache is passed anywhere in this test: the badge must come from
  // the gateway projection alone.
  const summary = deliverySummaryFor('ri_790ea3508ba4', [], [DELIVERED_PROJECTION]);
  assert.ok(summary);
  assert.equal(deliveryBadgeLabel(summary), 'Delivery: delivered');
  assert.equal(deliveryBadgeTone(summary.status), 'positive');
  // Planning stage stays its own axis.
  assert.equal(rough.stage, 'rough');
  assert.equal(summary.deliveredBacklogItemCount, 1);
  assert.equal(summary.findingCount, 1);
});

test('roadmap detail renders clickable backlog, run, and PR backlinks from the projection', () => {
  const links = roadmapDeliveryBacklinks(DELIVERED_PROJECTION);

  const backlog = links.find((link) => link.kind === 'backlog')!;
  assert.equal(backlog.label, 'MANUAL-000059');
  // Delivered lineage is `done`/`archived`, which the Backlog panel's default
  // live-status filter excludes; without the pinned status the deep link lands and
  // then clears its own selection.
  assert.equal(backlog.href, '#backlog?item=bk_manual_000059&backlogStatus=done');
  assert.equal(backlog.external, false);

  const run = links.find((link) => link.kind === 'run')!;
  assert.equal(run.label, '2e357072');
  assert.equal(run.href, '#runs?family=2e357072-36f3-4586-91c4-8e5b6bf362fe');

  const pr = links.find((link) => link.kind === 'pr')!;
  assert.equal(pr.label, 'deeeed/farmslot#421');
  assert.equal(pr.href, 'https://github.com/deeeed/farmslot/pull/421');
  assert.equal(pr.external, true);

  // Every link target is reachable from the projection alone — the historical
  // run is outside any loaded run page and must still be linkable.
  assert.equal(links.length, 3);
});

test('unstarted roadmap item shows the not-started badge and no lineage links', () => {
  const unstarted: RoadmapDeliveryProjection = {
    roadmapItemId: 'ri_dev_unstarted',
    status: 'unstarted',
    backlogItems: [],
    runFamilies: [],
    prs: [],
    findings: [],
    generatedAt: '2026-08-01T00:00:00.000Z',
  };
  const summary = deliverySummaryFor('ri_dev_unstarted', [], [unstarted])!;
  assert.equal(deliveryBadgeLabel(summary), 'Delivery: not started');
  assert.equal(deliveryBadgeTone(summary.status), 'default');
  assert.deepEqual(roadmapDeliveryBacklinks(unstarted), []);
});

test('list badges fall back to roadmap.list summaries when no full projection is loaded', () => {
  const summaries: RoadmapDeliverySummary[] = [
    {
      roadmapItemId: 'ri_partial',
      status: 'partial',
      backlogItemCount: 2,
      deliveredBacklogItemCount: 1,
      runFamilyCount: 1,
      prCount: 1,
      findingCount: 0,
    },
  ];
  const summary = deliverySummaryFor('ri_partial', summaries, [])!;
  assert.equal(deliveryBadgeLabel(summary), 'Delivery: partial');
  assert.equal(deliveryBadgeTone(summary.status), 'active');
  assert.equal(deliverySummaryFor('ri_missing', summaries, []), null);
});

test('an archived-only run family is shown without a dead navigation link', () => {
  // `#runs` reads the live run map; archived runs are loaded only for this
  // projection, so linking there would promise navigation that dead-ends.
  const archived: RoadmapDeliveryProjection = {
    ...DELIVERED_PROJECTION,
    runFamilies: [{ ...DELIVERED_PROJECTION.runFamilies[0], archivedOnly: true }],
  };
  const run = roadmapDeliveryBacklinks(archived).find((link) => link.kind === 'run')!;
  assert.equal(run.href, '', 'no link rather than a link to nothing');
  assert.match(run.detail, /archived, not in the live run list/);

  // A live family keeps its link.
  const live = roadmapDeliveryBacklinks(DELIVERED_PROJECTION).find((l) => l.kind === 'run')!;
  assert.equal(live.href, '#runs?family=2e357072-36f3-4586-91c4-8e5b6bf362fe');
});
