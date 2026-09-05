/**
 * Run resource posture (ADR-054).
 *
 * The Gateway owns one semantic posture per run describing which runtime
 * capabilities should be live at the current lifecycle boundary. Clients render
 * the Gateway's decision — desired disposition, observed provider state, the
 * winning policy source — and never resolve policy themselves.
 */
import type {
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityHealthState,
  RuntimeCapabilityLeaseOwner,
  RuntimeCapabilityLeaseState,
} from './runtime-capabilities.js';

/**
 * The lease fields `observedStateForLease` reads. Structural so this module
 * stays free of a value-level dependency on the lease type.
 */
export interface RuntimeCapabilityLeaseLike {
  state: RuntimeCapabilityLeaseState;
  health: { state: RuntimeCapabilityHealthState };
  keepWarmUntil?: string;
  cleanupFailure?: string;
}

/** Semantic lifecycle intent. Never derived from run status, step names, or slot phases. */
export const RESOURCE_POSTURES = ['active', 'operator-wait', 'parked', 'terminal'] as const;
export type ResourcePosture = (typeof RESOURCE_POSTURES)[number];

/** Operator vocabulary at a human gate; each resolves to a posture plus proof plan. */
export const RESOURCE_POSTURE_GATE_CHOICES = [
  'keep-for-validation',
  'minimize',
  'free-slot',
  'project-default',
] as const;
export type ResourcePostureGateChoice = (typeof RESOURCE_POSTURE_GATE_CHOICES)[number];

/**
 * Dispatch-time preset for every durable wait of a run. `project-default` is
 * excluded: a preset that defers to the lower precedence levels is a no-op, and
 * omitting the field already expresses it.
 */
export const RESOURCE_POSTURE_WAIT_POLICIES = [
  'keep-for-validation',
  'minimize',
  'free-slot',
] as const;
export type ResourcePostureWaitPolicy = (typeof RESOURCE_POSTURE_WAIT_POLICIES)[number];

/** Which precedence level produced the effective policy. */
export const RESOURCE_POSTURE_POLICY_SOURCES = [
  'gate-choice',
  'run-dispatch',
  'project-default',
  'framework-default',
] as const;
export type ResourcePosturePolicySource = (typeof RESOURCE_POSTURE_POLICY_SOURCES)[number];

/** What the Gateway intends for a capability. Distinct from what is observed. */
export const RESOURCE_POSTURE_DISPOSITIONS = ['acquired', 'warm', 'stopped'] as const;
export type ResourcePostureDesiredDisposition = (typeof RESOURCE_POSTURE_DISPOSITIONS)[number];

/**
 * What the provider is actually doing. A released lease with a live keep-warm
 * provider is `running`, not `stopped`.
 */
export const RESOURCE_POSTURE_OBSERVED_STATES = [
  'running',
  'stopped',
  'unhealthy',
  'transitioning',
  'unknown',
] as const;
export type ResourcePostureObservedState = (typeof RESOURCE_POSTURE_OBSERVED_STATES)[number];

/** Per-provider project retention policy for a posture. */
export const RESOURCE_POSTURE_RETENTIONS = ['retain', 'warm', 'stop'] as const;
export type ResourcePostureRetention = (typeof RESOURCE_POSTURE_RETENTIONS)[number];

/**
 * Postures a project may configure retention for. `active` is derived from the
 * current proof plan and `parked` delegates to machine parking, so neither
 * accepts a retention override.
 */
export const RESOURCE_POSTURE_RETENTION_BOUNDARIES = ['operator-wait', 'terminal'] as const;
export type ResourcePostureRetentionBoundary =
  (typeof RESOURCE_POSTURE_RETENTION_BOUNDARIES)[number];

/** Project-level posture defaults; per-provider `retention` overrides these. */
export interface ProjectResourcePostureConfig {
  defaults?: Partial<Record<ResourcePostureRetentionBoundary, ResourcePostureRetention>>;
}

export interface ResourcePostureCapabilityState {
  capabilityId: string;
  desiredDisposition: ResourcePostureDesiredDisposition;
  observedState: ResourcePostureObservedState;
  policySource: ResourcePosturePolicySource;
  reason: string;
  leaseId?: string;
  owner?: RuntimeCapabilityLeaseOwner;
  /** Deadline until which a released provider stays live. */
  warmUntil?: string;
  lastTransitionAt?: string;
  releaseEffects: string[];
  cleanupFailure?: string;
}

export type ResourcePostureRejection =
  | {
      kind: 'park-ineligible';
      /** Machine-parking eligibility code, passed through unchanged. */
      code: string;
      reason: string;
    }
  | {
      kind: 'capability-unavailable';
      capabilityId: string;
      reason: string;
      conflict: RuntimeCapabilityAcquireConflict;
    }
  | { kind: 'invalid-request'; reason: string };

