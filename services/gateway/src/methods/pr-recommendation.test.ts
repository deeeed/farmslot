// pr-recommendation.test.ts — unit tests for the pure PR recommendation
// decision functions, covering every rule branch from both the TS engine
// and the bash pr-monitor.sh rule engine (bash-decision-core-inventory.md).
//
// Functions live in @farmslot/protocol (contracts/pr-recommendation.ts);
// re-exported from ./pr.ts for backward compat.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computePRRecommendation,
  derivePRMergeState,
  isPassiveMergeWaitCandidate,
  type PRFamilyContextForRecommendation,
  type PRMergeStateParams,
  type PRRecommendationParams,
} from '@farmslot/protocol';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function baseParams(overrides: Partial<PRRecommendationParams> = {}): PRRecommendationParams {
  return {
    prState: 'OPEN',
    workerActive: false,
    anyFailed: false,
    mergeConflict: false,
    actionableCount: 0,
    allPassed: true,
    approved: true,
    familyContext: null,
    ...overrides,
  };
}

function mergeStateParams(overrides: Partial<PRMergeStateParams> = {}): PRMergeStateParams {
  return {
    prState: 'OPEN',
    familyContext: null,
    anyFailed: false,
    mergeConflict: false,
    actionableCount: 0,
    allPassed: true,
    approved: true,
    ...overrides,
  };
}

const completeFamilyContext: PRFamilyContextForRecommendation = {
  workflowState: 'complete',
  ownedPrFamily: true,
};

const activeFamilyContext: PRFamilyContextForRecommendation = {
  workflowState: 'active',
  ownedPrFamily: true,
};

const failedFamilyContext: PRFamilyContextForRecommendation = {
  workflowState: 'failed',
  ownedPrFamily: true,
};

// ─── computePRRecommendation — bash rule mapping ──────────────────────────────
// Each test corresponds to one bash pr-monitor.sh rule branch (first-match order).

test('bash rule 1: merged PR → MERGED', () => {
  assert.equal(computePRRecommendation(baseParams({ prState: 'MERGED' })), 'MERGED');
});

test('bash rule 1: merged PR with active worker → WORKING (intentional TS/bash ordering diff)', () => {
  // TS checks workerActive first; bash checks MERGED/CLOSED first.
  // In practice, a worker rarely stays alive after merge, but callers must
  // use PRStatus.merged to detect this edge case in formatters.
  assert.equal(
    computePRRecommendation(baseParams({ prState: 'MERGED', workerActive: true })),
    'WORKING',
  );
});

test('bash rule 2: closed PR → CLOSED_WITHOUT_MERGE', () => {
  assert.equal(computePRRecommendation(baseParams({ prState: 'CLOSED' })), 'CLOSED_WITHOUT_MERGE');
});

test('bash rule 2: closed PR with active worker → WORKING (intentional TS/bash ordering diff)', () => {
  assert.equal(
    computePRRecommendation(baseParams({ prState: 'CLOSED', workerActive: true })),
    'WORKING',
  );
});

test('bash rule 3+4: merge conflict + worker dead → NEEDS_ATTENTION', () => {
  // Bash "MERGE CONFLICT (action needed)" maps to TS NEEDS_ATTENTION.
  assert.equal(
    computePRRecommendation(baseParams({ mergeConflict: true, workerActive: false })),
    'NEEDS_ATTENTION',
  );
});

test('bash rule 3: merge conflict + worker alive → WORKING (TS workerActive-first ordering)', () => {
  // Bash "MERGE CONFLICT (worker active)": bash keeps this as a MERGE CONFLICT sub-case.
  // TS checks workerActive before mergeConflict, so it returns WORKING.
  // The formatter derives the detail string using PRStatus.workerActive + PRStatus.mergeConflict.
  assert.equal(
    computePRRecommendation(baseParams({ mergeConflict: true, workerActive: true })),
    'WORKING',
  );
});

test('bash rule 8+9: CI failed + worker dead → NEEDS_ATTENTION', () => {
  // Bash "CI FAILED (action needed)" maps to TS NEEDS_ATTENTION.
  assert.equal(
    computePRRecommendation(baseParams({ anyFailed: true, workerActive: false })),
    'NEEDS_ATTENTION',
  );
});

test('bash rule 9: CI failed + worker alive → WORKING (TS workerActive-first ordering)', () => {
  // Bash "CI FAILED (worker active)": TS returns WORKING due to workerActive-first check.
  assert.equal(
    computePRRecommendation(baseParams({ anyFailed: true, workerActive: true })),
    'WORKING',
  );
});

