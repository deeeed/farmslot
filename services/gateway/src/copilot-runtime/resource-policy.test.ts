import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, Run } from '@farmslot/protocol';

import { buildCopilotWorkloadSnapshot } from './resource-policy.js';

function runFixture(input: Pick<Run, 'id' | 'flowType' | 'status' | 'slotId'> & Partial<Run>): Run {
  return {
    familyId: input.id,
    lane: 'production',
    project: 'test-project',
    ticketOrPr: input.id,
    branch: null,
    taskFile: null,
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: 'now',
    updatedAt: 'now',
    ...input,
    steps: input.steps ?? [],
  };
}

test('workload counts all primary, nested, QA, recipe, prepare, dev-server, and Co-Pilot roles by host', () => {
  const run = runFixture({
    id: 'review-run',
    flowType: 'review-pr',
    status: 'monitoring',
    slotId: 'slot-1',
    reviewValidationDepth: 'full-live',
    steps: [
      { name: 'prepare', status: 'running' },
      { name: 'recipe', status: 'running' },
    ],
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'review',
        status: 'working',
        slotId: 'slot-1',
        runId: 'review-run',
      },
      {
        id: 'self-review-fix',
        role: 'self-review-fix',
        label: 'self-review-fix',
        status: 'working',
        slotId: 'slot-1',
        runId: 'review-run',
      },
      {
        id: 'ci-fix',
        role: 'ci-fix',
        label: 'ci-fix',
        status: 'working',
        slotId: 'slot-1',
        runId: 'review-run',
      },
    ],
  });
  const implementation = runFixture({
    id: 'dev-run',
    flowType: 'dev',
    status: 'monitoring',
    slotId: 'slot-1',
    steps: [],
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'dev',
        status: 'working',
        slotId: 'slot-1',
        runId: 'dev-run',
      },
    ],
  });
  const fleet = {
    checkedAt: 'now',
    summary: {
      total: 1,
      ready: 0,
      busy: 1,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
    slots: [{ slot: 'slot-1', machine: 'host-a' }],
  } as unknown as FleetStatus;
  const snapshot = buildCopilotWorkloadSnapshot({
    runs: [run, implementation],
    fleet,
    resources: [
      {
        slotId: 'slot-1',
        resourceId: 'dev-server',
        pointer: { pid: 1, startedAt: 'now', runId: 'dev-run' },
      },
    ],
    copilotRunning: true,
    localHost: 'host-a',
    highPressureThreshold: 1,
  });
  assert.deepEqual(
    {
      implementation: snapshot.totals.implementation,
      independentReview: snapshot.totals.independentReview,
      reviewRework: snapshot.totals.reviewRework,
      ciFix: snapshot.totals.ciFix,
      fullQa: snapshot.totals.fullQa,
      recipe: snapshot.totals.recipe,
      prepare: snapshot.totals.prepare,
      devServer: snapshot.totals.devServer,
      copilot: snapshot.totals.copilot,
    },
    {
      implementation: 1,
      independentReview: 1,
      reviewRework: 1,
      ciFix: 1,
      fullQa: 1,
      recipe: 1,
      prepare: 1,
      devServer: 1,
      copilot: 1,
    },
  );
  assert.equal(snapshot.severity, 'high');
  assert.equal(snapshot.policy.automaticCancellation, false);
  assert.equal(snapshot.policy.automaticDispatch, false);
  assert.equal(snapshot.policy.automaticFanOut, false);
  assert.equal(snapshot.hosts[0]?.host, 'host-a');
});
