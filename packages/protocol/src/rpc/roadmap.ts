import type { SafetyTier } from '../contracts/agents.js';
import type { BacklogItem } from '../contracts/backlog.js';
import type { OkResult } from '../contracts/common.js';
import type { RoadmapItem, RoadmapItemSaveInput, RoadmapItemStage } from '../contracts/roadmap.js';

import { Methods } from './registry.js';
import type { TmuxWorkerRef } from './tmux.js';

export const RoadmapMethods = {
  list: Methods.ROADMAP_LIST,
  get: Methods.ROADMAP_GET,
  save: Methods.ROADMAP_SAVE,
  delete: Methods.ROADMAP_DELETE,
  refine: Methods.ROADMAP_REFINE,
  refinementSessionGet: Methods.ROADMAP_REFINEMENT_SESSION_GET,
  promptGet: Methods.ROADMAP_PROMPT_GET,
  promotionDraftList: Methods.ROADMAP_PROMOTION_DRAFT_LIST,
  promotionDraftGet: Methods.ROADMAP_PROMOTION_DRAFT_GET,
  promotionDraftSave: Methods.ROADMAP_PROMOTION_DRAFT_SAVE,
  promote: Methods.ROADMAP_PROMOTE,
} as const;

export const DEFAULT_ROADMAP_REFINEMENT_RUNNER = 'codex';
export const DEFAULT_ROADMAP_REFINEMENT_MODEL = 'gpt-5.6-sol';

export interface RoadmapListParams {
  project?: string;
  stage?: RoadmapItemStage;
  tags?: string[];
  search?: string;
  includeArchived?: boolean;
}

export interface RoadmapListResult {
  items: RoadmapItem[];
}

export interface RoadmapGetParams {
  itemId: string;
}

export interface RoadmapGetResult {
  item: RoadmapItem;
}

export interface RoadmapSaveParams {
  item: RoadmapItemSaveInput;
  expectedHash?: string;
}

export interface RoadmapSaveResult {
  item: RoadmapItem;
}

export interface RoadmapDeleteParams {
  itemId: string;
  expectedHash?: string;
}
export type RoadmapDeleteResult = OkResult;

export interface RoadmapRefineParams {
  itemId: string;
  expectedHash?: string;
  /** Optional runner override for this refinement session. */
  runner?: string;
  /** Optional model override for this refinement session. */
  model?: string;
  /** Optional shell command template to run for refinement. Supports {{runner}}, {{model}}, {{prompt_path}}, and {{item_file}}. */
  runnerCommand?: string;
  /** Optional runner safety tier for the refinement launch. Defaults to sandboxed runner behavior. */
  safetyTier?: SafetyTier;
  /** Default false for API safety; true creates or attaches the tmux session. */
  launch?: boolean;
  /** Default true: move rough/refined items into refining when preparing the prompt. */
  markRefining?: boolean;
}

export interface RoadmapRefineResult {
  item: RoadmapItem;
  promptPath: string;
  tmuxSession: string;
  tmuxTarget: string;
  tmuxWorker?: TmuxWorkerRef;
  launched: boolean;
  /** True when launch attached to an already-running refinement session. */
  attachedExisting?: boolean;
  attachCommand: string;
  runner?: string;
  model?: string;
  runnerCommand?: string;
  safetyTier?: SafetyTier;
}

export interface RoadmapRefinementSessionGetParams {
  itemId: string;
}

export interface RoadmapRefinementSessionGetResult {
  itemId: string;
  tmuxSession: string;
  tmuxTarget: string;
  exists: boolean;
  tmuxWorker?: TmuxWorkerRef;
  attachCommand: string;
}

export interface RoadmapPromptGetParams {
  path: string;
}

export interface RoadmapPromptGetResult {
  path: string;
  absolutePath: string;
  content: string;
}

export interface RoadmapPromotionDraftListParams {
  itemId: string;
}

export interface RoadmapPromotionDraftSummary {
  path: string;
  filename: string;
  absolutePath: string;
  contentHash: string;
}

export interface RoadmapPromotionDraftListResult {
  drafts: RoadmapPromotionDraftSummary[];
}

export interface RoadmapPromotionDraftGetParams {
  path: string;
}

export interface RoadmapPromotionDraftGetResult extends RoadmapPromotionDraftSummary {
  content: string;
}

export interface RoadmapPromotionDraftSaveParams {
  path: string;
  content: string;
  expectedHash?: string;
}

export type RoadmapPromotionDraftSaveResult = RoadmapPromotionDraftGetResult;

export interface RoadmapPromoteSpecInput {
  project?: string;
  title: string;
  body: string;
  flowType?: BacklogItem['flowType'];
  tags?: string[];
  priority?: number;
  allowedSlots?: string[];
  autoDispatch?: boolean;
}

export interface RoadmapPromoteParams {
  itemId: string;
  expectedHash?: string;
  specs: RoadmapPromoteSpecInput[];
}

export interface RoadmapPromoteResult {
  roadmapItem: RoadmapItem;
  backlogItems: BacklogItem[];
  specPaths: string[];
}
