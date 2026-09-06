import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunStep, SubStepRecord } from '@farmslot/protocol';

import {
  hasPendingPublicationReviewContinuation,
  hasRecoverablePublicationReviewer,
  prepareSubstepsShowCompletion,
  reconcileOrphanedSlots,
  recoverActiveRuns,
  recoveryHealthIsReady,
  type RunRecoveryCollaborators,
  STALE_RELEASE_RECLAIM_MS,
} from './recovery.js';

test('recoveryHealthIsReady requires configured ready indicator to match', () => {
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'OK\n' }, 'OK'), true);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'MANIFEST_ONLY\n' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: '' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 1, stdout: 'OK\n' }, 'OK'), false);
});

test('hasRecoverablePublicationReviewer ignores an already-ingested completed context', () => {
  const context = {
    id: 'rev7-codex',
    role: 'self-review' as const,
    label: 'Reviewer',
    status: 'complete' as const,
    slotId: 'macwork-ff-2',
    runId: 'run-1',
    artifactScope: 'independent-review-7',
  };
  const run = minimalActiveRun({
    agentContexts: [context],
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-7',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 7,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });

  assert.equal(hasRecoverablePublicationReviewer(run), false);
  assert.equal(
    hasRecoverablePublicationReviewer({
      ...run,
      engineState: { publishGate: { independentReviews: [] } },
    }),
    true,
  );

  assert.equal(
    hasRecoverablePublicationReviewer({
      ...run,
      agentContexts: [{ ...context, status: 'failed' }],
      engineState: {
        publishGate: {
          independentReviews: [
            {
              ...run.engineState!.publishGate!.independentReviews![0]!,
              verdict: 'failed',
              unresolvedCount: 0,
              feedbackSent: false,
            },
          ],
        },
      },
    }),
    false,
  );

  assert.equal(
    hasRecoverablePublicationReviewer({
      ...run,
      agentContexts: [{ ...context, status: 'failed' }],
      engineState: {
        publishGate: {
          independentReviews: [
            {
              ...run.engineState!.publishGate!.independentReviews![0]!,
              verdict: 'failed',
              unresolvedCount: 0,
              feedbackSent: false,
              recoveryContinuationPending: true,
            },
          ],
        },
      },
    }),
    true,
    'a delivery-failed reviewer remains watched for a later manual submit',
  );
});

test('hasPendingPublicationReviewContinuation requires the explicit recovery marker', () => {
  const run = minimalActiveRun({
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
            recoveryContinuationPending: true,
          },
        ],
      },
    },
  });
  assert.equal(hasPendingPublicationReviewContinuation(run), true);
  run.engineState!.publishGate!.independentReviews![0]!.recoveryContinuationPending = false;
  assert.equal(hasPendingPublicationReviewContinuation(run), false);
});

test('a later passing review supersedes an older pending continuation', () => {
  const run = minimalActiveRun({
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-3',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 3,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
            recoveryContinuationPending: true,
          },
          {
            id: 'independent-review-4',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 4,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });

  assert.equal(hasPendingPublicationReviewContinuation(run), false);
  assert.equal(
    hasRecoverablePublicationReviewer({
      ...run,
      agentContexts: [
        {
          id: 'rev-old',
          role: 'self-review',
          label: 'Reviewer',
          status: 'complete',
          slotId: 'slot-1',
          runId: run.id,
          artifactScope: 'independent-review-3',
        },
      ],
    }),
    false,
  );
});

test('recoverActiveRuns re-presents a blocked gate after its completed review was ingested', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-INGESTED-REVIEW',
    familyRootTicketOrPr: 'RECOVERY-INGESTED-REVIEW',
    taskFile: '/tmp/farmslot-recovery-ingested-review/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
    agentContexts: [
      {
        id: 'rev7-codex',
        role: 'self-review',
        label: 'Reviewer',
        status: 'complete',
        slotId: 'macwork-ff-2',
        runId: 'run-1',
        artifactScope: 'independent-review-7',
      },
    ],
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-7',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 7,
            verdict: 'pass',
            unresolvedCount: 0,
          },
        ],
      },
    },
  });
  let rearmed = false;
  let broadcasted = false;
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    getRun: () => run,
    reconcileRunAgentRuntime: async () => {},
    rearmPublicationReviewRecovery: () => {
      rearmed = true;
      return () => {};
    },
    updateRun: () => {},
    updateRunStep: () => {},
    broadcast: () => {
      broadcasted = true;
    },
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    recoverInflightPublicationReviews: async () => ({ recoveredIds: [], terminalErrors: [] }),
    replayHumanGate: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.equal(rearmed, false);
  assert.equal(broadcasted, true);
});

function minimalActiveRun(overrides: Partial<Run> = {}): Run {
  return {
    id: '5dd53883-bb8f-4f24-a20e-a20ab2856974',
    familyId: '5dd53883-bb8f-4f24-a20e-a20ab2856974',
    parentRunId: null,
    familyRootTicketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    lane: 'production',
    variant: null,
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'writing-task',
    project: 'farmslot-farm',
    ticketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    slotId: 'macwork-ff-2',
    branch: null,
    taskFile: '/var/folders/xx/farmslot-package-drift-AbCdEf/task.md',
    steps: [{ name: 'write-task', status: 'running' }],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: '2026-06-30T14:08:05.000Z',
    updatedAt: '2026-06-30T14:25:00.000Z',
    ...overrides,
  };
}

test('recovery defers slot-bound runs when the whole fleet snapshot is empty', async () => {
  const run = minimalActiveRun({
    status: 'monitoring',
    slotId: 'slot-1',
    ticketOrPr: 'RECOVERY-EMPTY-FLEET',
    familyRootTicketOrPr: 'RECOVERY-EMPTY-FLEET',
    taskFile: '/tmp/recovery-empty-fleet/TASK.md',
  });
  const updates: Array<Partial<Run>> = [];
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({ slots: [] }),
    updateRun: (_runId: string, fields: Partial<Run>) => updates.push(fields),
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(updates, []);
});

