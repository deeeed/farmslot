import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunDecision } from '@farmslot/protocol';

import { pendingDecisionForRun } from './decision-projection.js';

test('projects stored run decisions into the complete websocket decision contract', () => {
  const decision: RunDecision = {
    id: 'decision-1',
    type: 'engine_human_gate',
    title: 'Publish',
    description: 'Review the package.',
    actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
    createdAt: '2026-08-03T00:00:00.000Z',
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: 'owner/repo',
      diffStat: { files: 1, additions: 2, deletions: 0 },
      workerReport: 'Done.',
      branch: 'feat/manual-1',
    },
  };
  const run = {
    id: 'run-1',
    familyId: 'family-1',
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'MANUAL-1',
    slotId: 'slot-1',
    branch: 'feat/manual-1',
    prNumber: 12,
    summary: 'Summary',
    metrics: { runner: 'claude', model: 'opus' },
  } as Run;

  assert.deepEqual(pendingDecisionForRun(run, decision), {
    ...decision,
    slotId: 'slot-1',
    context: {
      runId: 'run-1',
      project: 'farmslot-farm',
      flowType: 'dev',
      ticketOrPr: 'MANUAL-1',
    },
    runMeta: {
      runId: 'run-1',
      familyId: 'family-1',
      flowType: 'dev',
      ticketOrPr: 'MANUAL-1',
      prNumber: 12,
      branch: 'feat/manual-1',
      runner: 'claude',
      model: 'opus',
      summary: 'Summary',
    },
  });
});

test('projects run metadata when the decision has no optional payload', () => {
  const decision: RunDecision = {
    id: 'decision-2',
    type: 'monitor_interactive_handoff',
    title: 'Resume worker',
    description: 'Confirm the retained worker is ready.',
    actions: [{ id: 'resume', label: 'Resume', style: 'primary' }],
    createdAt: '2026-08-03T00:00:00.000Z',
  };
  const run = {
    id: 'run-2',
    familyId: 'family-2',
    project: 'farmslot-farm',
    flowType: 'dev',
    ticketOrPr: 'MANUAL-2',
    slotId: 'slot-2',
    metrics: {},
  } as Run;

  const projected = pendingDecisionForRun(run, decision);
  assert.equal(projected.runMeta?.runId, 'run-2');
  assert.equal('payload' in projected, false);
});
