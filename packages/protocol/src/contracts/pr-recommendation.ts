// pr-recommendation.ts — pure decision functions for PR recommendation.
// Canonical home for computePRRecommendation, isPassiveMergeWaitCandidate,
// and derivePRMergeState, shared by gateway (methods/pr.ts), CLI internal
// verbs, and tests without importing services/gateway.
//
// Ported from services/gateway/src/methods/pr.ts as part of the Phase 4 CLI
// overhaul (bash-decision-core-inventory.md item 4: reconcile pr-monitor.sh
// rules with computePRRecommendation).

import type { PRFamilyMergeState, PRFamilyWorkflowState, PRRecommendation } from './reviews.js';

/**
 * Minimal family context consumed by recommendation + merge-state functions.
 * The gateway's PRFamilyContext is a superset of this; structural typing
 * means any PRFamilyContext satisfies PRFamilyContextForRecommendation.
 */
export interface PRFamilyContextForRecommendation {
  workflowState: PRFamilyWorkflowState;
  ownedPrFamily: boolean;
}

export interface PRRecommendationParams {
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  workerActive: boolean;
  anyFailed: boolean;
  mergeConflict: boolean;
  actionableCount: number;
  allPassed: boolean;
  approved: boolean;
  familyContext: PRFamilyContextForRecommendation | null;
}

export interface PRMergeStateParams {
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  familyContext: PRFamilyContextForRecommendation | null;
  anyFailed: boolean;
  mergeConflict: boolean;
  actionableCount: number;
  allPassed: boolean;
  approved: boolean;
}

/**
 * Returns true when the PR is in a "passive merge wait" state: the workflow
 * is complete, CI has passed, the PR is approved, and there are no blockers.
 * The operator just needs to click Merge (or enable auto-merge).
 *
 * NOTE: prState='OPEN' is intentional — the PR has not merged yet but is
 * fully ready. Callers filter familyContext to ownedPrFamily=true before
 * passing it here.
 */
export function isPassiveMergeWaitCandidate(params: PRMergeStateParams): boolean {
  return Boolean(
    params.familyContext &&
    params.prState === 'OPEN' &&
    params.familyContext.workflowState === 'complete' &&
    !params.anyFailed &&
    !params.mergeConflict &&
    params.actionableCount === 0 &&
    params.allPassed &&
    params.approved,
  );
}

export function derivePRMergeState(params: PRMergeStateParams): PRFamilyMergeState {
  if (!params.familyContext) return 'not_applicable';
  if (params.prState === 'MERGED') return 'merged';
  if (params.prState === 'CLOSED') return 'closed_without_merge';
  return isPassiveMergeWaitCandidate(params) ? 'waiting_for_merge' : 'not_applicable';
}

/**
 * First-match rule engine mapping PR state to a recommendation.
 *
 * Rule ordering vs. pr-monitor.sh (bash):
 *   INTENTIONAL DIFFERENCE — workerActive is evaluated first (before
 *   MERGED/CLOSED). Bash checks MERGED/CLOSED first, then worker-active
 *   within sub-cases. The TS ordering surfaces the live worker sooner in
 *   the UI; MERGED/CLOSED slots with an active worker are handled by
 *   the pr-monitor.sh formatter using the merged/prState PRStatus fields.
 *
 * Rule ordering vs. bash rule engine (first-match order, bash → TS):
 *   merged                   → MERGED            (bash: MERGED)
 *   pr_state=CLOSED          → CLOSED_WITHOUT_MERGE (bash: CLOSED)
 *   merge_conflict           → NEEDS_ATTENTION   (bash: MERGE CONFLICT [worker-active|action-needed])
 *   any_failed               → NEEDS_ATTENTION   (bash: CI FAILED [worker-active|action-needed])
 *   has_actionable           → NEEDS_ATTENTION   (bash: COMMENTS [worker-active|action-needed])
 *   all_passed && !actionable → READY/WAITING   (bash: READY)
 *   else                     → IN_REVIEW         (bash: PENDING)
 *
 * The bash sub-classifications (worker-active vs action-needed within each
 * NEEDS_ATTENTION case) are visible in PRStatus.workerActive + the individual
 * boolean fields (mergeConflict, anyFailed, actionableBotComments) so
 * formatters can still derive the bash-style detail strings.
 */
export function computePRRecommendation(params: PRRecommendationParams): PRRecommendation {
  if (params.workerActive) return 'WORKING';
  if (params.prState === 'MERGED') return 'MERGED';
  if (params.prState === 'CLOSED') return 'CLOSED_WITHOUT_MERGE';
  if (params.mergeConflict) return 'NEEDS_ATTENTION';
  if (params.anyFailed) return 'NEEDS_ATTENTION';
  if (params.actionableCount > 0) return 'NEEDS_ATTENTION';
  if (
    isPassiveMergeWaitCandidate({
      prState: params.prState,
      familyContext: params.familyContext,
      anyFailed: params.anyFailed,
      mergeConflict: params.mergeConflict,
      actionableCount: params.actionableCount,
      allPassed: params.allPassed,
      approved: params.approved,
    })
  )
    return 'WAITING_FOR_MERGE';
  if (params.allPassed && params.approved && params.actionableCount === 0) return 'READY';
  return 'IN_REVIEW';
}
