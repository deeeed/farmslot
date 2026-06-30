import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyObservabilityRunSummary, GateSummary } from '@farmslot/protocol';

import { runGateSummary } from './family-observability-comparison-renderers.js';

const GATE_SUMMARY = {
  kind: 'publication',
  worker: { model: 'gpt-5.5', turns: 159 },
  tokens: { byModel: [{ model: 'gpt-5.5', input: 1000, output: 50, total: 1050, turns: 159 }] },
} as unknown as GateSummary;

function runSummary(
  decisions: FamilyObservabilityRunSummary['decisions'],
): FamilyObservabilityRunSummary {
  return { runId: 'run-1', decisions } as unknown as FamilyObservabilityRunSummary;
}

test('runGateSummary extracts gateSummary from a ready decision', () => {
  const run = runSummary([
    { id: 'd1', type: 'engine_human_gate', payload: { kind: 'ready', gateSummary: GATE_SUMMARY } },
  ] as unknown as FamilyObservabilityRunSummary['decisions']);
  assert.equal(runGateSummary(run), GATE_SUMMARY);
});

test('runGateSummary returns undefined when no decision carries one', () => {
  const run = runSummary([
    { id: 'd1', type: 'engine_human_gate', payload: { kind: 'ready' } },
  ] as unknown as FamilyObservabilityRunSummary['decisions']);
  assert.equal(runGateSummary(run), undefined);
  assert.equal(runGateSummary(runSummary(undefined)), undefined);
});
