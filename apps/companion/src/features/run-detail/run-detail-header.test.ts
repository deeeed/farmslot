import assert from 'node:assert/strict';
import test from 'node:test';

import { type Run, runListRow, trimRunForList } from '@farmslot/protocol';

import { runDetailHeaderModel } from './run-detail-header';

function run(fields: Partial<Run>): Run {
  return {
    id: 'run-header',
    familyId: 'family-header',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'example-mobile',
    ticketOrPr: 'PR-9',
    summary: 'Fix the banner',
    slotId: 'slot-2',
    branch: 'fix/banner',
    taskFile: '/repo/TASK.md',
    steps: [
      {
        name: 'dispatch',
        status: 'done',
        outputs: { selectedSlot: 'slot-2', notes: 'n'.repeat(500) },
      },
      { name: 'monitor', status: 'running', startedAt: '2026-11-01T00:00:00.000Z' },
    ],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'opus', runner: 'claude', durationMs: 125_000 },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:05:00.000Z',
    ...fields,
  };
}

/** Header states Run Detail opens on: a working run, a review round, a finished one. */
const states: Run[] = [
  run({}),
  run({
    status: 'reviewing',
    agentContexts: [
      {
        id: 'review',
        label: 'Reviewer',
        role: 'review',
        status: 'working',
        slotId: 'slot-2',
        runId: 'run-header',
        runner: 'codex',
        startedAt: '2026-11-01T00:04:00.000Z',
        reviewId: 'rev-1',
        reviewLoopNumber: 2,
      },
    ],
  }),
  run({ status: 'done', steps: [{ name: 'monitor', status: 'done' }] }),
  run({
    status: 'blocked',
    steps: [
      { name: 'dispatch', status: 'done' },
      { name: 'human-gate', status: 'running' },
    ],
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publish',
        description: '',
        createdAt: '2026-11-01T00:00:00.000Z',
        actions: [{ id: 'approve-publish', label: 'Approve', style: 'primary' }],
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          branch: 'fix/banner',
          workerReport: 'w'.repeat(3000),
          diffStat: { files: 1, additions: 1, deletions: 0 },
          gateReadiness: {
            state: 'not-ready',
            identity: { runId: 'run-header', generation: 1 },
            reasons: [
              {
                code: 'evidence-policy-unsatisfied',
                prerequisite: 'evidence',
                evidencePolicy: 'execution-verdict',
                message: 'Evidence policy needs attestation.',
              },
            ],
          },
        },
      },
    ],
  }),
];

// With no run.get held, Run Detail paints its header from the list row; when the detail lands
// the header shows the same values, so it neither flashes nor changes.
test('the run detail header is the same from the served row, the full run and an old cached row', () => {
  for (const full of states) {
    const expected = runDetailHeaderModel(full);
    assert.deepEqual(runDetailHeaderModel(runListRow(full)), expected, full.status);
    assert.deepEqual(runDetailHeaderModel(trimRunForList(full)), expected, full.status);
  }
  assert.equal(runDetailHeaderModel(states[0]).durationMs, 125_000);
  assert.equal(
    runDetailHeaderModel(states[3]).statusLabel,
    'Needs your decision: Evidence policy needs attestation.',
  );
});
