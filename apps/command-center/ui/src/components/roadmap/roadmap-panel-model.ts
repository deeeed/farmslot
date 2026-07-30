import type { PromotionDraft, RoadmapItem } from '@farmslot/protocol';
import {
  isConcreteRoadmapProject,
  isUnscopedGlobalRoadmapItem,
  parsePromotionDraftAttachment,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
  ROADMAP_ITEM_STAGES,
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