export const RESOURCE_POSTURE_TRANSITION_OUTCOMES = [
  'in-progress',
  'applied',
  'idempotent',
  'partial',
  'rejected',
  /** Reconciliation could not run at all (catalog/provider unreachable). */
  'failed',
] as const;
export type ResourcePostureTransitionOutcome =
  (typeof RESOURCE_POSTURE_TRANSITION_OUTCOMES)[number];

export interface ResourcePostureTransitionFailure {
  capabilityId: string;
  leaseId?: string;
  reason: string;
}

export interface ResourcePostureTransition {
  /** Caller-supplied `operationId` when present, so a replay returns this record. */
  id: string;
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  gateChoice?: ResourcePostureGateChoice;
  requestedAt: string;
  completedAt?: string;
  outcome: ResourcePostureTransitionOutcome;
  effects: string[];
  progress: { total: number; completed: number };
  failures: ResourcePostureTransitionFailure[];
  rejection?: ResourcePostureRejection;
}

/** Exact effect of applying a posture, returned before an operator commits. */
export interface ResourcePosturePlan {
  runId: string;
  slotId: string | null;
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  reason: string;
  acquire: ResourcePostureCapabilityState[];
  retain: ResourcePostureCapabilityState[];
  warm: ResourcePostureCapabilityState[];
  stop: ResourcePostureCapabilityState[];
  /** Declared release effects of everything this plan would stop. */
  effects: string[];
  rejection?: ResourcePostureRejection;
}

/** Persisted on the run so a reconnecting client sees the same thing. */
export interface RunResourcePostureState {
  posture: ResourcePosture;
  policySource: ResourcePosturePolicySource;
  gateChoice?: ResourcePostureGateChoice;
  waitPolicy?: ResourcePostureWaitPolicy;
  capabilities: ResourcePostureCapabilityState[];
  /** ADR-038: no posture resolved here stops a gate-held worker. */
  workerRetained: boolean;
  lastTransition?: ResourcePostureTransition;
  /**
   * Recent transitions, newest first, bounded by
   * `RESOURCE_POSTURE_TRANSITION_HISTORY`. Replaying an `operationId` returns the
   * stored outcome for any id still in here, so a retry of an earlier operation
   * cannot re-execute and undo a later one.
   */
  recentTransitions?: ResourcePostureTransition[];
  updatedAt: string;
}

/** How many transitions a run keeps for operation-id replay. */
export const RESOURCE_POSTURE_TRANSITION_HISTORY = 20;

/** Gate choice -> posture. The only place this mapping exists. */
export function postureForGateChoice(
  choice: Exclude<ResourcePostureGateChoice, 'project-default'>,
): ResourcePosture {
  if (choice === 'keep-for-validation') return 'active';
  if (choice === 'free-slot') return 'parked';
  return 'operator-wait';
}

/**
 * The single derivation of a provider's observed state from its lease.
 *
 * Shared so the Gateway and every client answer "is this provider running?"
 * identically. A client that re-derives this locally will drift — Slot View
 * once decided an elapsed warm deadline meant `stopped` while the Gateway
 * reported `unknown`, which labels a live provider as dead.
 *
 * `nowMs` is passed in so the caller evaluates the warm deadline against the
 * same instant it rendered with.
 */
export function observedStateForLease(
  lease: RuntimeCapabilityLeaseLike | undefined,
  nowMs: number,
): ResourcePostureObservedState {
  if (!lease) return 'stopped';
  if (lease.state === 'error') return lease.cleanupFailure ? 'unhealthy' : 'unknown';
  if (lease.state === 'acquiring' || lease.state === 'releasing' || lease.state === 'queued') {
    return 'transitioning';
  }
  if (lease.state === 'acquired')
    return lease.health.state === 'unhealthy' ? 'unhealthy' : 'running';
  // A released lease is not a stopped provider while keep-warm is still live.
  if (lease.keepWarmUntil && Date.parse(lease.keepWarmUntil) > nowMs) return 'running';
  // An elapsed warm deadline is a schedule, not an outcome: the sweeper may not
  // have run yet, so the provider's real state is not known until cleanup does.
  if (lease.keepWarmUntil) return 'unknown';
  return 'stopped';
}

export function isResourcePosture(value: unknown): value is ResourcePosture {
  return RESOURCE_POSTURES.includes(value as ResourcePosture);
}

export function isResourcePostureGateChoice(value: unknown): value is ResourcePostureGateChoice {
  return RESOURCE_POSTURE_GATE_CHOICES.includes(value as ResourcePostureGateChoice);
}

