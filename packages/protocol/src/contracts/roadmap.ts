export const ROADMAP_ITEM_STAGES = [
  'rough',
  'refining',
  'refined',
  'promoted',
  'parked',
  'archived',
] as const;

export type RoadmapItemStage = (typeof ROADMAP_ITEM_STAGES)[number];

export const ROADMAP_SOURCE_KINDS = ['manual', 'import', 'agent', 'external'] as const;
export type RoadmapSourceKind = (typeof ROADMAP_SOURCE_KINDS)[number];

export const ROADMAP_GLOBAL_PROJECT = 'global';
export const ROADMAP_UNASSIGNED_PROJECT = 'unassigned';

export function isConcreteRoadmapProject(project: string): boolean {
  const normalized = project.trim();
  return (
    Boolean(normalized) &&
    normalized !== ROADMAP_GLOBAL_PROJECT &&
    normalized !== ROADMAP_UNASSIGNED_PROJECT
  );
}

export interface RoadmapSource {
  kind: RoadmapSourceKind;
  ref?: string;
  path?: string;
  url?: string;
}

export interface RoadmapPromotionEntry {
  backlogItemId?: string;
  specPath?: string;
  project?: string;
  createdAt: string;
}

export interface RoadmapItem {
  id: string;
  kind: 'roadmap-item';
  project: string;
  targetProjects?: string[];
  title: string;
  stage: RoadmapItemStage;
  tags?: string[];
  source: RoadmapSource;
  body: string;
  promotion?: RoadmapPromotionEntry[];
  createdAt: string;
  updatedAt: string;
  /** Repo-relative markdown file path under .roadmap. */
  filePath: string;
  /** Latest repo-relative refinement prompt path generated for this item, when present. */
  refinementPromptPath?: string;
  /** SHA-256 of the current markdown file, used for edit conflict checks. */
  fileHash: string;
}

export function isUnscopedGlobalRoadmapItem(
  item: Pick<RoadmapItem, 'project' | 'targetProjects'>,
): boolean {
  return item.project === ROADMAP_GLOBAL_PROJECT && (item.targetProjects ?? []).length === 0;
}

export interface RoadmapItemSaveInput {
  id?: string;
  project?: string;
  targetProjects?: string[];
  title: string;
  stage?: RoadmapItemStage;
  tags?: string[];
  source?: RoadmapSource;
  body?: string;
  promotion?: RoadmapPromotionEntry[];
  filePath?: string;
  fileHash?: string;
}