test('empty-fleet deferral still quarantines leaked test runs', async () => {
  const realRun = minimalActiveRun({
    id: 'real-run',
    status: 'monitoring',
    slotId: 'slot-1',
    ticketOrPr: 'RECOVERY-EMPTY-FLEET',
    familyRootTicketOrPr: 'RECOVERY-EMPTY-FLEET',
    taskFile: '/tmp/recovery-empty-fleet/TASK.md',
  });
  const leakedRun = minimalActiveRun({ id: 'leaked-run' });
  const quarantined: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [realRun, leakedRun] }),
    loadFleetStatus: async () => ({ slots: [] }),
    quarantineLeakedRun: async (run: Run) => quarantined.push(run.id),
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(quarantined, ['leaked-run']);
});

test('empty fleet does not defer runs that have not selected a slot', async () => {
  const preSlotRun = minimalActiveRun({
    id: 'pre-slot-run',
    status: 'writing-task',
    slotId: null,
    ticketOrPr: 'RECOVERY-PRE-SLOT',
    familyRootTicketOrPr: 'RECOVERY-PRE-SLOT',
    taskFile: null,
  });
  const slotRun = minimalActiveRun({
    id: 'slot-run',
    status: 'monitoring',
    slotId: 'slot-1',
    ticketOrPr: 'RECOVERY-SLOT',
    familyRootTicketOrPr: 'RECOVERY-SLOT',
    taskFile: '/tmp/recovery-slot/TASK.md',
  });
  const started: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [preSlotRun, slotRun] }),
    loadFleetStatus: async () => ({ slots: [] }),
    updateRun: () => {},
    updateRunStep: () => {},
    startRun: async (runId: string) => started.push(runId),
    quarantineLeakedRun: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(started, ['pre-slot-run']);
});

test('recoverActiveRuns quarantines leaked gateway test runs before orchestration', async () => {
  let quarantined = false;
  const deps = {
    listRuns: () => ({ runs: [minimalActiveRun()] }),
    loadFleetStatus: async () => ({ slots: [] }),
    quarantineLeakedRun: async () => {
      quarantined = true;
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);
  assert.equal(quarantined, true);
});

test('recoverActiveRuns isolates tmux runtime reconciliation failures', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-1',
    familyRootTicketOrPr: 'RECOVERY-1',
    taskFile: '/tmp/farmslot-recovery-1/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
  });
  let reconciled = false;
  let broadcasted = false;
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    reconcileRunAgentRuntime: async () => {
      reconciled = true;
      throw new Error('tmux probe failed');
    },
    updateRun: () => {},
    broadcast: () => {
      broadcasted = true;
    },
    updateRunStep: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    recoverInflightPublicationReviews: async () => ({ recoveredIds: [], terminalErrors: [] }),
    replayHumanGate: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.equal(reconciled, true);
  assert.equal(broadcasted, true, 'pending decision should still be re-presented');
});

test('recoverActiveRuns clears stale human-gate running detail while re-presenting decision', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-2',
    familyRootTicketOrPr: 'RECOVERY-2',
    taskFile: '/tmp/farmslot-recovery-2/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running', detail: 'Running dispatch cursor review' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
  });
  const stepUpdates: Array<Partial<RunStep>> = [];
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    updateRun: () => {},
    updateRunStep: (_id: string, stepName: string, fields: Partial<RunStep>) => {
      if (stepName === 'human-gate') stepUpdates.push(fields);
    },
    broadcast: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    recoverInflightPublicationReviews: async () => ({ recoveredIds: [], terminalErrors: [] }),
    replayHumanGate: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(stepUpdates, [{ detail: 'Waiting for operator decision' }]);
});

test('recoverActiveRuns re-arms handoff auto-recovery for a blocked interactive handoff', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-3',
    familyRootTicketOrPr: 'RECOVERY-3',
    taskFile: '/tmp/farmslot-recovery-3/TASK.md',
    status: 'blocked',
    steps: [{ name: 'monitor', status: 'running' }],
    decisions: [
      {
        id: 'decision-handoff',
        type: 'monitor_interactive_handoff',
        title: 'Interactive handoff',
        description: 'Waiting for SIGNAL.json',
        actions: [{ id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
  });
  const rearmedRunIds: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    updateRun: () => {},
    updateRunStep: () => {},
    broadcast: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    rearmHandoffAutoRecovery: (r: Run) => {
      rearmedRunIds.push(r.id);
      return () => {};
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(rearmedRunIds, [run.id]);
});

test('recoverActiveRuns does not re-arm handoff auto-recovery for non-handoff decisions', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-4',
    familyRootTicketOrPr: 'RECOVERY-4',
    taskFile: '/tmp/farmslot-recovery-4/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Review publish package',
        description: 'Review publish package',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: '2026-06-30T14:20:00.000Z',
      },
    ],
  });
  let rearmed = false;
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    updateRun: () => {},
    updateRunStep: () => {},
    broadcast: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    rearmHandoffAutoRecovery: () => {
      rearmed = true;
      return () => {};
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.equal(rearmed, false);
});

function humanGateDecision(id: string): Run['decisions'][number] {
  return {
    id,
    type: 'engine_human_gate',
    title: 'Review publish package',
    description: 'Review publish package',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' }],
    createdAt: '2026-07-18T10:00:00.000Z',
  };
}

