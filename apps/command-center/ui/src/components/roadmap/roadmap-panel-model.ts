import type { PromotionDraft, RoadmapItem } from '@farmslot/protocol';
import {
  parsePromotionDraftAttachment,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
} from '@farmslot/protocol';

export type { PromotionDraft, PromotionDraftAttachment } from '@farmslot/protocol';
export {
  parsePromotionDraftAttachment,
  parsePromotionDraftsFromRoadmapBody,
  promotionDraftAttachment,
};

function concreteProject(project: string): boolean {
  return project !== 'global' && project !== 'unassigned';
}

export function filterRoadmapItemsByGlobalProjects(
  items: RoadmapItem[],
  globalProjects: readonly string[],
): RoadmapItem[] {
  const projects = new Set(globalProjects);
  if (projects.size === 0) return items;

  return items.filter((item) => {
    const targets = item.targetProjects ?? [];
    return (
      projects.has(item.project) ||
      targets.some((project) => projects.has(project)) ||
      (item.project === 'global' && targets.length === 0)
    );
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
    targets.length > 0 ? targets : concreteProject(item.project) ? [item.project] : [''];
  return projects.map((project) => ({
    project,
    title: item.title,
    body: defaultSpecBody(item),
  }));
}
