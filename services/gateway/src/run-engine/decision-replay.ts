import type { DecisionAction, FlowType, RunDecision } from '@farmslot/protocol';

import { APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION, CLOSE_AS_SHIPPED_ACTION } from './gate-policy.js';

const HUMAN_GATE_APPROVAL_ACTIONS = new Set([
  'approve-publish',
  APPROVE_PUBLISH_EVIDENCE_REFRESH_ACTION,
  'ready',
  'post',
  // Close-as-shipped resolves the gate terminally (work already merged); finalize
  // must see it via latestResolvedHumanGateDecision(_, true) to take its bypass.
  CLOSE_AS_SHIPPED_ACTION,
]);
const HUMAN_GATE_REVIEW_REQUEST_ACTIONS = new Set([
  'request-extra-review',
  'request-cross-runner-review',
]);
const HUMAN_GATE_REVIEW_REQUEST_CONSUMED_CONTEXT_KEY = 'reviewRequestConsumedAt';

export function latestResolvedHumanGateDecision(
  decisions: RunDecision[],
  approvalOnly = false,
): RunDecision | undefined {
  return decisions
    .filter(
      (decision) =>
        decision.type === 'engine_human_gate' &&
        !!decision.resolvedAt &&
        (!approvalOnly || HUMAN_GATE_APPROVAL_ACTIONS.has(decision.resolvedAction ?? '')),
    )
    .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))[0];
}

function isHumanGateReviewRequestAction(actionId: string | undefined): boolean {
  return HUMAN_GATE_REVIEW_REQUEST_ACTIONS.has(actionId ?? '');
}

export function isReplayableResolvedHumanGateDecision(
  decision: RunDecision,
  actions: DecisionAction[] = [],
): boolean {
  const actionId = decision.resolvedAction;
  if (!actionId) return false;
  if (actions.length > 0 && !actions.some((action) => action.id === actionId)) return false;
  if (HUMAN_GATE_APPROVAL_ACTIONS.has(actionId)) return true;
  if (!isHumanGateReviewRequestAction(actionId)) return false;
  return typeof decision.context?.[HUMAN_GATE_REVIEW_REQUEST_CONSUMED_CONTEXT_KEY] !== 'string';
}

export function markResolvedHumanGateReviewRequestConsumed(
  decision: RunDecision | undefined,
  consumedAt = new Date().toISOString(),
): boolean {
  if (!decision || !isHumanGateReviewRequestAction(decision.resolvedAction)) return false;
  if (typeof decision.context?.[HUMAN_GATE_REVIEW_REQUEST_CONSUMED_CONTEXT_KEY] === 'string') {
    return false;
  }
  decision.context = {
    ...(decision.context ?? {}),
    [HUMAN_GATE_REVIEW_REQUEST_CONSUMED_CONTEXT_KEY]: consumedAt,
  };
  return true;
}

/**
 * Walk a decisions list newest-first and return the latest resolved decision
 * matching `engine_${reason}`. Extracted from createEngineDecision so the
 * "newest-first" invariant is unit-testable — picking the oldest match would
 * silently break payload-aware replay (a canReplay-rejected prior decision
 * gets a new resolution appended; subsequent dedup must see the new one).
 */
export function findLatestResolvedDecision(
  decisions: RunDecision[],
  reason: string,
): RunDecision | undefined {
  const expectedType = `engine_${reason}`;
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (d.type === expectedType && d.resolvedAt) return d;
  }
  return undefined;
}

/**
 * Single source of truth for which flows should pay the task-dir collision
 * precheck. Maintenance flows (merge-main, pr-complete) intentionally reuse
 * the prior task dir for an existing PR — colliding on them is the *point*.
 * Pulled into a helper so the FIND_SLOT precheck and the WRITE_TASK
 * skipCollisionCheck branch can't drift if a new flow is added to one site
 * but not the other.
 *
 * Note: `merge-main` has no FIND_SLOT step today (see FLOW_STEPS), so the
 * in-FIND_SLOT short-circuit is defensive against future FLOW_STEPS changes
 * — keep the predicate aligned with WRITE_TASK rather than narrowing it here.
 */
export function requiresCollisionPrecheck(flowType: FlowType): boolean {
  return flowType !== 'merge-main' && flowType !== 'pr-complete';
}

/**
 * Pure predicate extracted so the payload-aware dedup is testable without
 * spinning up the engine. Returns true when a prior resolved collision decision
 * can be auto-replayed against the same set of colliding dirs, false when a new
 * dir appeared (operator must re-confirm).
 */
export function canReplayCollisionDecision(
  prior: RunDecision,
  currentExistingDirs: string[],
): boolean {
  const p = prior.payload;
  if (!p || p.kind !== 'collision') return true;
  const currentKey = [...currentExistingDirs].sort().join('|');
  const priorKey = [...p.existingDirs].sort().join('|');
  return priorKey === currentKey;
}
