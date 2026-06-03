import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run, RunStep } from '@farmslot/protocol';

import {
  extractStepCostInfo,
  stepArtifactsForRunStep,
  stepArtifactUrl,
  stepDurationLabel,
} from './step-inspector-model.js';

test('stepDurationLabel formats completed and running step durations', () => {
  assert.equal(stepDurationLabel({ durationMs: 90_000 } as RunStep, Date.now()), '1m 30s');
  assert.equal(
    stepDurationLabel(
      { status: 'running', startedAt: '2026-06-01T00:00:00.000Z' } as RunStep,
      Date.parse('2026-06-01T00:01:30.000Z'),
    ),
    'elapsed 1m 30s',
  );
});

test('extractStepCostInfo preserves direct, llm, and run-level cost shapes', () => {
  assert.deepEqual(
    extractStepCostInfo({
      name: 'grade',
      status: 'done',
      outputs: {
        costUsd: 1.25,
        session: { inputTokens: 1000, outputTokens: 250, model: 'sonnet', numTurns: 3 },
      },
    } as RunStep),
    { cost: '$1.25', tokens: '1,000 in / 250 out', model: 'sonnet', extra: '3 turns' },
  );
  assert.deepEqual(
    extractStepCostInfo({
      name: 'grade',
      status: 'done',
      outputs: { llm: { costUsd: 0.0123, inputTokens: 11, outputTokens: 22, model: 'mini' } },
    } as RunStep),
    { cost: '$0.0123', tokens: '11 in / 22 out', model: 'mini' },
  );
  assert.deepEqual(
    extractStepCostInfo(
      { name: 'complete', status: 'done', outputs: {} } as RunStep,
      { metrics: { costEstimate: 2.5, model: 'opus' } } as Run,
    ),
    { cost: '$2.50', model: 'opus' },
  );
});

test('stepArtifactsForRunStep normalizes typed artifacts and drops malformed rows', () => {
  assert.deepEqual(
    stepArtifactsForRunStep(
      {
        name: 'verify',
        status: 'done',
        outputs: {
          artifacts: [
            { path: 'artifacts/after.png', purpose: 'screenshot', sizeBytes: 123 },
            { purpose: 'missing-path' },
          ],
        },
      } as RunStep,
      { id: 'run-1', familyId: 'family-1' } as Run,
    ),
    [
      {
        runId: 'run-1',
        familyId: 'family-1',
        stepName: 'verify',
        path: 'artifacts/after.png',
        purpose: 'screenshot',
        sizeBytes: 123,
        source: 'step-output',
      },
    ],
  );
});

test('stepArtifactUrl encodes run artifact paths', () => {
  assert.equal(
    stepArtifactUrl(
      {
        runId: 'run-1',
        familyId: 'family-1',
        stepName: 'verify',
        path: 'artifacts/a b.png',
        purpose: 'screenshot',
        source: 'step-output',
      },
      'http://gateway.local',
    ),
    'http://gateway.local/api/run-artifact?runId=run-1&path=artifacts%2Fa%20b.png',
  );
});
