import type {
  DispatchPreview,
  EvalQueueCell,
  FlowType,
  OkResult,
  QueueItem,
  QueueItemKind,
} from '../contracts/index.js';

import { Methods } from './registry.js';

export const DispatchMethods = {
  preview: Methods.DISPATCH_PREVIEW,
  matchProject: Methods.DISPATCH_MATCH_PROJECT,
  candidates: Methods.DISPATCH_CANDIDATES,
  queueAdd: Methods.DISPATCH_QUEUE_ADD,
  queueList: Methods.DISPATCH_QUEUE_LIST,
  queueRemove: Methods.DISPATCH_QUEUE_REMOVE,
  queueRemoveOrphan: Methods.DISPATCH_QUEUE_REMOVE_ORPHAN,
  queueUpdate: Methods.DISPATCH_QUEUE_UPDATE,
  queueReorder: Methods.DISPATCH_QUEUE_REORDER,
} as const;

// ─── Dispatch match param/result types ───

export interface DispatchMatchProjectParams {
  ticketOrPr: string;
  flowType: FlowType;
}

export interface DispatchMatchProjectResult {
  project: string | null;
  repo: string | null;
  /** Normalized ticket key (e.g. PROJ-2368 extracted from URL) */
  normalizedTicket?: string;
  /** Jira issue type (Bug, Task, Story, etc.) — for auto flow type detection */
  issueType?: string;
}

// ─── Dispatch Candidates param/result types ───

export interface DispatchCandidatesParams {
  project: string;
  flowType?: string;
  /** Restrict candidates to the named machines. Empty/omitted = all machines. */
  machines?: string[];
  /**
   * Branch the dispatch is targeting (e.g. the PR's head branch for review-pr /
   * pr-complete). When set, slot.branch === targetBranch flips the stale-branch
   * penalty into a bonus so the slot already holding the PR wins auto-select.
   */
  targetBranch?: string;
  /**
   * Ticket or PR ref (e.g. `owner/repo#123`, `PROJ-2802`) the dispatch will reference.
   * When set together with a PR-bound `flowType` (`pr-complete` / `review-pr`), the
   * gateway also surfaces busy slots whose worker is loaded on the matching PR's
   * branch as `nudgeEligible: true` candidates so the wizard can offer a context-
   * preserving nudge instead of dispatching fresh on a stale free slot.
   */
  ticketOrPr?: string;
  /** App/surface hint used to derive prepare-profile resource requirements. */
  app?: string;
  /** Named prepare profile from the project's prepare.profiles. */
  prepareProfile?: string;
  /** Run lane (production/validation/comparison). Comparison-lane suppresses nudge
   * candidates so sibling comparison runs still require explicit scrub between them
   * per ADR-024 §7. */
  lane?: import('../contracts/index.js').RunLane;
  /** Optional family/variant context to flag soft mismatches as risk flags on nudge candidates. */
  familyId?: string;
  variant?: string | null;
}

/** Optional metadata attached to busy candidates whose branch matches the dispatch's `targetBranch`.
 * Surfaces context the operator needs to decide whether to nudge into the worker's session
 * (preserve loaded PR context) or kill + dispatch fresh. Mirrors the headless decision-card payload
 * (`BranchAffinityNudgePayload.candidate`) but kept inline so the wizard doesn't have to round-trip
 * through a decision. */
export interface DispatchCandidateNudgeMeta {
  uncommittedCount: number;
  /** First 10 paths from `git status --porcelain`. */
  uncommittedFiles: string[];
  nudgeCount: number;
  ctxPct: number | null;
  prMatchKind: 'pr-number' | 'branch-slug';
  riskFlags: string[];
  /** True when the slot's runner supports tmux send-keys nudges (Claude today). When false the
   * row still surfaces — the operator wants to see "this slot is on the PR's branch" — but
   * the wizard's Nudge action button is disabled with a tooltip; only Fresh dispatch works. */
  canNudge: boolean;
}

export interface DispatchCandidate {
  slotId: string;
  score: number;
  cdpLive: boolean;
  branch: string;
  lifecycle: string;
  /** True when the slot is on an idle baseline (default or tracking branch), not a stale feature branch. */
  onMain: boolean;
  hostLoad?: { cpuPercent: number; memoryPercent: number; diskPercent: number; headroom: string };
  /** True when direct dispatch can pin this slot immediately. Busy/held rows are informational only. */
  free: boolean;
  /** True when this slot already carries the inferred/explicit run family for the dispatch. */
  familyAffinity?: boolean;
  /** True when this row is a busy slot already on the dispatch's `targetBranch` and the
   * runner supports tmux nudges (Claude today). The wizard renders these rows with a
   * "REUSE WORKER" badge and per-row nudge / fresh / pick actions. */
  nudgeEligible?: boolean;
  /** Populated iff `nudgeEligible === true`. */
  nudgeMeta?: DispatchCandidateNudgeMeta;
  /** Why FIND_SLOT would reject this slot for the current dispatch (branch ownership,
   * missing companion resources). Present so the wizard can disable the row instead of
   * advertising a selection that fails later at dispatch validation. */
  ineligibleReason?: string;
}

export interface DispatchCandidatesResult {
  candidates: DispatchCandidate[];
}

// ─── Dispatch Queue param/result types ───

