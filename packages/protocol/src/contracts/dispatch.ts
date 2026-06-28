import type { TaskTemplateSelection } from './evals.js';
import type {
  DevInteractiveProfile,
  FlowType,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  RunCompletionPolicy,
  RunLane,
  RunStartRefProvenance,
} from './runs.js';
import type { ProfileFitSuggestion } from './validation-plan.js';

export type QueueItemKind = 'dispatch' | 'eval-cell';

export interface EvalQueueCell {
  capGroupId: string;
  suiteId?: string;
  cellId: string;
  caseSelectionId?: string;
  candidateId?: string;
  candidateLabel?: string;
  experimentId: string;
  experimentKey?: string;
  experimentManifestPath: string;
  trialId: string;
  trialStartParams: Record<string, unknown>;
}

export interface QueueItem {
  id: string;
  queueKind?: QueueItemKind;
  /** Backlog item that produced this queue entry, when queued from durable backlog. */
  backlogItemId?: string;
  /** Work graph node that authorized this queued backlog dispatch. */
  workGraphId?: string;
  workNodeId?: string;
  label?: string;
  flowType: FlowType;
  project: string;
  ticketOrPr: string;
  familyId?: string;
  parentRunId?: string | null;
  familyRootTicketOrPr?: string;
  lane?: RunLane;
  variant?: string | null;
  /** Selected project-owned worker template version for queued dispatch parity. */
  taskTemplate?: TaskTemplateSelection;
  app?: string;
  /** Named prepare profile persisted for queued dispatch parity (ADR-037). */
  prepareProfile?: string;
  model?: string;
  runner?: string;
  effort?: string;
  mode?: 'interactive' | 'autonomous' | 'validation';
  devInteractiveProfile?: DevInteractiveProfile;
  /** Shared normalized tags propagated to the created run. */
  tags?: string[];
  initialContext?: string;
  /** Optional pre-fetched/manual ticket payload forwarded through queue dispatch. */
  ticketData?: import('./runs.js').RunTicketData;
  devChecklist?: string[];
  slotId?: string; // preferred slot
  /** Slot-ID allow list resolved from UI filters at queue time. null = unrestricted. */
  allowedSlots?: string[] | null;
  /** PR head branch (review-pr / pr-complete). Forwarded as targetBranch so the auto-dispatcher prefers a slot already on this branch. */
  branch?: string | null;
  /** Completion safety policy persisted through queue dispatch handoff. */
  completionPolicy?: RunCompletionPolicy;
  /** Requested/resolved base ref for artifact-only comparison replay runs. */
  startRef?: RunStartRefProvenance | null;
  /** Fix-bug publication review depth requested when the queue item was created. */
  reviewDepth?: ReviewDepthPolicy;
  /** Ordered extra review loops to run before the first ready gate. */
  pendingReviewPlan?: ReviewLoopRequest[];
  evalCell?: EvalQueueCell;
  priority: number; // lower = higher priority, default 10
  createdAt: string;
  status: 'queued' | 'dispatching' | 'cancelled';
  runId?: string; // set when dispatched
}

export interface DispatchRequest {
  slotId: string;
  taskFile: string;
  force?: boolean;
  skipPrepare?: boolean;
}

export interface DispatchPreview {
  slotId: string;
  project: string;
  flowType: FlowType;
  branch: string | null;
  runner: string;
  model: string;
  taskId: string;
  profileFit?: ProfileFitSuggestion;
}
