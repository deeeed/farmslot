import assert from 'node:assert/strict';
import test from 'node:test';

import type { RoadmapDeliverySummary, RoadmapItem } from '../src/contracts/roadmap.js';
import { roadmapDeliveryView } from '../src/roadmap/delivery-view.js';

function item(id: string, stage: RoadmapItem['stage'] = 'promoted'): RoadmapItem {
  return {
    id,
    kind: 'roadmap-item',
    project: 'project',
    title: id,
    stage,
    source: { kind: 'manual' },
    body: '',
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
    filePath: `.roadmap/${id}.md`,
    fileHash: id,
  };
}

test('delivered promoted work leaves planning while incomplete and unknown work stays visible', () => {
  const items = [
    item('shipped'),
    item('partial'),
    item('inconsistent'),
    item('unknown'),
    item('rough', 'rough'),
  ];
  const before = structuredClone(items);
  const view = roadmapDeliveryView(items, [
    { roadmapItemId: 'shipped', status: 'delivered' },
    { roadmapItemId: 'partial', status: 'partial' },
    { roadmapItemId: 'inconsistent', status: 'inconsistent' },
    { roadmapItemId: 'rough', status: 'delivered' },
  ]);
  assert.deepEqual(
    view.delivered.map((entry) => entry.id),
    ['shipped', 'rough'],
  );
  assert.deepEqual(
    view.undelivered.map((entry) => entry.id),
    ['partial', 'inconsistent', 'unknown'],
  );
  assert.deepEqual(items, before, 'grouping never rewrites planning stages or stored records');
  assert.equal(view.delivered[0], items[0]);
  assert.equal(view.statuses.get('unknown'), undefined);
});

test('delivery filters preserve input order and use only the projected status', () => {
  const items = [item('first'), item('second'), item('third')];
  const delivery = [
    { roadmapItemId: 'first', status: 'active', deliveredBacklogItemCount: 9, prCount: 9 },
    { roadmapItemId: 'second', status: 'delivered', deliveredBacklogItemCount: 0, prCount: 0 },
  ] as RoadmapDeliverySummary[];
  assert.deepEqual(roadmapDeliveryView(items, delivery).items, items);
  assert.deepEqual(roadmapDeliveryView(items, delivery, 'delivered').items, [items[1]]);
  assert.deepEqual(roadmapDeliveryView(items, delivery, 'undelivered').items, [items[0], items[2]]);
  assert.deepEqual(roadmapDeliveryView([], delivery).items, []);
});