export interface DispatchQueueAddParams {
  queueKind?: QueueItemKind;
  label?: string;
  flowType: FlowType;
  project: string;
  ticketOrPr: string;
  familyId?: string;
  parentRunId?: string;
  familyRootTicketOrPr?: string;
  lane?: import('../contracts/index.js').RunLane;
  variant?: string | null;
  /** Selected project-owned worker template version for queued dispatch parity. */
  taskTemplate?: import('../contracts/index.js').TaskTemplateSelection;
  /** Exact shared-catalog template id for queued dispatch parity. */
  executionTemplateId?: string;
  /** Named project domain carried through queue dispatch. */
  domain?: string;
  app?: string;
  /** Named prepare profile from the project's prepare.profiles (ADR-037). */
  prepareProfile?: string;
  model?: string;
  runner?: string;
  /** Worker scripted-runner config when runner='scripted'. */
  scripted?: import('../contracts/index.js').ScriptedRunnerConfig;
  effort?: string;
  mode?: 'interactive' | 'autonomous' | 'validation';
  devInteractiveProfile?: import('../contracts/index.js').DevInteractiveProfile;
  /** Shared normalized tags propagated to the created run. */
  tags?: string[];
  initialContext?: string;
  devChecklist?: string[];
  slotId?: string;
  /** Same semantics as RunCreateParams.allowedSlots — persisted on the queue item so the auto-dispatcher honors the UI's filter when the slot frees. */
  allowedSlots?: string[];
  /** Same semantics as RunCreateParams.branch — feeds buildQueuePreviewParams' targetBranch so PR-bound queue items get the same scoring as direct dispatch. */
  branch?: string;
  /** Same semantics as RunCreateParams.completionPolicy — persisted for queue -> run parity. */
  completionPolicy?: import('../contracts/index.js').RunCompletionPolicy;
  /** Same semantics as RunCreateParams.startRef — queued replay/compare base ref. */
  startRef?: string;
  startRefSource?: import('../contracts/index.js').RunStartRefSource;
  /** Same semantics as RunCreateParams.reviewDepth — persisted onto the created run. */
  reviewDepth?: import('../contracts/index.js').ReviewDepthPolicy;
  reviewScope?: import('../contracts/index.js').ReviewScope;
  reviewValidationDepth?: import('../contracts/index.js').ReviewValidationDepth;
  /** Same semantics as RunCreateParams.pendingReviewPlan — additional independent reviews for auto-dispatch. */
  pendingReviewPlan?: import('../contracts/index.js').ReviewLoopRequest[];
  /** Internal ADR-044 launch-plan linkage. Public dispatch.queue.add rejects these fields. */
  launchPlanId?: string;
  launchCandidateId?: string;
  launchGroupId?: string;
  launchSlotPolicy?: import('../contracts/index.js').BacklogLaunchSlotPolicy['kind'];
  /** Eval matrix cell metadata. Required when queueKind is eval-cell. */
  evalCell?: EvalQueueCell;
  priority?: number;
}

export interface DispatchQueueAddResult {
  item: QueueItem;
}

export interface DispatchQueueListParams {}

export interface DispatchQueueListResult {
  items: QueueItem[];
}

export interface DispatchQueueRemoveParams {
  itemId: string;
}

export type DispatchQueueRemoveResult = OkResult;

export interface DispatchQueueRemoveOrphanParams {
  itemId: string;
}

export type DispatchQueueRemoveOrphanResult = OkResult;

export interface DispatchQueueUpdateParams {
  itemId: string;
  priority?: number;
  label?: string;
  slotId?: string | null;
  allowedSlots?: string[] | null;
}

export interface DispatchQueueUpdateResult {
  item: QueueItem;
  /** Present when this session took authorship from a different principal. */
  authorshipNotice?: string;
}

export interface DispatchQueueReorderParams {
  itemIds: string[];
}

export interface DispatchQueueReorderResult {
  items: QueueItem[];
}

export interface DispatchPreviewParams {
  slotId?: string;
  project: string;
  flowType: import('../contracts/index.js').FlowType;
  ticketOrPr: string;
  /** Required when the project uses configured execution templates. */
  mode?: 'interactive' | 'autonomous' | 'validation';
  /** Exact configured-catalog template id to preview. */
  executionTemplateId?: string;
  familyId?: string;
  lane?: import('../contracts/index.js').RunLane;
  variant?: string | null;
  app?: string;
  /** Named domain overlay the dispatch will carry — echoed back on the preview. */
  domain?: string;
  prepareProfile?: string;
  /** Restrict slot resolution to this set. Empty/omitted = all project slots. */
  allowedSlots?: string[];
  /**
   * Branch the dispatch targets (PR head for review-pr/pr-complete). When set,
   * slotScore flips the stale-branch penalty into a bonus for slots already on
   * that branch, matching `dispatch.candidates`. Unused for main-branch flows.
   */
  targetBranch?: string;
}

export interface DispatchExecuteParams {
  slotId: string;
  taskFile: string;
  runId?: string;
  mode?: 'interactive' | 'autonomous' | 'validation';
  familyId?: string;
  lane?: import('../contracts/index.js').RunLane;
  variant?: string | null;
  force?: boolean;
  skipPrepare?: boolean;
  model?: string;
  runner?: string;
  /** Worker scripted-runner config when runner='scripted'. */
  scripted?: import('../contracts/index.js').ScriptedRunnerConfig;
  effort?: string;
  app?: string;
  /** Runner execution safety tier (ADR-023). Resolved by run-engine before dispatch. */
  safetyTier?: import('../contracts/index.js').SafetyTier;
  /**
   * Optional provider subscription account label for codex (and future bindable
   * runners). When omitted, dispatch resolves from operator-local config.
   * Used for in-place failover rebinds inside the DISPATCH step.
   */
  providerAccountLabel?: string;
}
export interface DispatchPreviewResult {
  preview: DispatchPreview;
}
