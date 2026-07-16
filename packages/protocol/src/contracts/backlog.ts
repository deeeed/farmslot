import type { ScriptedRunnerConfig } from './agents.js';
import type { QueueItem } from './dispatch.js';
import type { TaskTemplateSelection } from './evals.js';
import type {
  DevInteractiveProfile,
  FlowType,
  ReviewDepthPolicy,
  ReviewLoopRequest,
  RunStatus,
} from './runs.js';

export const BACKLOG_STATUSES = [
  'candidate',
  'ready',
  'queued',
  'dispatching',
  'running',
  'done',
  'failed',
  'needs-attention',
  'archived',
] as const;

export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

// Terminal statuses a backlog item can be archived from. Shared so the UI and
// gateway agree on one definition (no client/server drift).
export const ARCHIVABLE_BACKLOG_STATUSES: ReadonlySet<BacklogStatus> = new Set([
  'done',
  'failed',
  'needs-attention',
]);

export const BACKLOG_SOURCE_KINDS = ['jira', 'github', 'manual'] as const;
export type BacklogSourceKind = (typeof BACKLOG_SOURCE_KINDS)[number];

export interface BacklogAutoDispatchPolicy {
  enabled?: boolean;
}

export interface ProjectBacklogConfig {
  autoDispatch?: BacklogAutoDispatchPolicy;
}

export type BacklogLaunchSlotPolicy =
  | { kind: 'exact'; slotId: string }
  | { kind: 'pool'; allowedSlots: string[] }
  | { kind: 'spread'; allowedSlots?: string[] };

export type BacklogLaunchCandidateRole = 'baseline' | 'comparison';

export interface BacklogLaunchCandidate {
  id: string;
  role: BacklogLaunchCandidateRole;
  label?: string;
  runner?: string;
  model?: string;
  effort?: string;
  /** Required for comparison candidates; baseline candidates must omit it. */
  variant?: string;
  slotPolicy: BacklogLaunchSlotPolicy;
}

export interface BacklogLaunchPlan {
  id: string;
  version: 1;
  candidates: BacklogLaunchCandidate[];
}

export type BacklogLaunchCandidateStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'gated'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface BacklogLaunchCandidateProjection {
  candidateId: string;
  status: BacklogLaunchCandidateStatus;
  queueItemId?: string;
  runId?: string;
  /** Launch attempt of the run that currently owns this candidate (MANUAL-000037). */
  attempt?: number;
  slotId?: string;
  waitingReason?: string;
}

