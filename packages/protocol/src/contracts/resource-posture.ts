/**
 * Run resource posture (ADR-054).
 *
 * The Gateway owns one semantic posture per run describing which runtime
 * capabilities should be live at the current lifecycle boundary. Clients render
 * the Gateway's decision — desired disposition, observed provider state, the
 * winning policy source — and never resolve policy themselves.
 */
import type { MachinePauseEligibilityDetails } from './runs.js';
import type {
  RuntimeCapabilityAcquireConflict,
  RuntimeCapabilityHealthState,
  RuntimeCapabilityLeaseOwner,
  RuntimeCapabilityLeaseState,
  RuntimeCapabilityTarget,
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
  /**
   * The device identity the holding lease actually resolved to, when the
   * provider takes one. Read off the lease's stored acquire parameters, so a
   * client shows the device that is really in use rather than the slot's
   * configured default after a re-target.
   */
  target?: RuntimeCapabilityTarget;
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
      /** Structured facts for the code, passed through unchanged. */
      details?: MachinePauseEligibilityDetails;
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
  /**
   * The run generation a `machine.pause.restore` replay took ownership at, when
   * that restore re-presented a gate whose stored choice would re-park the run.
   *
   * Without it a run whose stored choice is `free-slot` re-parks itself the
   * instant restore re-presents its gate: the replayed gate reaches the
   * operator-wait boundary, the stored choice is carried forward, and the run
   * parks again before the operator ever sees it. The restored gate therefore
   * falls back to the framework default once; choosing `free-slot` again is
   * still available, it just has to be chosen rather than inherited.
   *
   * Keyed on the GENERATION rather than a bare flag so it cannot outlive the
   * gate it was set for. The replay is fire-and-forget: if it never reaches a
   * wait boundary, a bare flag would sit on the run and silently swallow the
   * operator's choice at some unrelated later wait. A generation that has moved
   * on makes the suppression simply not apply.
   *
   * Cleared by the first wait boundary after it is set, whether or not that
   * boundary carried an explicit choice — an operator who answers the restored
   * gate consumes it just as an inheriting wait does.
   */
  gateChoiceSuppressedForGeneration?: number;
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

/**
 * Outcomes that end a transition. `in-progress` is deliberately absent: it is a
 * wait, not an answer, and adopting it reports a reconciliation that can still
 * fail as the operator's result.
 *
 * This is an allowlist rather than `!== 'in-progress'` so a new outcome added to
 * the protocol is treated as non-terminal until it is considered here. The
 * inverse defaults a new outcome to terminal on whichever client happens to
 * update last, which is the wrong direction to fail in.
 */
export const RESOURCE_POSTURE_TERMINAL_OUTCOMES: readonly ResourcePostureTransitionOutcome[] = [
  'applied',
  'idempotent',
  'partial',
  'rejected',
  'failed',
];

export function isTerminalResourcePostureOutcome(
  outcome: ResourcePostureTransitionOutcome,
): boolean {
  return RESOURCE_POSTURE_TERMINAL_OUTCOMES.includes(outcome);
}

/** How many status reads a client waits through before reporting reconciliation pending. */
export const RESOURCE_POSTURE_TRANSITION_POLL_LIMIT = 10;

/**
 * What a client knew before it sent a resolution, so the answer can be told
 * apart from what was already there.
 */
export interface ResourcePostureTransitionBaseline {
  /** Transition ids the Gateway had already recorded. */
  transitionIds: readonly string[];
  /**
   * Newest `requestedAt` among those, in the Gateway's own clock. Recency is
   * compared Gateway-to-Gateway; a client clock never enters the comparison.
   */
  newestRequestedAt: string | undefined;
  /** The gate choice the client forwarded, when it forwarded one. */
  choice: ResourcePostureGateChoice | null;
}

/** The records to correlate over, newest first, as the protocol persists them. */
export function resourcePostureTransitions(
  state: Pick<RunResourcePostureState, 'recentTransitions' | 'lastTransition'> | undefined,
): readonly ResourcePostureTransition[] {
  if (!state) return [];
  if (state.recentTransitions?.length) return state.recentTransitions;
  return state.lastTransition ? [state.lastTransition] : [];
}

export function resourcePostureTransitionBaseline(
  state: Pick<RunResourcePostureState, 'recentTransitions' | 'lastTransition'> | undefined,
  choice: ResourcePostureGateChoice | null,
): ResourcePostureTransitionBaseline {
  const known = resourcePostureTransitions(state);
  const newestRequestedAt = known
    .map((transition) => transition.requestedAt)
    .filter((requestedAt): requestedAt is string => Boolean(requestedAt))
    .reduce<string | undefined>(
      (newest, requestedAt) =>
        newest === undefined || Date.parse(requestedAt) > Date.parse(newest) ? requestedAt : newest,
      undefined,
    );
  return { transitionIds: known.map((transition) => transition.id), newestRequestedAt, choice };
}

/**
 * The transition a resolution actually produced, or `undefined` while the
 * Gateway has not recorded one yet.
 *
 * `run.resolveDecision` returns before posture reconciliation finishes, so the
 * record on its response is frequently the one from BEFORE the resolution.
 * Presenting that reports an old outcome as the answer to what the operator just
 * did. Every client applies these four rules, from this one implementation:
 *
 * 1. Novelty. A record whose id was already in the baseline is one the Gateway
 *    had before the resolution, and is never adopted.
 * 2. Recency, in Gateway time. A record must not be older than the newest
 *    `requestedAt` in the baseline. Both sides come from the Gateway, so no
 *    client clock is involved: anchoring on the client's send moment compares a
 *    phone or browser clock against the Gateway's, and a skewed client either
 *    adopts a stale record or rejects the real one forever. Not-older rather
 *    than strictly-newer, so two reconciliations in the same millisecond are not
 *    dropped; novelty already excludes the baseline itself. This rule excludes a
 *    backfilled or out-of-order record; it cannot exclude a genuinely concurrent
 *    one, which is what rule 3 is for.
 * 3. Attribution. A record attributed to a different gate choice is excluded. A
 *    record carrying no `gateChoice` is never excluded on that basis, because
 *    the Gateway drops `project-default` before it picks a policy source and
 *    genuine rejections can also arrive without one. Among the survivors, a
 *    record the Gateway attributed to this choice WINS over an unattributed one;
 *    an unattributed record is only the fallback. Without that preference a
 *    concurrent unattributed reconciliation that lands afterwards is newest and
 *    therefore chosen, which misattributes it.
 * 4. Terminality is the caller's half: `in-progress` is not an answer, so the
 *    caller keeps polling until `isTerminalResourcePostureOutcome`, bounded by
 *    `RESOURCE_POSTURE_TRANSITION_POLL_LIMIT`, and reports the wait on timeout.
 *
 * What this still cannot do: the record carries no decision key, and the
 * resolve path supplies no `operationId` for the Gateway to mint the id from, so
 * for a record with nothing attributed the correlation is positional. A
 * concurrent reconciliation from another boundary could in principle be picked
 * up. Surfaced wording must therefore describe what the run's posture did, never
 * claim the operator's choice caused it.
 */
export function correlateResourcePostureTransition(
  baseline: ResourcePostureTransitionBaseline,
  records: readonly ResourcePostureTransition[],
): ResourcePostureTransition | undefined {
  const known = new Set(baseline.transitionIds);
  const oldestAllowed = baseline.newestRequestedAt
    ? Date.parse(baseline.newestRequestedAt)
    : undefined;
  const candidates = records.filter((record) => {
    if (known.has(record.id)) return false;
    if (oldestAllowed !== undefined && Number.isFinite(oldestAllowed)) {
      const requestedAtMs = Date.parse(record.requestedAt);
      if (!Number.isFinite(requestedAtMs) || requestedAtMs < oldestAllowed) return false;
    }
    if (
      baseline.choice &&
      record.gateChoice !== undefined &&
      record.gateChoice !== baseline.choice
    ) {
      return false;
    }
    return true;
  });
  // A match the Gateway actually attributed beats one a client inferred.
  return (
    candidates.find((record) => baseline.choice && record.gateChoice === baseline.choice) ??
    candidates[0]
  );
}
