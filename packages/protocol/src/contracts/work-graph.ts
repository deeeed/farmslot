export type WorkGraphStatus =
  | 'planning'
  | 'active'
  | 'paused'
  | 'waiting'
  | 'needs-attention'
  | 'done'
  | 'failed'
  | 'archived';

export type WorkNodeStatus =
  | 'planned'
  | 'waiting'
  | 'ready'
  | 'queued'
  | 'running'
  | 'gated'
  | 'succeeded'
  | 'failed'
  | 'needs-attention'
  | 'skipped';

export type WorkEdgeStatus = 'pending' | 'satisfied' | 'failed' | 'waived';

export type WorkEdgeBlocks = 'start' | 'completion';

export type WorkNodeKind = 'backlog' | 'reference';

export type WorkReferenceKind =
  | 'jira'
  | 'github-pr'
  | 'github-issue'
  | 'package-release'
  | 'artifact'
  | 'manual'
  | 'url'
  | 'other';

export type WorkReferenceStatus =
  | 'unknown'
  | 'pending'
  | 'blocked'
  | 'satisfied'
  | 'failed'
  | 'waived';

export type NodeFailurePolicy = 'halt' | 'skip-dependents' | 'isolate';

export interface WorkGraphSource {
  kind: 'manual' | 'external-import';
  ref?: string;
  url?: string;
}

export interface SchedulerLease {
  leaseOwner?: string;
  leaseUntil?: string;
  lastTickAt?: string;
}

export interface WorkGraph {
  id: string;
  version: 1;
  project: string;
  title: string;
  source: WorkGraphSource;
  tags?: string[];
  status: WorkGraphStatus;
  defaultFailurePolicy: NodeFailurePolicy;
  scheduler: SchedulerLease;
  createdAt: string;
  updatedAt: string;
}

export interface WorkNode {
  id: string;
  graphId: string;
  kind: WorkNodeKind;
  backlogItemId?: string;
  reference?: WorkNodeReference;
  tags?: string[];
  status: WorkNodeStatus;
  currentFamilyId?: string;
  currentRootRunId?: string;
  latestRunId?: string;
  supersededFamilyIds?: string[];
  baseRef?: string;
  upstreamBaseNodeIds?: string[];
  waitingOn: WaitingReason[];
  onFailure?: NodeFailurePolicy;
  updatedAt: string;
}

export interface WorkNodeReference {
  kind: WorkReferenceKind;
  title: string;
  ref: string;
  status: WorkReferenceStatus;
  url?: string;
  project?: string;
  owner?: string;
  evidence?: string;
  labels?: string[];
  updatedAt?: string;
}

export type EdgeCondition =
  | { kind: 'family-done'; outcome?: 'success' | 'terminal' }
  | { kind: 'merged'; targetRef?: string }
  | { kind: 'manual'; gateId: string }
  | { kind: 'reference-status'; status?: WorkReferenceStatus };

export type UnlockAction =
  | { kind: 'enqueue' }
  | { kind: 'mark-ready' }
  | { kind: 'rebase-onto'; flow: 'merge-main' | 'pr-complete' };

export interface GraphGateResolution {
  graphId?: string;
  gateId: string;
  nodeId?: string;
  edgeId?: string;
  reason: string;
  decision: 'approved' | 'rejected' | 'waived';
  resolvedAt: string;
}

export interface EdgeEvidence {
  mergeSha?: string;
  prNumber?: number;
  referenceStatus?: WorkReferenceStatus;
  referenceRef?: string;
  manualResolution?: GraphGateResolution;
  observedAt: string;
}

export interface WorkEdge {
  id: string;
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  condition: EdgeCondition;
  blocks?: WorkEdgeBlocks;
  required: boolean;
  status: WorkEdgeStatus;
  evidence?: EdgeEvidence;
  unlock: UnlockAction;
  lastEvaluatedAt?: string;
}

export interface WaitingReason {
  kind: 'upstream' | 'manual-gate' | 'resource' | 'retry-backoff' | 'policy';
  edgeId?: string;
  upstreamNodeId?: string;
  detail: string;
}

export interface WorkGraphActionLedgerEntry {
  key: string;
  graphId: string;
  nodeId: string;
  actionKind: UnlockAction['kind'];
  readinessVersion: string;
  status: 'started' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: string;
}

export interface WorkGraphSnapshot {
  graph: WorkGraph;
  nodes: WorkNode[];
  edges: WorkEdge[];
  gates: GraphGateResolution[];
  ledger: WorkGraphActionLedgerEntry[];
}

export interface WorkGraphProjection extends WorkGraphSnapshot {}

export interface WorkGraphCreateInput {
  id?: string;
  project: string;
  title: string;
  source?: WorkGraphSource;
  tags?: string[];
  defaultFailurePolicy?: NodeFailurePolicy;
}

export interface WorkGraphAddNodeInput {
  graphId: string;
  kind?: WorkNodeKind;
  backlogItemId?: string;
  reference?: WorkNodeReference;
  id?: string;
  tags?: string[];
  onFailure?: NodeFailurePolicy;
}

export interface WorkGraphAddEdgeInput {
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  id?: string;
  condition: EdgeCondition;
  blocks?: WorkEdgeBlocks;
  required?: boolean;
  unlock?: UnlockAction;
}

export interface WorkGraphUpdateNodeInput {
  graphId: string;
  nodeId: string;
  status?: WorkNodeStatus;
  reference?: WorkNodeReference | null;
  tags?: string[] | null;
  onFailure?: NodeFailurePolicy | null;
  baseRef?: string | null;
  upstreamBaseNodeIds?: string[] | null;
}

export interface WorkGraphListParams {
  project?: string;
  status?: WorkGraphStatus;
  tags?: string[];
  includeArchived?: boolean;
}
