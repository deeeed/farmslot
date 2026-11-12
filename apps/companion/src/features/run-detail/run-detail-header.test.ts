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
  // A native QA run on a review worktree: its terminal tile opens a conversation.
  run({
    slotId: null,
    steps: [{ name: 'monitor', status: 'running' }],
    qa: { profile: { id: 'smoke', title: 'Smoke', template_id: 'qa' }, inputs: {} },
    agentContexts: [
      {
        id: 'primary',
        label: 'Worker',
        role: 'primary',
        status: 'working',
        slotId: null,
        runId: 'run-header',
        runner: 'claude',
        startedAt: '2026-11-01T00:01:00.000Z',
        nativeSession: {
          sessionId: 'session-1',
          executionNodeId: 'node-1',
          ownerPrincipalId: 'operator',
          leaseId: 'lease-1',
          commandId: 'command-1',
        },
        runnerSessionArchive: { status: 'captured', originalPath: '/home/worker/session.jsonl' },
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

// The stand-in header card holds the terminal tile and QA line the loaded card holds, with the
// same values, so the slot line under them does not move when run.get lands.
test('the terminal tile and QA line are the same from the served row and the full run', () => {
  const tile = (full: Run) => {
    const { terminalLabel, terminalValue, terminalDisabled, qaProfile } = runDetailHeaderModel(
      runListRow(full),
    );
    return { terminalLabel, terminalValue, terminalDisabled, qaProfile };
  };
  assert.deepEqual(tile(states[0]), {
    terminalLabel: 'Open terminal',
    terminalValue: 'slot-2',
    terminalDisabled: false,
    qaProfile: null,
  });
  assert.deepEqual(tile(states[2]), {
    terminalLabel: 'Open terminal',
    terminalValue: 'This run is finished.',
    terminalDisabled: true,
    qaProfile: null,
  });
  assert.equal(runListRow(states[4]).detailTrimmed, true);
  assert.deepEqual(tile(states[4]), {
    terminalLabel: 'Open conversation',
    terminalValue: 'node-1',
    terminalDisabled: false,
    qaProfile: 'Smoke (smoke)',
  });
});