function withRecoverableReviewer(run: Run): Run {
  return {
    ...run,
    agentContexts: [
      {
        id: 'rev3-claude',
        role: 'self-review',
        label: 'rev3-claude',
        status: 'working',
        slotId: run.slotId!,
        runId: run.id,
        taskFile: 'temp/tasks/fix/recovery/SELF-REVIEW.rev3-claude.md',
        signalFile: 'temp/tasks/fix/recovery/SELF-REVIEW.rev3-claude-SIGNAL.json',
        runner: 'claude',
        model: 'opus',
        attemptStartedAt: '2026-07-18T10:01:00.000Z',
      },
    ],
  };
}

function publicationReviewRecoveryDeps(
  run: Run,
  options: {
    recovered?: string[];
    terminalErrors?: Array<{ contextId: string; message: string }>;
    replayError?: Error;
  } = {},
): {
  deps: RunRecoveryCollaborators;
  calls: {
    broadcasted: number;
    rearmed: Array<{ runId: string; replayPending: boolean }>;
    reconciled: number;
    replayed: string[];
    updates: Array<Partial<Run>>;
  };
} {
  const calls = {
    broadcasted: 0,
    rearmed: [] as Array<{ runId: string; replayPending: boolean }>,
    reconciled: 0,
    replayed: [] as string[],
    updates: [] as Array<Partial<Run>>,
  };
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    getRun: () => run,
    updateRun: (_runId: string, fields: Partial<Run>) => {
      calls.updates.push(fields);
    },
    updateRunStep: () => {},
    broadcast: () => {
      calls.broadcasted++;
    },
    quarantineLeakedRun: async () => {},
    reconcileRunAgentRuntime: async () => {
      calls.reconciled++;
    },
    rearmPublicationReviewRecovery: (
      candidate: Run,
      rearmOptions?: { replayPending?: boolean },
    ) => {
      calls.rearmed.push({
        runId: candidate.id,
        replayPending: rearmOptions?.replayPending ?? false,
      });
      return () => {};
    },
    recoverInflightPublicationReviews: async () => ({
      recoveredIds: options.recovered ?? [],
      terminalErrors: options.terminalErrors ?? [],
    }),
    replayHumanGate: async (runId: string) => {
      calls.replayed.push(runId);
      if (options.replayError) throw options.replayError;
    },
  } as unknown as RunRecoveryCollaborators;
  return { deps, calls };
}

test('startup clears a stale live-watcher recovery marker before skipping a paused run', async () => {
  const run = minimalActiveRun({
    status: 'paused',
    engineState: {
      publishGate: {
        reviewRecovery: {
          status: 'watching',
          attempts: 2,
          startedAt: '2026-07-30T01:00:00.000Z',
          updatedAt: '2026-07-30T01:05:00.000Z',
        },
      },
    },
  });
  const { deps, calls } = publicationReviewRecoveryDeps(run);

  await recoverActiveRuns(deps);

  const recoveryUpdate = calls.updates.find((update) => update.engineState);
  assert.equal(recoveryUpdate?.engineState?.publishGate?.reviewRecovery, undefined);
});

test('recovery holds a blocked human gate while its reviewer is still in flight', async () => {
  const run = withRecoverableReviewer(
    minimalActiveRun({
      ticketOrPr: 'RECOVERY-REVIEW-BLOCKED',
      familyRootTicketOrPr: 'RECOVERY-REVIEW-BLOCKED',
      taskFile: '/tmp/farmslot-recovery-review-blocked/TASK.md',
      status: 'blocked',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [humanGateDecision('gate-review-blocked')],
    }),
  );
  const { deps, calls } = publicationReviewRecoveryDeps(run);

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.rearmed, [{ runId: run.id, replayPending: false }]);
  assert.equal(calls.reconciled, 0);
  assert.equal(calls.broadcasted, 0);
  assert.deepEqual(calls.replayed, []);
});

test('recovery immediately replays a persisted review continuation', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-REVIEW-CONTINUATION',
    familyRootTicketOrPr: 'RECOVERY-REVIEW-CONTINUATION',
    taskFile: '/tmp/farmslot-recovery-review-continuation/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [humanGateDecision('gate-review-continuation')],
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 1,
            issues: [{ file: 'src/example.ts', description: 'Fix this issue' }],
            recoveryContinuationPending: true,
          },
        ],
      },
    },
  });
  const { deps, calls } = publicationReviewRecoveryDeps(run);

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [run.id]);
  assert.deepEqual(calls.rearmed, []);
  assert.equal(calls.reconciled, 0);
});

test('recovery holds a human-gating run while its reviewer is still in flight', async () => {
  const run = withRecoverableReviewer(
    minimalActiveRun({
      ticketOrPr: 'RECOVERY-REVIEW-HUMAN-GATING',
      familyRootTicketOrPr: 'RECOVERY-REVIEW-HUMAN-GATING',
      taskFile: '/tmp/farmslot-recovery-review-human-gating/TASK.md',
      status: 'human-gating',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [],
    }),
  );
  const { deps, calls } = publicationReviewRecoveryDeps(run);

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.rearmed, [{ runId: run.id, replayPending: false }]);
  assert.equal(calls.reconciled, 0);
  assert.equal(calls.broadcasted, 0);
});

