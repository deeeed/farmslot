import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import {
  familyOriginLabel,
  hasModelDrift,
  hasUsageMetrics,
  prStateColor,
  runBadgeColor,
  semanticColor,
  terminalRunEmphasisClass,
} from './family-observability-display-model.js';

function run(
  runId: string,
  overrides: Record<string, unknown> = {},
): FamilyObservabilityRunSummary {
  return {
    runId,
    familyId: 'family-demo',
    lane: 'root',
    parentRunId: null,
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-1',
    metrics: { runner: 'codex', model: 'gpt-5.5', nudgeCount: 0 },
    ...overrides,
  } as unknown as FamilyObservabilityRunSummary;
}

test('familyOriginLabel prefers family id root then parentless then first run', () => {
  assert.equal(
    familyOriginLabel({
      familyId: 'family-root',
      runs: [run('other', { lane: 'comparison' }), run('family-root', { lane: 'root' })],
    } as unknown as FamilyObservabilitySnapshot),
    'BUG',
  );

  assert.equal(
    familyOriginLabel({
      familyId: 'missing',
      runs: [run('child', { parentRunId: 'root' }), run('root', { parentRunId: null })],
    } as unknown as FamilyObservabilitySnapshot),
    'BUG',
  );

  assert.equal(familyOriginLabel({ familyId: 'empty', runs: [] }), '—');
});

test('display colors and formatting match existing UI semantics', () => {
  assert.equal(runBadgeColor(run('compare', { lane: 'comparison' })), colors.accent);
  assert.equal(terminalRunEmphasisClass('failed'), 'terminal-alert');
  assert.equal(terminalRunEmphasisClass('cancelled'), 'terminal-alert');
  assert.equal(terminalRunEmphasisClass('done'), '');
  assert.equal(semanticColor('good'), colors.statusOk);
  assert.equal(semanticColor('ok'), colors.statusWarn);
  assert.equal(semanticColor('bad'), colors.statusFail);
  assert.equal(semanticColor('unknown'), colors.textMuted);
  assert.equal(prStateColor('MERGED'), colors.statusOk);
  assert.equal(prStateColor('CLOSED'), colors.statusFail);
  assert.equal(prStateColor('OPEN'), colors.accent);
});

test('usage and model drift detection are derived from run metrics', () => {
  assert.equal(hasUsageMetrics(run('none', { metrics: undefined })), false);
  assert.equal(
    hasUsageMetrics(
      run('tokens', { metrics: { model: 'gpt-5.5', nudgeCount: 0, sessionTotalTokens: 10 } }),
    ),
    true,
  );
  assert.equal(
    hasUsageMetrics(
      run('actual-model', { metrics: { model: 'gpt-5.5', nudgeCount: 0, actualModel: 'gpt-5.5' } }),
    ),
    true,
  );
  assert.equal(
    hasModelDrift(
      run('same-model', { metrics: { model: 'gpt-5.5', nudgeCount: 0, actualModel: 'gpt-5.5' } }),
    ),
    false,
  );
  assert.equal(
    hasModelDrift(
      run('drift', { metrics: { model: 'sonnet', nudgeCount: 0, actualModel: 'opus' } }),
    ),
    true,
  );
});
