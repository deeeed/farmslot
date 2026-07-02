import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunCreateParams } from '@farmslot/protocol';

import { applyComparisonBranchPolicy, branchIncludesVariant } from './comparison-branch-policy.js';

function comparisonParams(overrides: Partial<RunCreateParams> = {}): RunCreateParams {
  return {
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'deeeed/farmslot#28',
    lane: 'comparison',
    variant: 'codex',
    mode: 'autonomous',
    completionPolicy: 'artifact-only',
    startRef: 'main',
    ...overrides,
  };
}

test('branchIncludesVariant matches variant suffix', () => {
  assert.equal(branchIncludesVariant('dev/28-codex', 'codex'), true);
  assert.equal(branchIncludesVariant('feat/28-add-demo-red-banner', 'codex'), false);
});

test('applyComparisonBranchPolicy auto-derives branch when omitted', () => {
  const params = comparisonParams({ branch: undefined });
  applyComparisonBranchPolicy(params);
  assert.match(params.branch ?? '', /codex$/);
});

test('applyComparisonBranchPolicy rejects shared production branch', () => {
  assert.throws(
    () =>
      applyComparisonBranchPolicy(
        comparisonParams({ branch: 'feat/28-add-demo-red-banner', variant: 'grok' }),
      ),
    /does not distinguish variant/,
  );
});

test('applyComparisonBranchPolicy allows variant-distinguishable branch', () => {
  const params = comparisonParams({ branch: 'dev/28-grok', variant: 'grok' });
  applyComparisonBranchPolicy(params);
  assert.equal(params.branch, 'dev/28-grok');
});

test('applyComparisonBranchPolicy derives branch for collision-suffixed comparison variant', () => {
  const params = comparisonParams({
    variant: 'grok-grok-build-collision-114730',
    branch: undefined,
  });
  applyComparisonBranchPolicy(params);
  assert.match(params.branch ?? '', /grok-grok-build-collision-114730/);
});

test('applyComparisonBranchPolicy rejects stale branch after collision variant suffix', () => {
  assert.throws(
    () =>
      applyComparisonBranchPolicy(
        comparisonParams({
          variant: 'grok-grok-build-collision-114730',
          branch: 'feat/28-grok-grok-build',
        }),
      ),
    /does not distinguish variant/,
  );
});
