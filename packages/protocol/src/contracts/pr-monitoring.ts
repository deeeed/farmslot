import type { BacklogLaunchSlotPolicy } from './backlog.js';

export interface MonitoredPRIdentity {
  host: string;
  repo: string;
  number: number;
}

/** Refers to a host/account in the gateway's GitHub CLI credential store. Never a token. */
export interface PRSourceAccount {
  host: string;
  login: string;
}

export interface PRExecutionModel {
  runner: string;
  model: string;
  effort?: string;
  /** Further restrict this model to slots within the profile's slot policy. */
  allowedSlots?: string[];
}

export interface PRExecutionChoice {
  slotId: string;
  runner: string;
  model: string;
  effort?: string;
}

/** Gateway-owned linkage; public run/queue mutation requests cannot supply it. */
export interface PRWorkReference {
  kind: 'review' | 'repair';
  id: string;
  sourceId: string;
  pr: MonitoredPRIdentity;
  headSha: string;
  /** Frozen repair inputs matching the queued worker instructions. */
  incidentIds?: string[];
  /** Frozen automated review policy and authority for repeat-review session selection. */
  review?: {
    profile: string;
    ownerId: string;
    options: import('./pr-rules.js').PRReviewOptions;
  };
}

export interface PRExecutionProfile {
  slotPolicy: Extract<BacklogLaunchSlotPolicy, { kind: 'exact' | 'pool' }>;
  /** Ordered alternatives. One review selects one allowed combination. */
  models: PRExecutionModel[];
}

export type PRMonitorPolicy =
  | { mode: 'notify-only' }
  | { mode: 'automatic-repair'; execution: PRExecutionProfile };

export interface PRMonitorConfig {
  pr: MonitoredPRIdentity;
  account: PRSourceAccount;
  project?: string;
  teamId?: string;
  policy: PRMonitorPolicy;
  pollIntervalMs: number;
  watchedChecks: string[];
  automaticAttemptLimit: number;
  cooldownMs: number;
}

export type PRMonitorLifecycle = 'active' | 'paused' | 'stopped' | 'finished';

export interface PRMonitorObservation {
  checkedAt: string;
  headSha: string;
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergeability: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'unknown';
  signals: PRMonitorSignal[];
  /** All observed checks, including unwatched checks and checks still pending. */
  checks?: PRMonitorCheck[];
  repairAccess?: {
    allowed: boolean;
    reason?: string;
    headRepository?: string;
    headBranch?: string;
  };
}

export interface PRMonitorCheck {
  key: string;
  name: string;
  status: 'passed' | 'failed' | 'pending' | 'cancelled' | 'skipped' | 'unknown';
  url: string;
}

/** A provider-owned revision; a new PR head alone never revises a human review. */
export interface PRMonitorSignal {
  key: string;
  revision: string;
  kind: 'review' | 'feedback' | 'check' | 'conflict';
  summary: string;
  url: string;
  checkName?: string;
}

export interface PRMonitorIncident {
  id: string;
  signal: PRMonitorSignal;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  snoozedUntil?: string;
  handledAt?: string;
  attemptCount: number;
  /** Check/conflict failure chain; new provider attempts do not renew its automatic budget. */
  repairChainId?: string;
  /** Set only by confirmed check success or mergeability, never worker completion. */
  repairChainClosedAt?: string;
  queueItemId?: string;
  runId?: string;
  waitingReason?: string;
  resumeCondition?: string;
  lastAttemptAt?: string;
}

export interface PRMonitorRepair {
  id: string;
  mode: 'automatic' | 'manual';
  state: 'pending' | 'queued' | 'running' | 'blocked' | 'finished' | 'cancelled';
  project: string;
  execution: PRExecutionProfile;
  headSha: string;
  incidentIds: string[];
  createdAt: string;
  completedAt?: string;
  queueItemId?: string;
  runId?: string;
  waitingReason?: string;
  nextAdmissionAt?: string;
}

export interface PRProjectMonitorPolicy {
  ownerId: string;
  project: string;
  revision: number;
  enabled: boolean;
  activatedAt: string;
  updatedAt: string;
  config: Omit<PRMonitorConfig, 'pr' | 'project' | 'teamId'>;
}

export interface PRPublicationRecord {
  pr: MonitoredPRIdentity;
  publishedAt: string;
}

export interface PRMonitor {
  id: string;
  revision: number;
  /** Changes only when policy or lifecycle invalidates an in-flight provider read. */
  observationGeneration?: number;
  ownerId: string;
  config: PRMonitorConfig;
  lifecycle: PRMonitorLifecycle;
  createdAt: string;
  updatedAt: string;
  originatingRunIds: string[];
  observation?: PRMonitorObservation;
  observationError?: string;
  nextCheckAt?: string;
  incidents: PRMonitorIncident[];
  repairs?: PRMonitorRepair[];
}
