import type { BacklogStatus } from './backlog.js';
import type { RunStatus } from './runs.js';

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

/**
 * Delivery is a separate axis from {@link RoadmapItemStage}. Planning stage says how far
 * refinement got; delivery status says what actually shipped. `inconsistent` means the two
 * axes disagree in a way an operator must reconcile — never that delivery failed.
 */
export const ROADMAP_DELIVERY_STATUSES = [
  'unstarted',
  'active',
  'partial',
  'delivered',
  'inconsistent',
] as const;

export type RoadmapDeliveryStatus = (typeof ROADMAP_DELIVERY_STATUSES)[number];

/**
 * Which side of the relationship claims the link. `backlog` is the canonical live
 * relationship (`BacklogItem.roadmapItemId`); `promotion` is provenance recorded by
 * `roadmap.promote`; `both` means the two agree.
 */
export const ROADMAP_DELIVERY_LINK_SOURCES = ['backlog', 'promotion', 'both'] as const;
export type RoadmapDeliveryLinkSource = (typeof ROADMAP_DELIVERY_LINK_SOURCES)[number];

export const ROADMAP_DELIVERY_PR_SOURCES = [
  'run-link',
  'run-pr-number',
  'backlog-shipped',
] as const;
export type RoadmapDeliveryPrSource = (typeof ROADMAP_DELIVERY_PR_SOURCES)[number];

export interface RoadmapDeliveryPrRef {
  /** `owner/repo#number` when parseable, otherwise the raw persisted reference. */
  ref: string;
  url?: string;
  sources: RoadmapDeliveryPrSource[];
}

export interface RoadmapDeliveryRunRef {
  familyId: string;
  /** Every run id in the family that carried this backlog item, newest first. */
  runIds: string[];
  latestRunId: string;
  latestStatus: RunStatus;
  latestUpdatedAt: string;
}

export interface RoadmapDeliveryBacklogRef {
  backlogItemId: string;
  /** Present unless the link is a dangling promotion entry. */
  ref?: string;
  title?: string;
  project?: string;
  status?: BacklogStatus;
  specPath?: string;
  archived: boolean;
  /** Done, or closed out through `BacklogItem.shipped`. */
  delivered: boolean;
  /** False when a promotion entry points at a backlog item that no longer exists. */
  resolved: boolean;
  linkSource: RoadmapDeliveryLinkSource;
  runFamilies: RoadmapDeliveryRunRef[];
  prs: RoadmapDeliveryPrRef[];
  shippedAt?: string;
}

export const ROADMAP_DELIVERY_FINDING_CODES = [
  /** A promotion entry names a backlog item the backlog store does not have. */
  'promotion-backlog-missing',
  /** The linked backlog item's `roadmapItemId` points somewhere else. */
  'promotion-roadmap-mismatch',
  /** Canonical backlog link exists with no matching promotion provenance. */
  'backlog-link-not-in-promotion',
  /** Work shipped while the authored planning stage still implies unfinished discovery. */
  'planning-stage-behind-delivery',
] as const;

export type RoadmapDeliveryFindingCode = (typeof ROADMAP_DELIVERY_FINDING_CODES)[number];

export interface RoadmapDeliveryFinding {
  code: RoadmapDeliveryFindingCode;
  backlogItemId?: string;
  detail: string;
  /** Concrete operator instruction; the gateway never rewrites authored roadmap files. */
  remediation: string;
}

export interface RoadmapDeliveryProjection {
  roadmapItemId: string;
  status: RoadmapDeliveryStatus;
  backlogItems: RoadmapDeliveryBacklogRef[];
  /** Deduplicated union of every linked item's run families. */
  runFamilies: RoadmapDeliveryRunRef[];
  /** Deduplicated union of every linked item's PR references. */
  prs: RoadmapDeliveryPrRef[];
  findings: RoadmapDeliveryFinding[];
  generatedAt: string;
}

