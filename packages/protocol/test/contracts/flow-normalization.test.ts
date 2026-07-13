import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRANCH_UPDATE_STRATEGIES,
  FLOW_STEPS,
  FLOW_WORKER_REPORT_ARTIFACTS,
  isBranchUpdateStrategy,
  normalizeCiActionId,
  normalizeFlowType,
  resolveBranchUpdateStrategy,
} from '../../src/contracts/runs.js';

test('normalizeFlowType maps legacy branch-maintenance flow to update-branch', () => {
  assert.equal(normalizeFlowType('merge-main'), 'update-branch');
});

test('normalizeFlowType maps legacy feature flow to dev', () => {
  assert.equal(normalizeFlowType('feature'), 'dev');
});

test('normalizeFlowType passes through current flow types unchanged', () => {
  for (const flow of ['fix-bug', 'review-pr', 'dev', 'pr-complete', 'update-branch'] as const) {
    assert.equal(normalizeFlowType(flow), flow);
  }
});

test('normalizeFlowType falls back to fix-bug for nullish input', () => {
  assert.equal(normalizeFlowType(undefined), 'fix-bug');
  assert.equal(normalizeFlowType(null), 'fix-bug');
});

test('normalizeCiActionId renames the legacy merge-conflict dispatch action', () => {
  assert.equal(normalizeCiActionId('dispatch-merge-main'), 'dispatch-update-branch');
  assert.equal(normalizeCiActionId('dispatch-pr-complete'), 'dispatch-pr-complete');
  assert.equal(normalizeCiActionId('retry'), 'retry');
});

test('update-branch is a first-class flow with steps and outcome artifacts', () => {
  assert.ok(FLOW_STEPS['update-branch'].length > 0);
  assert.deepEqual(FLOW_WORKER_REPORT_ARTIFACTS['update-branch'], [
    'branch-update-report.md',
    'report.md',
  ]);
  assert.equal((FLOW_STEPS as Record<string, unknown>)['merge-main'], undefined);
});

test('isBranchUpdateStrategy accepts only the three strategy values', () => {
  for (const strategy of BRANCH_UPDATE_STRATEGIES) {
    assert.ok(isBranchUpdateStrategy(strategy));
  }
  assert.equal(isBranchUpdateStrategy('force'), false);
  assert.equal(isBranchUpdateStrategy(undefined), false);
});

test('resolveBranchUpdateStrategy prefers rebase and downgrades when force-push disallowed', () => {
  // default (undefined) defers to project policy
  assert.equal(resolveBranchUpdateStrategy(undefined), undefined);
  assert.equal(resolveBranchUpdateStrategy('project-default'), undefined);
  // rebase stays rebase when force-push allowed / unknown
  assert.equal(resolveBranchUpdateStrategy('rebase'), 'rebase');
  assert.equal(resolveBranchUpdateStrategy('rebase', { allowForcePush: true }), 'rebase');
  // rebase downgrades to merge when the project disallows force-push
  assert.equal(resolveBranchUpdateStrategy('rebase', { allowForcePush: false }), 'merge');
  // explicit merge is always honored
  assert.equal(resolveBranchUpdateStrategy('merge', { allowForcePush: false }), 'merge');
});
