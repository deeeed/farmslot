import type {
  PromotionDraft,
  RoadmapDeliveryProjection,
  RoadmapDeliveryStatus,
  RoadmapDeliverySummary,
  RoadmapItem,
} from '@farmslot/protocol';
import {
  isConcreteRoadmapProject,
  isUnscopedGlobalRoadmapItem,
  parsePromotionDraftAttachment,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
  ROADMAP_ITEM_STAGES,
  summarizeRoadmapDelivery,
} from '@farmslot/protocol';

export type RoadmapSortKey = 'stage' | 'project' | 'id' | 'title' | 'promotion' | 'updated';
export type RoadmapSortDirection = 'asc' | 'desc';

export type { PromotionDraft, PromotionDraftAttachment } from '@farmslot/protocol';
export {
  parsePromotionDraftAttachment,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
};

export function filterRoadmapItemsByGlobalProjects(
  items: RoadmapItem[],
  globalProjects: readonly string[],
): RoadmapItem[] {
  const projects = new Set(globalProjects);
  // Preserve identity for the common no-filter path so Lit does not receive a
  // new list solely because global filters were cleared.
  if (projects.size === 0) return items;

  return items.filter((item) => {
    const targets = item.targetProjects ?? [];
    // An unscoped global item coordinates across projects, so it remains visible
    // in concrete project views. `unassigned` means not scoped yet and stays hidden.
    return (
      projects.has(item.project) ||
      targets.some((project) => projects.has(project)) ||
      isUnscopedGlobalRoadmapItem(item)
    );
  });
}

export function sortRoadmapItems(
  items: readonly RoadmapItem[],
  key: RoadmapSortKey,
  direction: RoadmapSortDirection,
): RoadmapItem[] {
  const stageRank = new Map(ROADMAP_ITEM_STAGES.map((stage, index) => [stage, index]));
  const value = (item: RoadmapItem): string | number => {
    switch (key) {
      case 'stage':
        return stageRank.get(item.stage) ?? ROADMAP_ITEM_STAGES.length;
      case 'project':
        return item.project;
      case 'id':
        return item.id;
      case 'title':
        return item.title;
      case 'promotion':
        return item.promotion?.length ?? 0;
      case 'updated':
        return item.updatedAt;
    }
  };
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    const compared =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    return compared * multiplier || a.id.localeCompare(b.id);
  });
}

export function defaultSpecBody(item: RoadmapItem | null): string {
  return [
    '## Context',
    '',
    item?.body?.trim() || 'Promoted from roadmap item.',
    '',
    '## Acceptance Criteria',
    '',
    '- ',
    '',
    '## Dispatch Notes',
    '',
    'Dispatch through the existing backlog queue.',
  ].join('\n');
}

export function promotionDraftsFromRoadmapItem(item: RoadmapItem): PromotionDraft[] {
  const parsed = parsePromotionDraftsFromRoadmapBody(item.body);
  if (parsed.length) return parsed;

  const targets = item.targetProjects ?? [];
  const projects =
    targets.length > 0 ? targets : isConcreteRoadmapProject(item.project) ? [item.project] : [''];
  return projects.map((project) => ({
    project,
    title: item.title,
    body: defaultSpecBody(item),
  }));
}

// ─── Delivery lineage (gateway-derived) ───
//
// Every value below comes from the shared `RoadmapDeliveryProjection` the gateway
// builds from the full backlog and run stores. The panel must not re-join the
// loaded run page: a run outside that page would silently disappear.

const DELIVERY_STATUS_COPY: Record<RoadmapDeliveryStatus, string> = {
  unstarted: 'not started',
  active: 'in progress',
  partial: 'partial',
  delivered: 'delivered',
  inconsistent: 'inconsistent',
};

/** Wording keeps the delivery axis distinct from the planning stage badge. */
export function deliveryBadgeLabel(summary: RoadmapDeliverySummary): string {
  return `Delivery: ${DELIVERY_STATUS_COPY[summary.status]}`;
}

export function deliveryBadgeTone(
  status: RoadmapDeliveryStatus,
): 'default' | 'positive' | 'danger' | 'active' {
  if (status === 'inconsistent') return 'danger';
  if (status === 'delivered') return 'positive';
  if (status === 'active' || status === 'partial') return 'active';
  return 'default';
}

export function deliverySummaryFor(
  itemId: string,
  summaries: readonly RoadmapDeliverySummary[],
  projections: readonly RoadmapDeliveryProjection[],
): RoadmapDeliverySummary | null {
  const projection = projections.find((entry) => entry.roadmapItemId === itemId);
  if (projection) return summarizeRoadmapDelivery(projection);
  return summaries.find((entry) => entry.roadmapItemId === itemId) ?? null;
}

export interface RoadmapDeliveryBacklink {
  kind: 'backlog' | 'run' | 'pr';
  label: string;
  detail: string;
  href: string;
  external: boolean;
  testId: string;
}

/**
 * Clickable lineage targets derived entirely from the projection: backlog item,
 * run family, and merged PR. No run-page cache lookup, so historical runs stay
 * reachable.
 */
export function roadmapDeliveryBacklinks(
  projection: RoadmapDeliveryProjection,
): RoadmapDeliveryBacklink[] {
  const links: RoadmapDeliveryBacklink[] = [];
  for (const entry of projection.backlogItems) {
    links.push({
      kind: 'backlog',
      label: entry.ref ?? entry.backlogItemId,
      detail: entry.resolved
        ? `${entry.title ?? 'untitled'} · ${entry.status ?? 'unknown'}${entry.archived ? ' · archived' : ''}`
        : 'missing backlog item (stale promotion entry)',
      // Delivered lineage is normally `done` or `archived`, which the Backlog
      // panel's default live-status filter excludes — the deep link would land and
      // then clear its own selection. Pin the status so the item is filtered in.
      href: `#backlog?item=${encodeURIComponent(entry.backlogItemId)}${
        entry.status ? `&backlogStatus=${encodeURIComponent(entry.status)}` : ''
      }`,
      external: false,
      testId: 'roadmap-delivery-backlog-link',
    });
  }
  for (const family of projection.runFamilies) {
    // An archived-only family is not reachable through `#runs`, which reads the live
    // run map. Rendering a link there would promise navigation that dead-ends, so
    // archived evidence is shown without one.
    const reachable = !family.archivedOnly;
    links.push({
      kind: 'run',
      label: family.latestRunId.slice(0, 8),
      detail: `${family.latestStatus} · ${family.runIds.length} run${family.runIds.length === 1 ? '' : 's'} in family${
        reachable ? '' : ' · archived, not in the live run list'
      }`,
      href: reachable ? `#runs?family=${encodeURIComponent(family.familyId)}` : '',
      external: false,
      testId: 'roadmap-delivery-run-link',
    });
  }
  for (const pr of projection.prs) {
    links.push({
      kind: 'pr',
      label: pr.ref,
      detail: pr.sources.join(', '),
      href: pr.url ?? '',
      external: true,
      testId: 'roadmap-delivery-pr-link',
    });
  }
  return links;
}
