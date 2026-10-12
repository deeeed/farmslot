import type {
  RoadmapDeliveryStatus,
  RoadmapDeliverySummary,
  RoadmapItem,
} from '../contracts/roadmap.js';

export const ROADMAP_DELIVERY_FILTERS = ['all', 'undelivered', 'delivered'] as const;
export type RoadmapDeliveryFilter = (typeof ROADMAP_DELIVERY_FILTERS)[number];

export interface RoadmapDeliveryView {
  items: RoadmapItem[];
  undelivered: RoadmapItem[];
  delivered: RoadmapItem[];
  statuses: ReadonlyMap<string, RoadmapDeliveryStatus>;
}

/** Presentation only: the gateway projection owns delivery, never the planning stage. */
export function roadmapDeliveryView(
  items: readonly RoadmapItem[],
  delivery: readonly Pick<RoadmapDeliverySummary, 'roadmapItemId' | 'status'>[],
  filter: RoadmapDeliveryFilter = 'all',
): RoadmapDeliveryView {
  const statuses = new Map(delivery.map((entry) => [entry.roadmapItemId, entry.status]));
  const view: RoadmapDeliveryView = { items: [], undelivered: [], delivered: [], statuses };
  for (const item of items) {
    const delivered = statuses.get(item.id) === 'delivered';
    if ((filter === 'delivered' && !delivered) || (filter === 'undelivered' && delivered)) continue;
    view.items.push(item);
    (delivered ? view.delivered : view.undelivered).push(item);
  }
  return view;
}
