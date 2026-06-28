import type { QueueItem } from './dispatch.js';
import type { FlowType, RunStatus } from './runs.js';

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
export const BACKLOG_SOURCE_KINDS = ['jira', 'github', 'manual'] as const;
export type BacklogSourceKind = (typeof BACKLOG_SOURCE_KINDS)[number];

export interface BacklogAutoDispatchPolicy {
  enabled?: boolean;
}

export interface ProjectBacklogConfig {
  autoDispatch?: BacklogAutoDispatchPolicy;
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
  priority: number;
  allowedSlots?: string[];
  autoDispatch?: boolean;
  createdAt: string;
  updatedAt: string;
  queuedQueueItemId?: string;
  runId?: string;
  lastObservedRunStatus?: RunStatus;
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
}

export interface BacklogEnqueueResultData {
  item: BacklogItem;
  queueItem: QueueItem;
}