test('bash rule 6+7: actionable comments + worker dead → NEEDS_ATTENTION', () => {
  // Bash "COMMENTS (action needed)" maps to TS NEEDS_ATTENTION.
  assert.equal(
    computePRRecommendation(baseParams({ actionableCount: 3, workerActive: false })),
    'NEEDS_ATTENTION',
  );
});

test('bash rule 7: actionable comments + worker alive → WORKING (TS workerActive-first ordering)', () => {
  // Bash "COMMENTS (worker active)": TS returns WORKING due to workerActive-first check.
  assert.equal(
    computePRRecommendation(baseParams({ actionableCount: 3, workerActive: true })),
    'WORKING',
  );
});

test('bash rule 5: all passed, no actionable, no approval → READY (bash omits approval check, TS requires it)', () => {
  // Bash: all_passed && !has_actionable → READY.
  // TS:   allPassed && approved && actionableCount==0 → READY.
  // INTENTIONAL DIFFERENCE: TS is stricter (requires approved=true).
  // Without approval, TS falls to IN_REVIEW even if all checks pass.
  assert.equal(
    computePRRecommendation(baseParams({ allPassed: true, approved: true, actionableCount: 0 })),
    'READY',
  );
  assert.equal(
    computePRRecommendation(baseParams({ allPassed: true, approved: false, actionableCount: 0 })),
    'IN_REVIEW', // TS stricter than bash here
  );
});

test('worker active → WORKING (highest priority after merged/closed in bash; first in TS)', () => {
  // Any open PR with a live worker → WORKING.
  assert.equal(computePRRecommendation(baseParams({ workerActive: true })), 'WORKING');
  // Worker active overrides any blocker signal in TS.
  assert.equal(
    computePRRecommendation(baseParams({ workerActive: true, anyFailed: true })),
    'WORKING',
  );
  assert.equal(
    computePRRecommendation(baseParams({ workerActive: true, mergeConflict: true })),
    'WORKING',
  );
});

test('bash rule 10 / IN_REVIEW: CI pending, no issues, not yet approved', () => {
  // Bash: PENDING. TS: IN_REVIEW. Different label, same semantic.
  assert.equal(
    computePRRecommendation(baseParams({ allPassed: false, approved: false })),
    'IN_REVIEW',
  );
});

test('bash rule 10 / IN_REVIEW: CI pending with no actionable comments', () => {
  assert.equal(
    computePRRecommendation(baseParams({ allPassed: false, approved: true, actionableCount: 0 })),
    'IN_REVIEW',
  );
});

test('WAITING_FOR_MERGE: complete owned family + clean open PR', () => {
  assert.equal(
    computePRRecommendation(
      baseParams({ familyContext: completeFamilyContext, allPassed: true, approved: true }),
    ),
    'WAITING_FOR_MERGE',
  );
});

test('WAITING_FOR_MERGE blocked by CI failure', () => {
  assert.equal(
    computePRRecommendation(
      baseParams({
        familyContext: completeFamilyContext,
        allPassed: false,
        anyFailed: true,
        approved: true,
      }),
    ),
    'NEEDS_ATTENTION',
  );
});

test('WAITING_FOR_MERGE blocked by merge conflict', () => {
  assert.equal(
    computePRRecommendation(
      baseParams({ familyContext: completeFamilyContext, mergeConflict: true }),
    ),
    'NEEDS_ATTENTION',
  );
});

test('WAITING_FOR_MERGE blocked by actionable comments', () => {
  assert.equal(
    computePRRecommendation(
      baseParams({ familyContext: completeFamilyContext, actionableCount: 1 }),
    ),
    'NEEDS_ATTENTION',
  );
});

test('WAITING_FOR_MERGE requires workflowState=complete', () => {
  assert.equal(
    computePRRecommendation(
      baseParams({ familyContext: activeFamilyContext, allPassed: true, approved: true }),
    ),
    'READY', // active family but workflow not done yet
  );
  assert.equal(
    computePRRecommendation(
      baseParams({ familyContext: failedFamilyContext, allPassed: true, approved: true }),
    ),
    'READY',
  );
});

test('NEEDS_ATTENTION: multiple signals — merge conflict dominates in NEEDS_ATTENTION', () => {
  // All three blockers at once → still NEEDS_ATTENTION.
  assert.equal(
    computePRRecommendation(
      baseParams({ mergeConflict: true, anyFailed: true, actionableCount: 5 }),
    ),
    'NEEDS_ATTENTION',
  );
});

// ─── isPassiveMergeWaitCandidate ─────────────────────────────────────────────

test('isPassiveMergeWaitCandidate: full happy path', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(mergeStateParams({ familyContext: completeFamilyContext })),
    true,
  );
});

test('isPassiveMergeWaitCandidate: no family context → false', () => {
  assert.equal(isPassiveMergeWaitCandidate(mergeStateParams({ familyContext: null })), false);
});