test('recovery restores and replays a review plan for an active fix pass', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-REVIEW-FIX',
    familyRootTicketOrPr: 'RECOVERY-REVIEW-FIX',
    taskFile: '/tmp/farmslot-recovery-review-fix/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [humanGateDecision('gate-review-fix')],
    agentContexts: [
      {
        id: 'rev-codex',
        role: 'self-review',
        label: 'Reviewer',
        status: 'complete',
        slotId: 'slot-1',
        runId: 'run-1',
        runner: 'codex',
        model: 'gpt-5.6-sol',
        attemptStartedAt: '2026-07-30T03:24:00.000Z',
      },
      {
        id: 'self-review-fix',
        role: 'self-review-fix',
        label: 'Review fix',
        status: 'working',
        slotId: 'slot-1',
        runId: 'run-1',
        startedAt: '2026-07-30T03:30:00.000Z',
      },
    ],
  });
  const { deps, calls } = publicationReviewRecoveryDeps(run);
  let restoredPlan: unknown;
  deps.updateRun = (_runId, fields) => {
    restoredPlan = fields.engineState?.publishGate?.pendingReviewPlan;
  };

  await recoverActiveRuns(deps);

  assert.deepEqual(restoredPlan, [
    {
      order: 1,
      runner: 'codex',
      model: 'gpt-5.6-sol',
      validationDepth: 'full-live',
    },
  ]);
  assert.deepEqual(calls.rearmed, [{ runId: run.id, replayPending: true }]);
  assert.deepEqual(calls.replayed, []);
  assert.equal(calls.broadcasted, 0);
});

test('recovery replays the human gate before reconciliation when a reviewer completed', async () => {
  const run = withRecoverableReviewer(
    minimalActiveRun({
      ticketOrPr: 'RECOVERY-REVIEW-COMPLETE',
      familyRootTicketOrPr: 'RECOVERY-REVIEW-COMPLETE',
      taskFile: '/tmp/farmslot-recovery-review-complete/TASK.md',
      status: 'blocked',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [humanGateDecision('gate-review-complete')],
    }),
  );
  const { deps, calls } = publicationReviewRecoveryDeps(run, {
    recovered: ['rev3'],
  });

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [run.id]);
  assert.deepEqual(calls.rearmed, []);
  assert.equal(calls.reconciled, 0);
  assert.equal(calls.broadcasted, 0);
});

test('recovery retries gate replay after a completed reviewer was ingested', async () => {
  const run = withRecoverableReviewer(
    minimalActiveRun({
      ticketOrPr: 'RECOVERY-REVIEW-REPLAY-RETRY',
      familyRootTicketOrPr: 'RECOVERY-REVIEW-REPLAY-RETRY',
      taskFile: '/tmp/farmslot-recovery-review-replay-retry/TASK.md',
      status: 'blocked',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [humanGateDecision('gate-review-replay-retry')],
    }),
  );
  const { deps, calls } = publicationReviewRecoveryDeps(run, {
    recovered: ['rev3'],
    replayError: new Error('transient replay failure'),
  });

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [run.id]);
  assert.deepEqual(calls.rearmed, [{ runId: run.id, replayPending: true }]);
  assert.equal(calls.reconciled, 0);
  assert.equal(calls.broadcasted, 0);
});

test('recovery replays valid siblings before parking accumulated terminal errors', async () => {
  const run = withRecoverableReviewer(
    minimalActiveRun({
      ticketOrPr: 'RECOVERY-TERMINAL-SIBLINGS',
      familyRootTicketOrPr: 'RECOVERY-TERMINAL-SIBLINGS',
      taskFile: '/tmp/farmslot-recovery-terminal-siblings/TASK.md',
      status: 'blocked',
      steps: [{ name: 'human-gate', status: 'running' }],
      decisions: [humanGateDecision('gate-review-terminal-invalid')],
      engineState: {
        publishGate: {
          reviewRecovery: {
            status: 'watching',
            attempts: 38,
            startedAt: '2026-08-06T10:00:00.000Z',
            updatedAt: '2026-08-06T14:00:00.000Z',
            nextRetryAt: '2026-08-06T14:05:00.000Z',
          },
        },
      },
    }),
  );
  const { deps, calls } = publicationReviewRecoveryDeps(run, {
    recovered: ['independent-review-2'],
    terminalErrors: [
      {
        contextId: 'rev-invalid',
        message: 'Reviewer rev-invalid completed without review-result.json',
      },
    ],
  });

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [run.id]);
  assert.deepEqual(calls.rearmed, []);
  const recovery = calls.updates.at(-1)?.engineState?.publishGate?.reviewRecovery;
  assert.equal(recovery?.status, 'operator-required');
  assert.equal(recovery?.attempts, 38);
  assert.equal(recovery?.startedAt, '2026-08-06T10:00:00.000Z');
  assert.equal(recovery?.nextRetryAt, undefined);
});

function gateRecoveryDeps(
  run: Run,
  opts: { recovered: string[] },
): {
  deps: RunRecoveryCollaborators;
  calls: { replayed: string[]; rebroadcastDecisionIds: string[] };
} {
  const calls = { replayed: [] as string[], rebroadcastDecisionIds: [] as string[] };
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    updateRun: () => {},
    updateRunStep: () => {},
    broadcast: (_event: string, payload: { decision?: { id: string } }) => {
      if (payload.decision) calls.rebroadcastDecisionIds.push(payload.decision.id);
    },
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    rearmHandoffAutoRecovery: () => undefined,
    recoverInflightPublicationReviews: async () => ({
      recoveredIds: opts.recovered,
      terminalErrors: [],
    }),
    replayHumanGate: async (runId: string) => {
      calls.replayed.push(runId);
    },
  } as unknown as RunRecoveryCollaborators;
  return { deps, calls };
}

test('recovery re-enters the human gate when a lost reviewer result was ingested at startup', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-5',
    familyRootTicketOrPr: 'RECOVERY-5',
    taskFile: '/tmp/farmslot-recovery-5/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [humanGateDecision('gate-1')],
  });
  const { deps, calls } = gateRecoveryDeps(run, { recovered: ['rev1'] });

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [run.id]);
  assert.deepEqual(calls.rebroadcastDecisionIds, [], 'stale decision must not be re-presented');
});

