/**
 * Run resource posture summary for Companion Run Detail (ADR-054, deliverable 8).
 *
 * Everything here reads `runtime.posture.status` as the Gateway returned it. The
 * Gateway owns the policy: this module never decides what should be retained,
 * warm, or stopped, and never infers a posture from run status or step names.
 *
 * The comparisons that must match Command Center and the CLI — desired against
 * observed, the observed-state counts, which transition failures are already
 * reported on a capability — come from `@farmslot/protocol`. Re-deriving any of
 * them here is exactly the drift those shared helpers exist to prevent; a
 * provider's `observedState` likewise arrives already derived through
 * `observedStateForLease` and is read, never recomputed. What stays local is
 * presentation: operator wording and the compact lines a phone screen has room
 * for.
 */
import {
  type ResourcePosture,
  type ResourcePostureCapabilityState,
  type ResourcePostureCounts,
  resourcePostureCounts,
  type ResourcePostureDesiredDisposition,
  type ResourcePostureGateChoice,
  type ResourcePostureObservedState,
  type ResourcePosturePolicySource,
  type ResourcePostureRejection,
  type ResourcePostureRowStatus,
  resourcePostureRowStatus,
  type ResourcePostureTransition,
  type ResourcePostureTransitionFailure,
  resourcePostureTransitionFailuresToShow,
  type ResourcePostureTransitionOutcome,
  type ResourcePostureWaitPolicy,
  type RunResourcePostureState,
} from '@farmslot/protocol';

/**
 * Fetch state for `runtime.posture.status`. `error` is a state of its own so an
 * unreadable status is never rendered as "this run holds nothing".
 */
export interface RunPostureStatusState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  slotId?: string | null;
  state?: RunResourcePostureState;
  message?: string;
}

export function postureLabel(posture: ResourcePosture): string {
  if (posture === 'operator-wait') return 'Operator wait';
  if (posture === 'terminal') return 'Terminal';
  if (posture === 'parked') return 'Parked';
  return 'Active';
}

export function policySourceLabel(source: ResourcePosturePolicySource): string {
  if (source === 'gate-choice') return 'operator gate choice';
  if (source === 'run-dispatch') return 'run dispatch config';
  if (source === 'project-default') return 'project default';
  return 'framework default';
}

export function dispositionLabel(disposition: ResourcePostureDesiredDisposition): string {
  if (disposition === 'acquired') return 'retained';
  if (disposition === 'warm') return 'warm';
  return 'stopped';
}

export function transitionOutcomeLabel(outcome: ResourcePostureTransitionOutcome): string {
  if (outcome === 'in-progress') return 'in progress';
  if (outcome === 'idempotent') return 'no change needed';
  if (outcome === 'partial') return 'partially applied';
  return outcome;
}

export function rejectionMessage(rejection: ResourcePostureRejection): string {
  if (rejection.kind === 'park-ineligible') {
    return `Rejected — the run cannot be parked (${rejection.code}): ${rejection.reason}`;
  }
  if (rejection.kind === 'capability-unavailable') {
    return `Rejected — ${rejection.capabilityId} is unavailable: ${rejection.reason}`;
  }
  return `Rejected — ${rejection.reason}`;
}

export function postureRowStatusLabel(rowStatus: ResourcePostureRowStatus): string {
  if (rowStatus === 'matches') return 'as intended';
  if (rowStatus === 'mismatch') return 'does not match intent';
  if (rowStatus === 'pending') return 'transition in flight';
  return 'not observed';
}

export interface RunPostureCapabilityRow {
  capabilityId: string;
  desiredDisposition: ResourcePostureDesiredDisposition;
  desiredLabel: string;
  observedState: ResourcePostureObservedState;
  rowStatus: ResourcePostureRowStatus;
  rowStatusLabel: string;
  reason: string;
  policySource: ResourcePosturePolicySource;
  warmUntil?: string;
  cleanupFailure?: string;
  releaseEffects: string[];
}

export function postureCapabilityRow(
  state: ResourcePostureCapabilityState,
): RunPostureCapabilityRow {
  const rowStatus = resourcePostureRowStatus(state.desiredDisposition, state.observedState);
  return {
    capabilityId: state.capabilityId,
    desiredDisposition: state.desiredDisposition,
    desiredLabel: dispositionLabel(state.desiredDisposition),
    observedState: state.observedState,
    rowStatus,
    rowStatusLabel: postureRowStatusLabel(rowStatus),
    reason: state.reason,
    policySource: state.policySource,
    ...(state.warmUntil ? { warmUntil: state.warmUntil } : {}),
    ...(state.cleanupFailure ? { cleanupFailure: state.cleanupFailure } : {}),
    releaseEffects: state.releaseEffects,
  };
}

export interface RunPostureSummary {
  posture: ResourcePosture;
  postureLabel: string;
  policySource: ResourcePosturePolicySource;
  policySourceLabel: string;
  gateChoice?: ResourcePostureGateChoice;
  waitPolicy?: ResourcePostureWaitPolicy;
  workerRetained: boolean;
  /**
   * Observed-provider counts from the shared protocol derivation, so Companion
   * cannot report "1 stopped" for a provider Command Center calls unresolved.
   */
  counts: ResourcePostureCounts;
  rows: RunPostureCapabilityRow[];
  lastTransition?: ResourcePostureTransition;
  /** Transition failures not already carried on a capability row. */
  unreportedFailures: ResourcePostureTransitionFailure[];
  updatedAt: string;
}

export function summarizeRunPosture(state: RunResourcePostureState): RunPostureSummary {
  return {
    posture: state.posture,
    postureLabel: postureLabel(state.posture),
    policySource: state.policySource,
    policySourceLabel: policySourceLabel(state.policySource),
    ...(state.gateChoice ? { gateChoice: state.gateChoice } : {}),
    ...(state.waitPolicy ? { waitPolicy: state.waitPolicy } : {}),
    workerRetained: state.workerRetained,
    counts: resourcePostureCounts(state.capabilities, state.lastTransition),
    rows: state.capabilities.map(postureCapabilityRow),
    ...(state.lastTransition ? { lastTransition: state.lastTransition } : {}),
    unreportedFailures: resourcePostureTransitionFailuresToShow(
      state.capabilities,
      state.lastTransition,
    ),
    updatedAt: state.updatedAt,
  };
}

/**
 * The compact one-line count summary Run Detail leads with. `unresolved` is
 * appended only when it is non-zero, so the common case stays four numbers wide
 * on a phone while a capability the Gateway could not place is never hidden.
 */
export function postureCountsLine(counts: ResourcePostureCounts): string {
  const base = `${counts.retained} retained · ${counts.warm} warm · ${counts.stopped} stopped · ${counts.failed} failed`;
  return counts.unresolved ? `${base} · ${counts.unresolved} unresolved` : base;
}

/** The policy line: which precedence level won, plus the choice or preset behind it. */
export function posturePolicyLine(summary: RunPostureSummary): string {
  const parts = [`policy from ${summary.policySourceLabel}`];
  if (summary.gateChoice) parts.push(`choice ${summary.gateChoice}`);
  if (summary.waitPolicy) parts.push(`dispatch preset ${summary.waitPolicy}`);
  return parts.join(' · ');
}

/** Last transition, stated as an outcome with its progress rather than a status word. */
export function postureTransitionLine(transition: ResourcePostureTransition): string {
  return `Last transition to ${postureLabel(transition.posture)}: ${transitionOutcomeLabel(
    transition.outcome,
  )} · ${transition.progress.completed}/${transition.progress.total} steps`;
}