export function isResourcePostureWaitPolicy(value: unknown): value is ResourcePostureWaitPolicy {
  return RESOURCE_POSTURE_WAIT_POLICIES.includes(value as ResourcePostureWaitPolicy);
}

/**
 * How the observed provider state stands against what the Gateway wanted.
 *
 * `unproven` is deliberately not folded into `mismatch` or `matches`: an
 * `unknown` observation means the Gateway could not see the provider, and
 * claiming either outcome from it would be a guess.
 */
export type ResourcePostureRowStatus = 'matches' | 'pending' | 'mismatch' | 'unproven';

/**
 * The single comparison of desired disposition against observed provider state.
 *
 * Shared so Command Center, Companion, and the CLI agree on when the Gateway
 * got what it asked for. A client that re-derives this locally drifts, and the
 * drift is always in the same direction: reporting a provider as handled when
 * nothing observed it.
 */
export function resourcePostureRowStatus(
  desired: ResourcePostureDesiredDisposition,
  observed: ResourcePostureObservedState,
): ResourcePostureRowStatus {
  if (observed === 'transitioning') return 'pending';
  if (observed === 'unknown') return 'unproven';
  if (desired === 'stopped') return observed === 'stopped' ? 'matches' : 'mismatch';
  // `acquired` and `warm` both want a live provider; the difference is ownership.
  return observed === 'running' ? 'matches' : 'mismatch';
}

/**
 * Counts of what the providers are observed to be doing, not of what was
 * wanted. `stopped` requires an observed `stopped`: a provider the Gateway
 * intended to stop but which is still running, or whose cleanup failed, must
 * never be counted as stopped. Anything the Gateway cannot currently place —
 * unknown, transitioning, or contradicting its intent — lands in `unresolved`
 * so the buckets always account for every capability instead of quietly
 * dropping one.
 */
export interface ResourcePostureCounts {
  retained: number;
  warm: number;
  stopped: number;
  failed: number;
  unresolved: number;
}

export function resourcePostureCounts(
  capabilities: readonly ResourcePostureCapabilityState[],
  lastTransition?: ResourcePostureTransition,
): ResourcePostureCounts {
  const failedInTransition = new Set(
    (lastTransition?.failures ?? []).map((failure) => failure.capabilityId),
  );
  const counts: ResourcePostureCounts = {
    retained: 0,
    warm: 0,
    stopped: 0,
    failed: 0,
    unresolved: 0,
  };
  for (const capability of capabilities) {
    // A failure is reported as a failure and nothing else. Counting it in a
    // disposition bucket as well would let "1 stopped" describe a provider the
    // Gateway could not stop.
    if (capability.cleanupFailure || failedInTransition.has(capability.capabilityId)) {
      counts.failed += 1;
      continue;
    }
    if (capability.observedState === 'stopped') counts.stopped += 1;
    else if (capability.observedState === 'running') {
      if (capability.desiredDisposition === 'warm') counts.warm += 1;
      else if (capability.desiredDisposition === 'acquired') counts.retained += 1;
      // Running against a stop intent is neither retained nor stopped.
      else counts.unresolved += 1;
    } else if (capability.observedState === 'unhealthy') counts.failed += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

/**
 * Transition failures that are not already reported on a capability entry.
 *
 * A failed cleanup lands in both places: the transition's failure list and the
 * capability's own `cleanupFailure`. Reporting both gives the operator the same
 * alert twice. The capability entry wins — it sits next to that capability's
 * desired and observed state, which is the context needed to act on it.
 *
 * The match is on capability AND reason. The Gateway reports a failure per
 * lease while a capability entry carries one reason, so suppressing every
 * failure for a capability that had any entry failure would silently drop a
 * sibling lease's different failure — the one case where the transition list is
 * the only place that failure is reported at all.
 */
export function resourcePostureTransitionFailuresToShow(
  capabilities: readonly Pick<ResourcePostureCapabilityState, 'capabilityId' | 'cleanupFailure'>[],
  lastTransition?: ResourcePostureTransition,
): ResourcePostureTransitionFailure[] {
  // NUL separator: it cannot occur in a capability id or a reason, so no pair
  // of distinct values can collide into one key.
  const alreadyReported = new Set(
    capabilities
      .filter((capability) => capability.cleanupFailure)
      .map((capability) => `${capability.capabilityId}\u0000${capability.cleanupFailure}`),
  );
  return (lastTransition?.failures ?? []).filter(
    (failure) => !alreadyReported.has(`${failure.capabilityId}\u0000${failure.reason}`),
  );
}