test('recovery re-enters the human gate when duplicate pending gate decisions exist', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-6',
    familyRootTicketOrPr: 'RECOVERY-6',
    taskFile: '/tmp/farmslot-recovery-6/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [humanGateDecision('gate-1'), humanGateDecision('gate-2')],
  });
  const { deps, calls } = gateRecoveryDeps(run, { recovered: [] });

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [run.id]);
  assert.deepEqual(calls.rebroadcastDecisionIds, []);
});

test('recovery falls back to re-presenting still-pending decisions when gate re-entry fails', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-8',
    familyRootTicketOrPr: 'RECOVERY-8',
    taskFile: '/tmp/farmslot-recovery-8/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [humanGateDecision('gate-1'), humanGateDecision('gate-2')],
  });
  const calls = { rebroadcastDecisionIds: [] as string[] };
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'working' }],
    }),
    updateRun: () => {},
    updateRunStep: () => {},
    broadcast: (_event: string, payload: { decision?: { id: string } }) => {
      if (payload.decision) calls.rebroadcastDecisionIds.push(payload.decision.id);
    },
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    rearmHandoffAutoRecovery: () => undefined,
    recoverInflightPublicationReviews: async () => ({ recoveredIds: [], terminalErrors: [] }),
    replayHumanGate: async () => {
      throw new Error('replay preflight failed');
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  // Suppressing the rebroadcast after a failed replay would leave the
  // operator with no actionable decision at all.
  assert.deepEqual(calls.rebroadcastDecisionIds, ['gate-1', 'gate-2']);
});

test('recovery leaves a lone pending gate decision in place when nothing was recovered', async () => {
  const run = minimalActiveRun({
    ticketOrPr: 'RECOVERY-7',
    familyRootTicketOrPr: 'RECOVERY-7',
    taskFile: '/tmp/farmslot-recovery-7/TASK.md',
    status: 'blocked',
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [humanGateDecision('gate-1')],
  });
  const { deps, calls } = gateRecoveryDeps(run, { recovered: [] });

  await recoverActiveRuns(deps);

  assert.deepEqual(calls.replayed, [], 'no re-entry churn for an unchanged lone gate');
  assert.deepEqual(calls.rebroadcastDecisionIds, ['gate-1'], 'decision re-presented as before');
});

test('prepareSubstepsShowCompletion recognises a terminal health sub-step', () => {
  const complete = (detail: string): RunStep => ({
    name: 'prepare',
    status: 'running',
    outputs: { subSteps: [{ name: 'health', outcome: 'ok', durationMs: 1, detail }] },
  });
  assert.equal(prepareSubstepsShowCompletion(complete('Health check — OK')), true);
  assert.equal(
    prepareSubstepsShowCompletion(complete('Health check skipped (profile attach)')),
    true,
  );
  // Interrupted mid-flight: last sub-step is preflight, health never ran.
  assert.equal(
    prepareSubstepsShowCompletion({
      name: 'prepare',
      status: 'running',
      outputs: {
        subSteps: [
          { name: 'deps', outcome: 'ok', durationMs: 1 },
          {
            name: 'preflight',
            outcome: 'ok',
            durationMs: 1,
            detail: 'Running preflight (Webpack)...',
          },
        ],
      },
    }),
    false,
  );
  // Health phase started but not resolved.
  assert.equal(prepareSubstepsShowCompletion(complete('Verifying health...')), false);
  assert.equal(prepareSubstepsShowCompletion(undefined), false);
  assert.equal(
    prepareSubstepsShowCompletion({
      name: 'prepare',
      status: 'running',
      outputs: { subSteps: [] },
    }),
    false,
  );
});

// ─── prepare recovery false-positive guard ───

function preparingRun(subSteps: SubStepRecord[]): Run {
  return minimalActiveRun({
    status: 'preparing',
    flowType: 'fix-bug',
    project: 'metamask-extension-farm',
    ticketOrPr: 'PERPS-1234',
    familyRootTicketOrPr: 'PERPS-1234',
    taskFile: '/tmp/farmslot-run/PERPS-1234/task.md',
    slotId: 'macwork-mmedev-2',
    steps: [
      { name: 'find-slot', status: 'done' },
      { name: 'write-task', status: 'done' },
      { name: 'prepare', status: 'running', outputs: { subSteps } },
    ],
  });
}

interface PrepareRecoveryCalls {
  healthChecked: boolean;
  prepareStepUpdates: Array<Partial<RunStep>>;
  runUpdates: Array<Partial<Run>>;
  warmRecovery: boolean;
}

function buildPrepareRecoveryDeps(
  run: Run,
  opts: { killed: boolean; healthExit?: number; healthStdout?: string },
): { deps: RunRecoveryCollaborators; calls: PrepareRecoveryCalls } {
  const calls: PrepareRecoveryCalls = {
    healthChecked: false,
    prepareStepUpdates: [],
    runUpdates: [],
    warmRecovery: false,
  };
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'idle' }],
    }),
    getRun: () => run,
    updateRun: (_id: string, fields: Partial<Run>) => {
      calls.runUpdates.push(fields);
      if (fields.status) run.status = fields.status;
    },
    updateRunStep: (_id: string, stepName: string, fields: Partial<RunStep>) => {
      if (stepName === 'prepare') calls.prepareStepUpdates.push(fields);
    },
    loadSlotVars: async () => ({ remoteRepo: '/repo', slotId: run.slotId }),
    loadProjectVarsOrNull: async () => ({
      runtimeDir: 'temp/recipe/runtime',
      projectJson: {},
    }),
    getProjectFieldRaw: () => [],
    expandTemplate: (t: string) => t,
    clearStalePrepareProcess: async () => opts.killed,
    expandHook: () => 'test -f {{runtime_dir}}/extension.id && echo OK',
    execOnSlot: async () => {
      calls.healthChecked = true;
      return { exitCode: opts.healthExit ?? 0, stdout: opts.healthStdout ?? 'OK' };
    },
    getProjectField: () => 'OK',
    setRunFlags: (_id: string, flags: { warmRecovery?: true }) => {
      if (flags.warmRecovery) calls.warmRecovery = true;
    },
    startRun: async () => {},
    resetSlot: async () => {},
    quarantineLeakedRun: async () => {},
  } as unknown as RunRecoveryCollaborators;
  return { deps, calls };
}