test('isPassiveMergeWaitCandidate: workflow not complete → false', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(mergeStateParams({ familyContext: activeFamilyContext })),
    false,
  );
  assert.equal(
    isPassiveMergeWaitCandidate(mergeStateParams({ familyContext: failedFamilyContext })),
    false,
  );
});

test('isPassiveMergeWaitCandidate: CI not all passed → false', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(
      mergeStateParams({ familyContext: completeFamilyContext, allPassed: false }),
    ),
    false,
  );
});

test('isPassiveMergeWaitCandidate: not approved → false', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(
      mergeStateParams({ familyContext: completeFamilyContext, approved: false }),
    ),
    false,
  );
});

test('isPassiveMergeWaitCandidate: merge conflict → false', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(
      mergeStateParams({ familyContext: completeFamilyContext, mergeConflict: true }),
    ),
    false,
  );
});

test('isPassiveMergeWaitCandidate: CI failed → false', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(
      mergeStateParams({ familyContext: completeFamilyContext, anyFailed: true }),
    ),
    false,
  );
});

test('isPassiveMergeWaitCandidate: actionable comments → false', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(
      mergeStateParams({ familyContext: completeFamilyContext, actionableCount: 1 }),
    ),
    false,
  );
});

test('isPassiveMergeWaitCandidate: PR already merged → false (prState check)', () => {
  assert.equal(
    isPassiveMergeWaitCandidate(
      mergeStateParams({ familyContext: completeFamilyContext, prState: 'MERGED' }),
    ),
    false,
  );
});

// ─── derivePRMergeState ───────────────────────────────────────────────────────

test('derivePRMergeState: no family context → not_applicable', () => {
  assert.equal(derivePRMergeState(mergeStateParams({ familyContext: null })), 'not_applicable');
});

test('derivePRMergeState: MERGED → merged', () => {
  assert.equal(
    derivePRMergeState(
      mergeStateParams({ familyContext: completeFamilyContext, prState: 'MERGED' }),
    ),
    'merged',
  );
});

test('derivePRMergeState: CLOSED → closed_without_merge', () => {
  assert.equal(
    derivePRMergeState(
      mergeStateParams({ familyContext: completeFamilyContext, prState: 'CLOSED' }),
    ),
    'closed_without_merge',
  );
});

test('derivePRMergeState: complete family + clean OPEN → waiting_for_merge', () => {
  assert.equal(
    derivePRMergeState(mergeStateParams({ familyContext: completeFamilyContext })),
    'waiting_for_merge',
  );
});

test('derivePRMergeState: active family + clean OPEN → not_applicable', () => {
  assert.equal(
    derivePRMergeState(mergeStateParams({ familyContext: activeFamilyContext })),
    'not_applicable',
  );
});

test('derivePRMergeState: complete family but CI failed → not_applicable', () => {
  assert.equal(
    derivePRMergeState(mergeStateParams({ familyContext: completeFamilyContext, anyFailed: true })),
    'not_applicable',
  );
});

// ─── First-match ordering verification ────────────────────────────────────────

test('first-match: workerActive beats NEEDS_ATTENTION triggers in TS ordering', () => {
  // Confirmed ordering: workerActive → WORKING before any NEEDS_ATTENTION check.
  const withWorker = baseParams({ workerActive: true, mergeConflict: true, anyFailed: true });
  assert.equal(computePRRecommendation(withWorker), 'WORKING');
});

test('first-match: MERGED beats NEEDS_ATTENTION when worker not active', () => {
  assert.equal(
    computePRRecommendation(
      baseParams({ prState: 'MERGED', mergeConflict: true, anyFailed: true }),
    ),
    'MERGED',
  );
});

test('first-match: mergeConflict evaluated before anyFailed', () => {
  // Both present: mergeConflict is listed first in computePRRecommendation.
  // Both collapse to NEEDS_ATTENTION so ordering only matters if we later
  // add sub-values; verify the function is stable under both-true.
  assert.equal(
    computePRRecommendation(baseParams({ mergeConflict: true, anyFailed: true })),
    'NEEDS_ATTENTION',
  );
});

test('first-match: NEEDS_ATTENTION beats WAITING_FOR_MERGE when conflict present', () => {
  // Family context is complete, but merge conflict blocks merge-wait.
  assert.equal(
    computePRRecommendation(
      baseParams({ familyContext: completeFamilyContext, mergeConflict: true }),
    ),
    'NEEDS_ATTENTION',
  );
});

test('first-match: READY beats IN_REVIEW when all passed and approved', () => {
  assert.equal(computePRRecommendation(baseParams({ allPassed: true, approved: true })), 'READY');
});