/** Aggregate shape carried on `roadmap.list` rows for badges and filters. */
export interface RoadmapDeliverySummary {
  roadmapItemId: string;
  status: RoadmapDeliveryStatus;
  backlogItemCount: number;
  deliveredBacklogItemCount: number;
  runFamilyCount: number;
  prCount: number;
  findingCount: number;
}

export function summarizeRoadmapDelivery(
  projection: RoadmapDeliveryProjection,
): RoadmapDeliverySummary {
  return {
    roadmapItemId: projection.roadmapItemId,
    status: projection.status,
    backlogItemCount: projection.backlogItems.length,
    deliveredBacklogItemCount: projection.backlogItems.filter((entry) => entry.delivered).length,
    runFamilyCount: projection.runFamilies.length,
    prCount: projection.prs.length,
    findingCount: projection.findings.length,
  };
}

/**
 * Typed planning relation labels. Only WorkGraph edges carry scheduler authority
 * (ADR-040); every other label is read-only context for humans and agents.
 *
 * The gateway currently derives `parent-roadmap` and `promoted-sibling` from roadmap
 * promotion, `depends-on` / `blocks` / `composes-with` / `follow-up` from WorkGraph edge
 * direction, `blocks` scope and unlock action, and `supersedes` from superseded run
 * families. `absorbs` is reserved for authored or imported relations; nothing derives it
 * yet, so a projection never emits it on its own.
 */
export const PLANNING_RELATION_LABELS = [
  'depends-on',
  'blocks',
  'supersedes',
  'absorbs',
  'composes-with',
  'follow-up',
  'parent-roadmap',
  'promoted-sibling',
] as const;

export type PlanningRelationLabel = (typeof PLANNING_RELATION_LABELS)[number];

export const PLANNING_RELATION_SOURCES = [
  'work-graph-edge',
  'work-graph-reference',
  'roadmap-promotion',
] as const;
export type PlanningRelationSource = (typeof PLANNING_RELATION_SOURCES)[number];

export interface PlanningRelation {
  label: PlanningRelationLabel;
  direction: 'upstream' | 'downstream' | 'sibling';
  targetKind: 'backlog' | 'roadmap' | 'reference';
  targetId: string;
  /** Operator-facing reference (backlog sourceRef, roadmap id, or WorkGraph reference ref). */
  targetRef?: string;
  targetTitle?: string;
  /** Backlog status, roadmap stage, or WorkGraph reference status. */
  targetStatus?: string;
  /** Spec/markdown path so agents can read the target instead of inlining it. */
  specPath?: string;
  targetUrl?: string;
  source: PlanningRelationSource;
  /**
   * True only for edges of an active WorkGraph. Context links never gate the
   * scheduler; the brief must say which is which.
   */
  schedulerAuthority: boolean;
  /** Why this relation exists — edge condition kind, or the promotion it came from. */
  reason: string;
}

/** Hard cap on rendered relations. Briefs are context, not a dependency dump. */
export const PLANNING_CONTEXT_MAX_RELATIONS = 24;

export interface PlanningContextTruncation {
  /** Relations dropped to stay within {@link PLANNING_CONTEXT_MAX_RELATIONS}. */
  omitted: number;
  /** Total before truncation, so a reader knows the shape of what was cut. */
  total: number;
}

export interface PlanningContextProjection {
  backlogItemId?: string;
  roadmapItemId?: string;
  roadmapTitle?: string;
  /** Repo-relative roadmap markdown path, when a roadmap parent is linked. */
  roadmapSpecPath?: string;
  roadmapStage?: RoadmapItemStage;
  workGraphId?: string;
  workNodeId?: string;
  delivery?: RoadmapDeliverySummary;
  relations: PlanningRelation[];
  /** Present only when relations were dropped; absent means the list is complete. */
  truncated?: PlanningContextTruncation;
  generatedAt: string;
  /**
   * Content hash over the projection excluding `generatedAt`. Worker and reviewer
   * briefs quote the same hash so a reviewer can detect changed prerequisites.
   */
  snapshotHash: string;
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