test('prepare recovery re-runs prepare when it killed an in-flight preflight even if health would pass', async () => {
  // Preflight running, then killed by recovery; a stale extension.id would pass
  // the weak health_check. Recovery must NOT trust that health signal.
  const run = preparingRun([
    { name: 'deps', outcome: 'ok', durationMs: 1 },
    { name: 'preflight', outcome: 'ok', durationMs: 1, detail: 'Running preflight (Webpack)...' },
  ]);
  const { deps, calls } = buildPrepareRecoveryDeps(run, {
    killed: true,
    healthExit: 0,
    healthStdout: 'OK',
  });

  await recoverActiveRuns(deps);

  assert.equal(calls.healthChecked, false, 'health must not be consulted after a kill');
  assert.equal(calls.warmRecovery, true, 'prepare must be re-run via warm recovery');
  assert.ok(
    calls.prepareStepUpdates.some((f) => f.status === 'pending'),
    'prepare step must be reset to pending',
  );
  assert.ok(
    !calls.prepareStepUpdates.some((f) => f.detail === 'Recovered (slot healthy)'),
    'prepare must never be marked recovered after a kill',
  );
});

test('prepare recovery skips prepare only when nothing killed and sub-steps complete', async () => {
  const run = preparingRun([
    { name: 'preflight', outcome: 'ok', durationMs: 1, detail: 'Preflight completed (log: x)' },
    { name: 'health', outcome: 'ok', durationMs: 1, detail: 'Health check — OK' },
  ]);
  const { deps, calls } = buildPrepareRecoveryDeps(run, {
    killed: false,
    healthExit: 0,
    healthStdout: 'OK',
  });

  await recoverActiveRuns(deps);

  assert.equal(calls.healthChecked, true, 'health check runs for the legitimate skip path');
  assert.ok(
    calls.prepareStepUpdates.some(
      (f) => f.status === 'done' && f.detail === 'Recovered (slot healthy)',
    ),
    'prepare marked recovered/done',
  );
  assert.ok(
    calls.runUpdates.some((f) => f.status === 'dispatching'),
    'run advances to dispatching',
  );
  assert.equal(calls.warmRecovery, false, 'no warm re-run when the skip is legitimate');
});

test('prepare recovery re-runs prepare when sub-steps show incomplete phases', async () => {
  // Nothing was killed, but preflight never completed and health never ran, so a
  // passing health probe cannot be trusted.
  const run = preparingRun([
    { name: 'preflight', outcome: 'ok', durationMs: 1, detail: 'Running preflight (Webpack)...' },
  ]);
  const { deps, calls } = buildPrepareRecoveryDeps(run, {
    killed: false,
    healthExit: 0,
    healthStdout: 'OK',
  });

  await recoverActiveRuns(deps);

  assert.equal(calls.healthChecked, false, 'health skipped when sub-steps are incomplete');
  assert.equal(calls.warmRecovery, true, 'prepare must be re-run via warm recovery');
  assert.ok(
    !calls.prepareStepUpdates.some((f) => f.detail === 'Recovered (slot healthy)'),
    'prepare must never be marked recovered with incomplete sub-steps',
  );
});

test('recovery re-enters monitor for an idle-looking interactive worker', async () => {
  // Run 6e092aa9: a gateway restart found the run `monitoring` with the slot no
  // longer reporting `working`, so recovery inferred the worker was finished,
  // marked MONITOR done with no outputs and advanced to COMPLETE. The worker was
  // still mid-task — its SIGNAL.json read `status: running, step 7` — and the run
  // finished `success` with a PR nobody approved and the slot released underneath
  // it. Completion on this flow is the operator's.
  const run = minimalActiveRun({
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'lightweight',
    status: 'monitoring',
    ticketOrPr: 'MANUAL-000046',
    familyRootTicketOrPr: 'MANUAL-000046',
    taskFile: '/Users/op/dev/farmslot/.sandbox/farmslot-farm/tasks/feat/manual-000046/TASK.md',
    steps: [{ name: 'monitor', status: 'running' }],
  });
  const statuses: string[] = [];
  const advancedSteps: string[] = [];
  let started = false;
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'idle' }],
    }),
    updateRun: (_id: string, patch: Partial<Run>) => {
      if (patch.status) statuses.push(patch.status);
    },
    updateRunStep: (_id: string, step: string) => {
      advancedSteps.push(step);
    },
    startRun: async () => {
      started = true;
    },
    broadcast: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    recoverInflightPublicationReviews: async () => ({ recoveredIds: [], terminalErrors: [] }),
    replayHumanGate: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(
    statuses,
    [],
    'recovery must not infer a run status from slot-level agent state',
  );
  assert.ok(!advancedSteps.includes('complete'), 'complete must not be started by recovery');
  assert.equal(started, true, 'monitor must validate the durable worker signal and operator hold');
});