export interface BacklogLaunchPlanState {
  launchGroupId: string;
  baselineRunId?: string;
  baselineQueueItemId?: string;
  candidates: BacklogLaunchCandidateProjection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertSlotPolicy(
  policy: unknown,
  path: string,
): asserts policy is BacklogLaunchSlotPolicy {
  if (!isRecord(policy)) throw new Error(`${path}.slotPolicy is required`);
  if (policy.kind === 'exact') {
    if (!nonEmptyString(policy.slotId)) throw new Error(`${path}.slotPolicy.slotId is required`);
    return;
  }
  if (policy.kind === 'pool') {
    if (
      !Array.isArray(policy.allowedSlots) ||
      policy.allowedSlots.filter(nonEmptyString).length === 0
    ) {
      throw new Error(`${path}.slotPolicy.allowedSlots must contain at least one slot`);
    }
    return;
  }
  if (policy.kind === 'spread') {
    if (
      policy.allowedSlots !== undefined &&
      (!Array.isArray(policy.allowedSlots) ||
        policy.allowedSlots.some((slot) => !nonEmptyString(slot)))
    ) {
      throw new Error(`${path}.slotPolicy.allowedSlots must contain only non-empty slots`);
    }
    return;
  }
  throw new Error(`${path}.slotPolicy.kind must be exact, pool, or spread`);
}

export function assertBacklogLaunchPlan(value: unknown): asserts value is BacklogLaunchPlan {
  if (!isRecord(value)) throw new Error('launchPlan must be an object');
  if (!nonEmptyString(value.id)) throw new Error('launchPlan.id is required');
  if (value.version !== 1) throw new Error('launchPlan.version must be 1');
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error('launchPlan.candidates must contain at least one candidate');
  }
  let baselineCount = 0;
  const ids = new Set<string>();
  const variants = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    const path = `launchPlan.candidates[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${path} must be an object`);
    if (!nonEmptyString(candidate.id)) throw new Error(`${path}.id is required`);
    if (ids.has(candidate.id)) throw new Error(`duplicate launch candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    if (candidate.role !== 'baseline' && candidate.role !== 'comparison') {
      throw new Error(`${path}.role must be baseline or comparison`);
    }
    if (candidate.role === 'baseline') {
      baselineCount += 1;
      if (
        candidate.variant !== undefined &&
        candidate.variant !== null &&
        String(candidate.variant).trim()
      ) {
        throw new Error('baseline launch candidate must not set variant');
      }
    } else {
      if (!nonEmptyString(candidate.variant)) {
        throw new Error('comparison launch candidate requires variant');
      }
      const variant = candidate.variant.trim();
      if (variants.has(variant)) throw new Error(`duplicate comparison variant: ${variant}`);
      variants.add(variant);
    }
    for (const field of ['label', 'runner', 'model', 'effort'] as const) {
      if (
        candidate[field] !== undefined &&
        candidate[field] !== null &&
        typeof candidate[field] !== 'string'
      ) {
        throw new Error(`${path}.${field} must be a string`);
      }
    }
    assertSlotPolicy(candidate.slotPolicy, path);
  });
  if (baselineCount !== 1) throw new Error('launchPlan requires exactly one baseline candidate');
}

export interface BacklogItem {
  id: string;
  project: string;
  title: string;
  sourceKind: BacklogSourceKind;
  sourceRef: string;
  sourceUrl?: string;
  flowType: FlowType;
  status: BacklogStatus;
  notes?: string;
  /** Shared normalized tags propagated to created runs. */
  tags?: string[];
  /** Originating ADR-041 roadmap item, when promoted from roadmap. */
  roadmapItemId?: string;
  /** Local markdown spec backing this backlog item. */
  specPath?: string;
  /** Work graph linkage; graph-linked backlog items can only be enqueued by the graph scheduler. */
  workGraphId?: string;
  workNodeId?: string;
  priority: number;
  allowedSlots?: string[];
  autoDispatch?: boolean;
  /**
   * Acceptance criteria span multiple PRs: a linked run finishing returns the
   * item to `ready` (next slice dispatchable) instead of auto-closing it.
   * Final closure is the explicit `backlog.closeShipped` call.
   */
  multiPr?: boolean;
  runner?: string;
  model?: string;
  scripted?: ScriptedRunnerConfig;
  effort?: string;
  taskTemplate?: TaskTemplateSelection;
  app?: string;
  prepareProfile?: string;
  mode?: 'interactive' | 'autonomous';
  devInteractiveProfile?: DevInteractiveProfile;
  reviewDepth?: ReviewDepthPolicy;
  pendingReviewPlan?: ReviewLoopRequest[];
  launchPlan?: BacklogLaunchPlan;
  launchPlanState?: BacklogLaunchPlanState;
  createdAt: string;
  updatedAt: string;
  queuedQueueItemId?: string;
  runId?: string;
  lastObservedRunStatus?: RunStatus;
  /** Operator close-out provenance for work that shipped outside the run engine (e.g. out-of-band merged PR). */
  shipped?: { prRef?: string; note?: string; closedAt: string };
  lastDispatchAttempt?: string;
  lastDispatchError?: string;
}

export interface BacklogBlockedItem {
  item: BacklogItem;
  reason: string;
}

export interface BacklogCreateInput {
  project: string;
  title: string;
  sourceKind: BacklogSourceKind;
  sourceRef?: string;
  sourceUrl?: string;
  flowType: FlowType;
  notes?: string;
  tags?: string[];
  roadmapItemId?: string;
  specPath?: string;
  priority?: number;
  allowedSlots?: string[];
  autoDispatch?: boolean;
  multiPr?: boolean;
  runner?: string;
  model?: string;
  scripted?: ScriptedRunnerConfig;
  effort?: string;
  taskTemplate?: TaskTemplateSelection;
  app?: string;
  prepareProfile?: string;
  mode?: 'interactive' | 'autonomous';
  devInteractiveProfile?: DevInteractiveProfile;
  reviewDepth?: ReviewDepthPolicy;
  pendingReviewPlan?: ReviewLoopRequest[];
  launchPlan?: BacklogLaunchPlan;
  status?: Extract<BacklogStatus, 'candidate' | 'ready'>;
}

export interface BacklogUpdateInput {
  title?: string;
  sourceKind?: BacklogSourceKind;
  sourceRef?: string;
  sourceUrl?: string | null;
  flowType?: FlowType;
  notes?: string | null;
  tags?: string[] | null;
  roadmapItemId?: string | null;
  specPath?: string | null;
  priority?: number;
  allowedSlots?: string[] | null;
  autoDispatch?: boolean;
  multiPr?: boolean | null;
  runner?: string | null;
  model?: string | null;
  scripted?: ScriptedRunnerConfig | null;
  effort?: string | null;
  taskTemplate?: TaskTemplateSelection | null;
  app?: string | null;
  prepareProfile?: string | null;
  mode?: 'interactive' | 'autonomous' | null;
  devInteractiveProfile?: DevInteractiveProfile | null;
  reviewDepth?: ReviewDepthPolicy | null;
  pendingReviewPlan?: ReviewLoopRequest[] | null;
  launchPlan?: BacklogLaunchPlan | null;
}

export interface BacklogEnqueueResultData {
  item: BacklogItem;
  queueItem: QueueItem;
}
