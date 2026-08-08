import type { SafetyTier } from '../contracts/agents.js';
import type {
  BacklogBlockedItem,
  BacklogCreateInput,
  BacklogEnqueueResultData,
  BacklogItem,
  BacklogStatus,
  BacklogUpdateInput,
} from '../contracts/backlog.js';
import type { OkResult } from '../contracts/index.js';
import type { Run } from '../contracts/runs.js';

import { Methods } from './registry.js';
import type { TmuxWorkerRef } from './tmux.js';

export const BacklogMethods = {
  create: Methods.BACKLOG_CREATE,
  list: Methods.BACKLOG_LIST,
  update: Methods.BACKLOG_UPDATE,
  delete: Methods.BACKLOG_DELETE,
  markReady: Methods.BACKLOG_MARK_READY,
  closeShipped: Methods.BACKLOG_CLOSE_SHIPPED,
  archive: Methods.BACKLOG_ARCHIVE,
  enqueue: Methods.BACKLOG_ENQUEUE,
  dequeue: Methods.BACKLOG_DEQUEUE,
  autoDispatchTick: Methods.BACKLOG_AUTO_DISPATCH_TICK,
  upcoming: Methods.BACKLOG_UPCOMING,
  specGet: Methods.BACKLOG_SPEC_GET,
  reconcileRun: Methods.BACKLOG_RECONCILE_RUN,
  refine: Methods.BACKLOG_REFINE,
  refinementSessionGet: Methods.BACKLOG_REFINEMENT_SESSION_GET,
} as const;

export const DEFAULT_BACKLOG_REFINEMENT_RUNNER = 'codex';
export const DEFAULT_BACKLOG_REFINEMENT_MODEL = 'gpt-5.6-sol';

export interface BacklogCreateParams extends BacklogCreateInput {}
export interface BacklogCreateResult {
  item: BacklogItem;
}

export interface BacklogListParams {
  project?: string;
  status?: BacklogStatus;
  tags?: string[];
  includeArchived?: boolean;
}
export interface BacklogListResult {
  items: BacklogItem[];
}

export interface BacklogUpdateParams extends BacklogUpdateInput {
  itemId: string;
}
export interface BacklogUpdateResult {
  item: BacklogItem;
  /** Present when this session took authorship from a different principal. */
  authorshipNotice?: string;
}

export interface BacklogCloseShippedParams {
  itemId: string;
  /** Merged PR reference (e.g. owner/repo#123 or a PR URL) proving the work shipped. */
  prRef?: string;
  note?: string;
}
export interface BacklogCloseShippedResult {
  item: BacklogItem;
}

export interface BacklogDeleteParams {
  itemId: string;
}
export type BacklogDeleteResult = OkResult;

export interface BacklogMarkReadyParams {
  itemId: string;
}
export interface BacklogMarkReadyResult {
  item: BacklogItem;
}

export interface BacklogArchiveParams {
  itemId: string;
}
export interface BacklogArchiveResult {
  item: BacklogItem;
}

export interface BacklogEnqueueParams {
  itemId: string;
  auto?: boolean;
}
export interface BacklogEnqueueResult extends BacklogEnqueueResultData {}

export interface BacklogDequeueParams {
  itemId: string;
}
export interface BacklogDequeueResult {
  item: BacklogItem;
}

export interface BacklogAutoDispatchTickParams {
  project?: string;
}
export interface BacklogAutoDispatchTickResult {
  enqueued: BacklogEnqueueResultData[];
  blocked: BacklogBlockedItem[];
}

export interface BacklogUpcomingParams {
  project?: string;
  limit?: number;
}
export interface BacklogUpcomingResult {
  ready: BacklogItem[];
  blocked: BacklogBlockedItem[];
}

export interface BacklogSpecGetParams {
  itemId: string;
}
export interface BacklogSpecGetResult {
  itemId: string;
  path: string;
  content: string;
  hash: string;
}

export interface BacklogReconcileRunParams {
  itemId: string;
  runId: string;
}
export interface BacklogReconcileRunResult {
  item: BacklogItem;
  run: Run;
}

export interface BacklogRefineParams {
  itemId: string;
  /** Optional runner override for this refinement session. */
  runner?: string;
  /** Optional model override for this refinement session. */
  model?: string;
  /** Optional shell command template. Supports {{runner}}, {{model}}, {{prompt_path}}, and {{item_file}}. */
  runnerCommand?: string;
  /** Optional runner safety tier for the refinement launch. */
  safetyTier?: SafetyTier;
  /** Default false for API safety; true creates or attaches the tmux session. */
  launch?: boolean;
}

export interface BacklogRefineResult {
  item: BacklogItem;
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

export interface BacklogRefinementSessionGetParams {
  itemId: string;
}

export interface BacklogRefinementSessionGetResult {
  itemId: string;
  tmuxSession: string;
  tmuxTarget: string;
  exists: boolean;
  tmuxWorker?: TmuxWorkerRef;
  attachCommand: string;
}