test('recovery re-enters monitor for an idle-looking autonomous worker', async () => {
  const run = minimalActiveRun({
    flowType: 'dev',
    mode: 'autonomous',
    status: 'monitoring',
    ticketOrPr: 'PROJ-4242',
    familyRootTicketOrPr: 'PROJ-4242',
    taskFile: '/Users/op/dev/farmslot/.sandbox/farmslot-farm/tasks/feat/proj-4242/TASK.md',
    steps: [{ name: 'monitor', status: 'running' }],
  });
  const statuses: string[] = [];
  let started = false;
  const deps = {
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: run.slotId!, lifecycle: 'busy', agent: 'idle' }],
    }),
    updateRun: (_id: string, patch: Partial<Run>) => {
      if (patch.status) statuses.push(patch.status);
    },
    updateRunStep: () => {},
    startRun: async () => {
      started = true;
    },
    broadcast: () => {},
    setPrHealthOverlay: () => {},
    quarantineLeakedRun: async () => {},
    recoverInflightPublicationReviews: async () => ({ recoveredIds: [], terminalErrors: [] }),
    replayHumanGate: async () => {},
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);

  assert.deepEqual(statuses, [], 'recovery must not bypass monitor signal validation');
  assert.equal(started, true);
});

// ─── ADR-054 free-slot: restart recovery treats a gate-parked run as parked ───

const GATE_PARK_AT = '2026-09-05T00:00:00.000Z';

/**
 * A gate-held run at its publication gate with an ADR-054 `free-slot` park
 * record. `parkOverrides` chooses where in the park the restart landed: after
 * `slotFreedAt` (the release is durable) or before it (the record declares the
 * freeing intent and the worker was already stopped on the way down).
 */
function gateParkedRun(parkOverrides: Record<string, unknown>): Run {
  return minimalActiveRun({
    id: 'parked-run',
    status: 'blocked',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-GATE-PARK',
    familyRootTicketOrPr: 'RECOVERY-GATE-PARK',
    taskFile: '/tmp/recovery-gate-park/TASK.md',
    steps: [
      { name: 'complete', status: 'done', outputs: { slotDisposition: 'gate-held' } },
      { name: 'human-gate', status: 'running' },
    ],
    decisions: [
      {
        id: 'gate-1',
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: 'Approve package',
        actions: [],
        createdAt: GATE_PARK_AT,
      },
    ],
    park: {
      version: 1,
      operationId: 'park-recovery',
      previewId: 'preview-recovery',
      runId: 'parked-run',
      generation: 1,
      machine: 'macwork',
      slotId: 'macwork-ff-2',
      mode: 'release',
      slotDisposition: 'freed',
      prePauseStatus: 'blocked',
      prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
      resourceManifest: { capturedAt: GATE_PARK_AT, resources: [], capabilityLeases: [] },
      recoveryHandle: null,
      errors: [],
      residuals: { runner: 'stopped', resources: [] },
      createdAt: GATE_PARK_AT,
      updatedAt: GATE_PARK_AT,
      ...parkOverrides,
    },
  } as unknown as Partial<Run>);
}

/**
 * Runs restart recovery against a single gate-parked run and records every
 * slot-bound collaborator it reached. Each one would act on a slot the park
 * handed to dispatch, which the fleet here reports as already re-claimed.
 */
async function recoverGateParked(run: Run) {
  const calls: string[] = [];
  const broadcasts: string[] = [];
  const updates: Array<Partial<Run>> = [];
  // The successor that took the freed slot. `paused` so it drives no recovery
  // of its own and every recorded call belongs to the parked run — but it is a
  // real active binding, so the closing orphan sweep sees the slot occupied.
  const successor = minimalActiveRun({
    id: 'successor-run',
    status: 'paused',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-GATE-PARK-SUCCESSOR',
    familyRootTicketOrPr: 'RECOVERY-GATE-PARK-SUCCESSOR',
    taskFile: '/tmp/recovery-gate-park-successor/TASK.md',
  });
  const deps = {
    listRuns: () => ({ runs: [run, successor] }),
    quarantineLeakedRun: async () => calls.push('quarantineLeakedRun'),
    // The successor already owns the slot the park handed to dispatch.
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', currentRunId: 'successor-run' }],
    }),
    getRun: (runId: string) => (runId === successor.id ? successor : run),
    updateRun: (runId: string, fields: Partial<Run>) => {
      if (runId === run.id) updates.push(fields);
    },
    updateRunStep: () => calls.push('updateRunStep'),
    setRunFlags: () => calls.push('setRunFlags'),
    broadcast: (event: string) => broadcasts.push(event),
    reconcileRunAgentRuntime: async () => calls.push('reconcileRunAgentRuntime'),
    replayHumanGate: async () => calls.push('replayHumanGate'),
    rearmPublicationReviewRecovery: () => {
      calls.push('rearmPublicationReviewRecovery');
      return true;
    },
    startRun: async () => calls.push('startRun'),
    resetSlot: async () => calls.push('resetSlot'),
    loadSlotVars: async () => {
      calls.push('loadSlotVars');
      return {};
    },
    execOnSlot: async () => {
      calls.push('execOnSlot');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as RunRecoveryCollaborators;

  await recoverActiveRuns(deps);
  return { calls, broadcasts, updates };
}

test('restart recovery drives no slot work for a run whose park freed its slot', async () => {
  const { calls, broadcasts, updates } = await recoverGateParked(
    gateParkedRun({
      phase: 'parked',
      slotFreedAt: '2026-09-05T00:00:10.000Z',
      preservedWorkspace: {
        branch: 'work/parked-run',
        headSha: 'sha-parked',
        detachedAt: '2026-09-05T00:00:09.000Z',
      },
    }),
  );

  // Every one of these would act on a slot the parked run no longer owns.
  assert.deepEqual(calls, []);
  // The pending gate is still published so clients show the run waiting; a
  // broadcast touches no slot.
  assert.deepEqual(broadcasts, ['run.decision.new']);
  assert.equal(
    updates.some((fields) => 'slotId' in fields),
    false,
    'recovery must not rebind or clear the parked run slot',
  );
});

