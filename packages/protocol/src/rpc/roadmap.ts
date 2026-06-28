import type { BacklogItem } from '../contracts/backlog.js';
import type { OkResult } from '../contracts/common.js';
import type { RoadmapItem, RoadmapItemSaveInput, RoadmapItemStage } from '../contracts/roadmap.js';

import { Methods } from './registry.js';

export const RoadmapMethods = {
  list: Methods.ROADMAP_LIST,
  get: Methods.ROADMAP_GET,
  save: Methods.ROADMAP_SAVE,
  delete: Methods.ROADMAP_DELETE,
  refine: Methods.ROADMAP_REFINE,
  promote: Methods.ROADMAP_PROMOTE,
} as const;

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
  launched: boolean;
  attachCommand: string;
  runner?: string;
  model?: string;
  runnerCommand?: string;
}

export interface RoadmapPromoteSpecInput {
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
