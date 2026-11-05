import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyObservabilityTokenSummary } from '@farmslot/protocol';

import { familyTokenMetricLabel } from './family-observability-token-model.js';

function summary(
  overrides: Partial<FamilyObservabilityTokenSummary> = {},
): FamilyObservabilityTokenSummary {
  return {
    familyTotalTokens: 0,
    familyTotalCostEstimate: null,
    runsWithMetrics: 0,
    runsMissingMetrics: 1,
    missingRunIds: ['fd766283-5998-455d-9252-bca6342022ea'],
    runPoints: [],
    milestoneRunPoints: [],
    byModel: [],
    ...overrides,
  };
}

test('F411 absent capture is not displayed as a measured family zero', () => {
  assert.equal(familyTokenMetricLabel(summary()), 'not captured');
});

test('a verified zero stays zero and a partial family preserves its measured subtotal', () => {
  assert.equal(familyTokenMetricLabel(summary({ runsWithMetrics: 1, runsMissingMetrics: 0 })), '0');
  assert.equal(
    familyTokenMetricLabel(summary({ runsWithMetrics: 1, familyTotalTokens: 40_101_451 })),
    '40.1M',
  );
});

test('helper-only capture does not depend on worker/reviewer metric counts', () => {
  assert.equal(familyTokenMetricLabel(summary({ familyTotalTokens: 7 })), '7');
  assert.equal(familyTokenMetricLabel(summary(), true), '0');
});