test('restart recovery drives no slot work for a park that crashed before slotFreedAt', async () => {
  // The write-ahead record declares the freeing intent and the worker was
  // stopped on the way down, but the release had not been recorded when the
  // gateway died. `run.resolveDecision` refuses this run for exactly as long,
  // so recovery must not re-drive the gate it cannot answer.
  const { calls, broadcasts, updates } = await recoverGateParked(
    gateParkedRun({ phase: 'stopping', slotFreedAt: undefined }),
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(broadcasts, ['run.decision.new']);
  assert.equal(
    updates.some((fields) => 'slotId' in fields),
    false,
    'recovery must not rebind or clear the parked run slot',
  );
});

test('orphan reconcile reclaims a busy slot that only a park-freed run still names', async () => {
  // The parked run keeps `slotId` as its restore target, so counting it as an
  // occupant would mask this slot from reclamation for as long as the park
  // lives. Occupancy comes from the shared predicate, not from `slotId` alone.
  const parked = gateParkedRun({
    phase: 'parked',
    slotFreedAt: '2026-09-05T00:00:10.000Z',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [parked] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: null }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => null,
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, ['macwork-ff-2']);
});

test("orphan reconcile leaves a terminal run's slot alone while its teardown runs", async () => {
  // ADR-053 publishes the terminal status BEFORE the teardown, and occupancy
  // counts only non-terminal runs — so for the length of the teardown the slot
  // looks orphaned here. Resetting it there republishes a slot whose windows
  // are still being killed and whose worktree is still being reset.
  const terminal = minimalActiveRun({
    id: 'terminal-run',
    status: 'done',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-TERMINAL-TEARDOWN',
    familyRootTicketOrPr: 'RECOVERY-TERMINAL-TEARDOWN',
    taskFile: '/tmp/recovery-terminal-teardown/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [terminal] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: 'working' }],
    }),
    isTerminalTeardownInFlight: (slotId: string) => slotId === 'macwork-ff-2',
    readSlotField: async () => null,
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, [], 'a slot mid-teardown is not orphaned');
});

test('orphan reconcile leaves a slot a release already fenced', async () => {
  // The same claim for a release this process did not start: `releasing` is the
  // marker every other teardown path already respects.
  const terminal = minimalActiveRun({
    id: 'terminal-run-2',
    status: 'failed',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-RELEASING-FENCE',
    familyRootTicketOrPr: 'RECOVERY-RELEASING-FENCE',
    taskFile: '/tmp/recovery-releasing-fence/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [terminal] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: 'releasing' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => null,
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, []);
});

test('orphan reconcile reclaims a releasing fence nothing is finishing', async () => {
  // The fence added for terminal teardown has no other way out: this loop
  // skips a releasing slot, `resetSlot` refuses one, and `slotRelease` returns
  // `released: false` for one. A release interrupted between fencing and
  // finishing would strand the slot for good without this bound.
  const terminal = minimalActiveRun({
    id: 'terminal-stale',
    status: 'done',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-STALE-RELEASE',
    familyRootTicketOrPr: 'RECOVERY-STALE-RELEASE',
    taskFile: '/tmp/terminal-stale/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [terminal] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: 'releasing' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () =>
      new Date(Date.now() - STALE_RELEASE_RECLAIM_MS - 60_000).toISOString(),
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, ['macwork-ff-2']);
});

test('orphan reconcile leaves a releasing fence that is still young', async () => {
  // Reclaiming a LIVE teardown is the worse of the two errors, so the bound
  // is generous and anything inside it keeps its protection.
  const terminal = minimalActiveRun({
    id: 'terminal-fresh',
    status: 'done',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-FRESH-RELEASE',
    familyRootTicketOrPr: 'RECOVERY-FRESH-RELEASE',
    taskFile: '/tmp/terminal-fresh/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [terminal] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: 'releasing' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => new Date(Date.now() - 5_000).toISOString(),
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, []);
});

test('an unstamped releasing fence keeps its protection rather than being reclaimed', async () => {
  // A fence written before the stamp existed has unknown age. Unknown must
  // not read as stale, or the first tick after deploy reclaims live teardowns.
  const terminal = minimalActiveRun({
    id: 'terminal-unstamped',
    status: 'done',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-UNSTAMPED',
    familyRootTicketOrPr: 'RECOVERY-UNSTAMPED',
    taskFile: '/tmp/terminal-unstamped/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [terminal] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: 'releasing' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => null,
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, []);
});

test('orphan reconcile still reclaims a genuinely abandoned slot', async () => {
  // The guard must not turn the reconciler off: a terminal run whose teardown
  // is NOT running — the gateway died mid-release and came back — is exactly
  // what this loop exists to reclaim.
  const terminal = minimalActiveRun({
    id: 'terminal-run-3',
    status: 'done',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-ABANDONED',
    familyRootTicketOrPr: 'RECOVERY-ABANDONED',
    taskFile: '/tmp/recovery-abandoned/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [terminal] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: 'working' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => null,
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, ['macwork-ff-2']);
});

test('orphan reconcile leaves a busy slot its live occupant still holds', async () => {
  const running = minimalActiveRun({
    id: 'successor-run',
    status: 'monitoring',
    slotId: 'macwork-ff-2',
    ticketOrPr: 'RECOVERY-GATE-PARK-SUCCESSOR',
    familyRootTicketOrPr: 'RECOVERY-GATE-PARK-SUCCESSOR',
    taskFile: '/tmp/recovery-gate-park-successor/TASK.md',
  });
  const reset: string[] = [];
  const deps = {
    listRuns: () => ({ runs: [running] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'macwork-ff-2', lifecycle: 'busy', phase: null }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => null,
    resetSlot: async (slotId: string) => reset.push(slotId),
  } as unknown as RunRecoveryCollaborators;

  await reconcileOrphanedSlots(deps);

  assert.deepEqual(reset, []);
});
