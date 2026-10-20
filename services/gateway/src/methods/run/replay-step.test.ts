// @farmslot:serial — snapshots, overwrites, and restores the shared root `.farm-status.json`.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  type AgentContext,
  Events,
  isCompletionPrerequisiteFailure,
  type Principal,
  type Run,
  type RunDecision,
  type RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import {
  addItem,
  claimQueueItem,
  getQueueSnapshot,
  removeQueueItemInternal,
  stampQueueItemRunId,
} from '../../backlog/dispatch-queue.js';
import { statusFile } from '../../core/state.js';
import {
  createEngineDecision,
  hasEngineDecisionWaiter,
} from '../../run-engine/engine-decisions.js';
import { cancelRunEngine } from '../../run-engine/orchestrator.js';
import { isPublicationReviewRecoveryHeld } from '../../run-engine/recovery.js';
import { makeRun } from '../../run-engine/test-fixtures.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';
import {
  currentSessionOriginator,
  runWithSessionOriginator,
  type WorkOriginator,
} from '../../security/work-originator.js';
import { markCompletionFailureDiscarded } from '../slot/release-run-ownership.js';

import { runForceComplete } from './lifecycle-control.js';
import {
  blockedMonitorOwnsSlot,
  blockedMonitorProofReady,
  blockedReviewFixTaskFile,
  canAdoptTaskSignalAfterUncertainDispatch,
  freshBlockedMonitorAttempt,
  freshDispatchEngineStateForReplay,
  normalizeReplayPrerequisites,
  readAdoptableTaskSignal,
  replaySlotReclaimCheck,
  ReplayTaskSignalProbeError,
  resetPublishGateApprovalForReplay,
  rollbackReclaimedSlotReleaseOptions,
  runReplayStep,
  shouldRerouteEvalReplayToPrepare,
} from './replay-step.js';

/**
 * Teardown eviction for a run these fixtures force-settle themselves.
 *
 * Deliberately does NOT clear `backlogReconcilePending`. These runs carry no
 * backlog item, and a terminal transition only marks a run that has one, so
 * there is nothing here for `deleteRun` to refuse. Clearing it anyway would
 * paper over exactly the regression this fixture is positioned to catch.
 */
async function evictTestRun(runId: string, status: 'cancelled' | 'failed'): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status, completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('rollback release preserves live posture and binds every replay status to its reclaim epoch', () => {
  for (const status of ['blocked', 'human-gating', 'paused', 'ci-watching'] as const)
    assert.deepEqual(rollbackReclaimedSlotReleaseOptions(status, 'run-1', 7), {
      restartRunId: 'run-1',
      expectedSlotEpoch: 7,
    });
  assert.deepEqual(rollbackReclaimedSlotReleaseOptions('failed', 'run-1', 7), {
    expectedSlotEpoch: 7,
  });
});

test('workspace replay rejects launch and runner changes without mutating the attempt', async (context) => {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'replay-test-owner';
  const run = createRun(
    {
      flowType: 'review-pr',
      project: 'replay-test',
      ticketOrPr: 'example/app#42',
      transport: 'tmux',
      reviewWorkspaceTarget: { machine: 'local' },
      runner: 'grok',
      model: 'grok-4.6',
    },
    { nativeOwnerPrincipalId: 'replay-test-owner' },
  );
  context.after(async () => {
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
    await evictTestRun(run.id, 'failed');
  });
  updateRun(run.id, {
    status: 'blocked',
    reviewWorkspaceTarget: { machine: 'local' },
    reviewWorkspace: {
      workspaceId: 'owned',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: '/source',
      taskPath: '/task',
      artifactPath: '/task/artifacts',
      cleanedAt: new Date().toISOString(),
    },
    engineState: { generation: 4 },
  });
  const before = structuredClone(getRun(run.id));
  const events: unknown[] = [];
  for (const params of [
    { stepName: 'dispatch', runner: 'cursor', model: 'claude-opus-5-5-high' },
    { stepName: 'find-slot' },
    { stepName: 'write-task' },
    { stepName: 'prepare' },
    { stepName: 'monitor', runner: 'cursor' },
  ]) {
    await assert.rejects(
      runReplayStep({ runId: run.id, ...params }, (...event) => events.push(event)),
      { code: 'REVIEW_RESTART_REQUIRED' },
    );
    assert.deepEqual(getRun(run.id), before);
    assert.deepEqual(events, []);
  }
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'another-owner';
  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'dispatch' }, () => {}),
    { code: 'AUTH_FORBIDDEN' },
  );
  assert.deepEqual(getRun(run.id), before);
});

test('fresh dispatch replay drops only retained-handoff flags', () => {
  assert.deepEqual(
    freshDispatchEngineStateForReplay(
      {
        flags: {
          skipPrepare: true,
          warmSessionReuse: true,
          warmHandoffSucceeded: false,
        },
        generation: 2,
      },
      true,
    ),
    { flags: { skipPrepare: true }, generation: 2 },
  );
});

test('only a fresh dispatch replay starts a new task evidence window', () => {
  const engineState = {
    flags: { skipPrepare: true },
    taskExecution: {
      taskFile: '/farm/tasks/qa/t-1/TASK.md',
      startedAt: '2026-10-16T15:22:30.000Z',
    },
  };
  assert.deepEqual(freshDispatchEngineStateForReplay(engineState, false), engineState);
  assert.deepEqual(freshDispatchEngineStateForReplay(engineState, true), {
    flags: { skipPrepare: true },
  });
});

test('uncertain dispatch accepts only a fresh task-local signal with an attempt id', () => {
  const run = {
    steps: [
      {
        name: 'dispatch',
        status: 'failed' as const,
        startedAt: '2026-09-03T08:00:00.000Z',
        outputs: { promptDeliveryUncertain: true },
      },
    ],
  };

  assert.equal(
    canAdoptTaskSignalAfterUncertainDispatch(run, {
      status: 'running',
      attemptId: 'attempt-1',
      timestamp: '2026-09-03T08:00:01.000Z',
    }),
    true,
  );
  assert.equal(
    canAdoptTaskSignalAfterUncertainDispatch(run, {
      status: 'running',
      timestamp: '2026-09-03T08:00:01.000Z',
    }),
    false,
  );
  assert.equal(
    canAdoptTaskSignalAfterUncertainDispatch(run, {
      status: 'running',
      attemptId: 'stale-attempt',
      timestamp: '2026-09-03T07:59:59.000Z',
    }),
    false,
  );
});

test('blocked monitor replay binds a fresh completed attempt before monitoring resumes', () => {
  const oldSignal = { status: 'blocked', attemptId: 'old', timestamp: '2026-09-23T01:00:00Z' };
  const run = {
    status: 'blocked' as const,
    steps: [
      { name: 'monitor', status: 'done', outputs: { workerSignal: oldSignal } },
    ] as Run['steps'],
  };
  const signal = {
    status: 'complete',
    attemptId: 'new',
    timestamp: '2026-09-23T01:01:00Z',
  } as const;
  const context = { id: 'worker', role: 'fix-bug' } as const;
  assert.equal(
    freshBlockedMonitorAttempt(run, { ok: false, code: 'stale', message: '', signal }, context),
    null,
  );
  assert.equal(
    freshBlockedMonitorAttempt(
      run,
      { ok: true, code: 'ready', message: '', signal: { ...signal, attemptId: undefined } },
      context,
    ),
    null,
  );
  assert.equal(
    freshBlockedMonitorAttempt(
      run,
      { ok: false, code: 'stale', message: '', signal: { ...signal, contextId: 'other' } },
      context,
    ),
    null,
  );
  assert.equal(
    freshBlockedMonitorAttempt(
      run,
      {
        ok: false,
        code: 'stale',
        message: '',
        signal: { ...signal, timestamp: oldSignal.timestamp },
      },
      context,
    ),
    null,
  );
});

test('blocked monitor replay accepts the blocked attempt completing later without ./mark start', () => {
  const blocked = { status: 'blocked', attemptId: 'a1', timestamp: '2026-09-23T01:00:00Z' };
  const run = {
    status: 'blocked' as const,
    steps: [
      { name: 'monitor', status: 'done', outputs: { workerSignal: blocked } },
    ] as Run['steps'],
  };
  const context = { id: 'worker', role: 'fix-bug' } as const;
  const probe = (signal: Record<string, unknown>) =>
    freshBlockedMonitorAttempt(
      run,
      { ok: true, code: 'ready', message: '', signal: signal as never },
      context,
    );
  const complete = { status: 'complete', attemptId: 'a1', timestamp: '2026-09-23T01:05:00Z' };

  assert.deepEqual(probe(complete), complete);
  assert.deepEqual(probe({ ...complete, status: 'done' }), { ...complete, status: 'done' });
  // Still the blocked attempt unless it finished, and only after the block.
  assert.equal(probe({ ...complete, status: 'running' }), null);
  assert.equal(probe({ ...complete, status: 'blocked' }), null);
  assert.equal(probe({ ...complete, timestamp: blocked.timestamp }), null);
});

test('blocked monitor replay needs the recorded proof plan and fresh healthy leases', () => {
  const run = {
    id: 'blocked-run',
    slotId: 'slot-a',
    steps: [{ name: 'monitor', status: 'done', completedAt: '2026-09-23T01:00:00Z' }],
  } as Run;
  const status = {
    proofPlans: {
      [run.id]: {
        slotId: run.slotId,
        ownerRunId: run.id,
        requirements: [{ capabilityId: 'browser-cdp' }],
      },
    },
    leases: [
      {
        capabilityId: 'browser-cdp',
        owner: { runId: run.id },
        state: 'acquired',
        health: { state: 'healthy', checkedAt: '2026-09-23T01:01:00Z' },
      },
    ],
  } as unknown as RuntimeCapabilityStatusResult;
  assert.equal(blockedMonitorProofReady(run, status), true);
  assert.equal(blockedMonitorProofReady(run, { ...status, proofPlans: {} }), false);
  assert.equal(
    blockedMonitorProofReady(run, { ...status, catalog: [], leases: [], proofPlans: {} }),
    true,
  );
  assert.equal(
    blockedMonitorProofReady(run, {
      ...status,
      proofPlans: { [run.id]: { ...status.proofPlans[run.id], slotId: 'other-slot' } },
    }),
    false,
  );
  status.leases[0].health.checkedAt = '2026-09-23T00:59:00Z';
  assert.equal(blockedMonitorProofReady(run, status), false);
  status.leases[0].health.checkedAt = '2026-09-23T01:01:00Z';
  status.leases[0].health.state = 'unhealthy';
  assert.equal(blockedMonitorProofReady(run, status), false);
});

test('a run blocked before it planned proof re-attaches on a slot with a capability catalog', () => {
  // Run 22e62daa on macpro-mmt-2: catalog [terminal-browser], plans and released
  // leases only for other runs, none for the blocked run.
  const run = makeRun({
    id: 'blocked-before-plan',
    slotId: 'macpro-mmt-2',
    steps: [{ name: 'monitor', status: 'done', completedAt: '2026-10-18T06:20:00Z' }],
  });
  const provenance = {
    project: 'va-mmcx-terminal-farm',
    providerId: 'terminal-browser',
    version: '1',
    digest: 'digest',
  };
  const status: RuntimeCapabilityStatusResult = {
    slotId: 'macpro-mmt-2',
    project: 'va-mmcx-terminal-farm',
    catalog: [
      {
        id: 'terminal-browser',
        project: 'va-mmcx-terminal-farm',
        label: 'Assigned running Terminal browser',
        version: '1',
        dependencies: [],
        sharePolicy: 'exclusive',
        cost: {
          class: 'low',
          resources: [{ id: 'browser', access: 'exclusive', kind: 'process', scope: 'slot' }],
        },
        actions: {
          acquire: { kind: 'resource', resourceId: 'browser', action: 'health' },
          health: { kind: 'resource', resourceId: 'browser', action: 'health' },
          release: { kind: 'slot-action', actionId: 'terminal-browser-retain' },
        },
        releaseEffects: ['Release the browser reservation; preserve the running browser'],
        keepWarmMs: 0,
        provenance,
        availability: { state: 'available' },
      },
    ],
    proofPlans: {
      'other-run': {
        version: 1,
        slotId: 'macpro-mmt-2',
        ownerRunId: 'other-run',
        createdAt: '2026-10-18T05:00:00Z',
        requirements: [{ capabilityId: 'terminal-browser', reason: 'recipe', mode: 'visual' }],
      },
    },
    leases: [
      {
        id: 'cap-other',
        slotId: 'macpro-mmt-2',
        project: 'va-mmcx-terminal-farm',
        capabilityId: 'terminal-browser',
        owner: { runId: 'other-run' },
        state: 'released',
        referenceCount: 0,
        parameters: {},
        provenance,
        health: { state: 'unknown' },
        dependencyLeaseIds: [],
        updatedAt: '2026-10-18T05:30:00Z',
        releasedAt: '2026-10-18T05:30:00Z',
      },
    ],
    events: [],
  };
  assert.equal(blockedMonitorProofReady(run, status), true);

  // A lease of its own means it planned resources: #721's fresh-lease rule applies.
  const ownLease = { ...status.leases[0], owner: { runId: run.id } };
  assert.equal(blockedMonitorProofReady(run, { ...status, leases: [ownLease] }), false);
});

test('uncertain dispatch requires the structured marker, never the failure prose', () => {
  const signal = {
    status: 'running',
    attemptId: 'attempt-1',
    timestamp: '2026-09-03T08:00:01.000Z',
  };
  // Runner-layer prose is not evidence: a run failed before the marker existed
  // is simply not adoptable and takes the ordinary fresh-dispatch replay path.
  const proseOnly = {
    steps: [
      {
        name: 'dispatch',
        status: 'failed' as const,
        startedAt: '2026-09-03T08:00:00.000Z',
        detail: 'Exact prompt acknowledgement did not arrive. Pane output cannot replace it.',
      },
    ],
  };
  assert.equal(canAdoptTaskSignalAfterUncertainDispatch(proseOnly, signal), false);
});

test('an unreadable adoption probe fails the replay closed', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });
  updateRun(run.id, {
    status: 'failed',
    // No such slot: loadSlotVars throws, which is an unexpected probe failure.
    slotId: 'no-such-slot-for-probe',
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Worker',
        slotId: 'no-such-slot-for-probe',
        runId: run.id,
        status: 'working',
        signalFile: '.task/SIGNAL.json',
      },
    ],
    steps: [
      { name: 'dispatch', status: 'failed', outputs: { promptDeliveryUncertain: true } },
      { name: 'monitor', status: 'pending' },
    ],
  });

  // The dispatch it would replay had uncertain delivery, so a worker may be
  // running the prompt right now. Replay must refuse rather than resend blind.
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'dispatch' }, () => {}),
    ReplayTaskSignalProbeError,
  );
  assert.equal(getRun(run.id)?.steps[0]?.status, 'failed');
});

test('a requested fresh dispatch skips adoption instead of failing on the probe', async (t) => {
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now() + 1}`,
  });
  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });
  updateRun(run.id, {
    status: 'failed',
    slotId: 'no-such-slot-for-probe',
    engineState: { flags: { warmSessionReuse: true } },
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Worker',
        slotId: 'no-such-slot-for-probe',
        runId: run.id,
        status: 'working',
        signalFile: '.task/SIGNAL.json',
      },
    ],
    steps: [
      { name: 'dispatch', status: 'failed', outputs: { promptDeliveryUncertain: true } },
      { name: 'monitor', status: 'pending' },
    ],
  });

  // The operator already chose to abandon the old worker, so an unreadable
  // signal changes nothing. The replay may still fail later on the dead slot,
  // but never on the adoption probe.
  const error = await runReplayStep(
    { runId: run.id, stepName: 'dispatch', freshDispatch: true },
    () => {},
  ).then(
    () => null,
    (err: unknown) => err,
  );
  assert.equal(error instanceof ReplayTaskSignalProbeError, false);
});

test('an adopted dispatch stays failed until the replay claims its slot', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now() + 2}`,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });
  updateRun(run.id, {
    steps: [
      { name: 'prepare', status: 'running' },
      { name: 'dispatch', status: 'failed' },
      { name: 'monitor', status: 'pending' },
    ],
  });

  normalizeReplayPrerequisites(
    run.id,
    getRun(run.id)!,
    ['prepare', 'dispatch', 'monitor'],
    2,
    'monitor',
    'dispatch',
  );

  const steps = getRun(run.id)!.steps;
  assert.equal(steps.find((step) => step.name === 'prepare')?.status, 'done');
  // Deferred: the adopted dispatch is only recorded once the slot reclaim wins,
  // so a refused replay never leaves a successful dispatch behind.
  assert.equal(steps.find((step) => step.name === 'dispatch')?.status, 'failed');
});

test('an adopted live worker keeps an eval replay at monitor instead of prepare', () => {
  const base = { targetIdx: 2, prepareIdx: 0, monitorIdx: 2 };
  // Without adoption the eval harness reinstall still routes through prepare.
  assert.equal(
    shouldRerouteEvalReplayToPrepare({ ...base, evalExperiment: true, adoptedLiveWorker: false }),
    true,
  );
  // A proven-live worker must not be relaunched over by a prepare restart.
  assert.equal(
    shouldRerouteEvalReplayToPrepare({ ...base, evalExperiment: true, adoptedLiveWorker: true }),
    false,
  );
  assert.equal(
    shouldRerouteEvalReplayToPrepare({ ...base, evalExperiment: false, adoptedLiveWorker: false }),
    false,
  );
});

test('a requested fresh dispatch never adopts a signal, readable or not', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now() + 3}`,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });
  updateRun(run.id, {
    status: 'failed',
    slotId: 'no-such-slot-for-probe',
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Worker',
        slotId: 'no-such-slot-for-probe',
        runId: run.id,
        status: 'working',
        signalFile: '.task/SIGNAL.json',
      },
    ],
    steps: [
      { name: 'dispatch', status: 'failed', outputs: { promptDeliveryUncertain: true } },
      { name: 'monitor', status: 'pending' },
    ],
  });
  const current = getRun(run.id)!;
  // Without fresh dispatch the probe runs and fails closed on the dead slot.
  await assert.rejects(
    () => readAdoptableTaskSignal(current, { freshDispatch: false }),
    ReplayTaskSignalProbeError,
  );
  // With fresh dispatch the probe is never attempted: the operator asked to
  // abandon the old worker, so even a readable signal must not be adopted.
  assert.equal(await readAdoptableTaskSignal(current, { freshDispatch: true }), null);
});

test('human-gate replay drops a consumed reviewer plan', () => {
  const reset = resetPublishGateApprovalForReplay({
    publishGate: {
      reviewSequence: [{ runner: 'claude', model: null, effort: null, mode: 'cold' as const }],
      reviewSequenceRequestedAt: '2026-09-03T05:00:00.000Z',
      publicationStatus: 'not_published',
    },
  });

  assert.equal(reset?.publishGate?.reviewSequence, undefined);
  assert.equal(reset?.publishGate?.reviewSequenceRequestedAt, undefined);
});

test('human-gate replay preserves the reviewer plan for an active fix recovery', () => {
  const reset = resetPublishGateApprovalForReplay(
    {
      publishGate: {
        reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'cold' as const }],
        reviewSequenceRequestedAt: '2026-09-03T05:00:00.000Z',
        publicationStatus: 'not_published',
      },
    },
    true,
  );

  assert.deepEqual(reset?.publishGate?.reviewSequence, [
    { runner: 'codex', model: null, effort: null, mode: 'cold' as const },
  ]);
  assert.equal(reset?.publishGate?.reviewSequenceRequestedAt, '2026-09-03T05:00:00.000Z');
});

test('runReplayStep abandons a retained handoff and re-enters normal dispatch', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const taskFile = '/tmp/farmslot-fresh-dispatch/TASK.md';
  await writeFile(
    statusFile,
    `${JSON.stringify({
      slots: [{ slot: 'macwork-ff-fresh-dispatch', lifecycle: 'busy', current_run_id: run.id }],
    })}\n`,
  );
  updateRun(run.id, {
    status: 'failed',
    error: 'Retained runner handoff was not acknowledged',
    slotId: 'macwork-ff-fresh-dispatch',
    taskFile,
    engineState: {
      generation: 2,
      flags: {
        skipPrepare: true,
        warmSessionReuse: true,
        warmHandoffSucceeded: false,
      },
    },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' || step.name === 'write-task' || step.name === 'prepare'
        ? {
            ...step,
            status: 'done',
            outputs: step.name === 'write-task' ? { taskFile } : step.outputs,
          }
        : step.name === 'dispatch'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  const replayed = await runReplayStep(
    {
      runId: run.id,
      stepName: 'dispatch',
      freshDispatch: true,
      triggeredBy: 'operator',
    },
    () => {},
  );

  assert.equal(replayed.run.status, 'dispatching');
  assert.equal(replayed.run.error, undefined);
  assert.equal(replayed.run.engineState?.flags?.warmSessionReuse, undefined);
  assert.equal(replayed.run.engineState?.flags?.warmHandoffSucceeded, undefined);
  assert.equal(replayed.run.engineState?.flags?.skipPrepare, undefined);
  assert.equal(replayed.run.steps.find((step) => step.name === 'dispatch')?.status, 'pending');
});

test('a replay a service principal requests drives the run under its stored ownership', async (t) => {
  // Run 22e62daa: farm-automation's resume re-attached the monitor, and the
  // engine it started resolved the review owner as farm-automation.
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const taskFile = '/tmp/farmslot-replay-originator/TASK.md';
  await writeFile(
    statusFile,
    `${JSON.stringify({
      slots: [{ slot: 'macwork-ff-replay-originator', lifecycle: 'busy', current_run_id: run.id }],
    })}\n`,
  );
  updateRun(run.id, {
    status: 'failed',
    slotId: 'macwork-ff-replay-originator',
    taskFile,
    // A fresh dispatch replay needs no slot probe, only a retained handoff.
    engineState: {
      generation: 1,
      flags: { skipPrepare: true, warmSessionReuse: true, warmHandoffSucceeded: false },
    },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' || step.name === 'write-task' || step.name === 'prepare'
        ? {
            ...step,
            status: 'done',
            outputs: step.name === 'write-task' ? { taskFile } : step.outputs,
          }
        : step.name === 'dispatch'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });
  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) await evictTestRun(run.id, 'failed');
  });
  const automation: Principal = {
    id: 'farm-automation',
    subject: { type: 'service', displayName: 'farm-automation' },
    roles: [{ role: 'operator', scope: { kind: 'global' } }],
  };
  let engineOriginator: WorkOriginator | undefined;

  await runWithSessionOriginator(automation, () =>
    runReplayStep(
      { runId: run.id, stepName: 'dispatch', freshDispatch: true, triggeredBy: 'operator' },
      () => {},
      {
        startEngine: async () => {
          engineOriginator = currentSessionOriginator();
        },
      },
    ),
  );

  assert.deepEqual(engineOriginator, { kind: 'system' });
});

test('blocked monitor only reclaims the same live worker at claim time', () => {
  assert.equal(
    blockedMonitorOwnsSlot({ current_run_id: 'run-a', lifecycle: 'busy' }, 'run-a'),
    true,
  );
  assert.equal(
    blockedMonitorOwnsSlot({ current_run_id: 'run-a', lifecycle: 'held' }, 'run-a'),
    true,
  );
  assert.equal(
    blockedMonitorOwnsSlot({ current_run_id: null, lifecycle: 'ready' }, 'run-a'),
    false,
  );
  assert.equal(
    blockedMonitorOwnsSlot({ current_run_id: 'run-b', lifecycle: 'busy' }, 'run-a'),
    false,
  );
  assert.equal(
    blockedMonitorOwnsSlot(
      { current_run_id: 'run-a', lifecycle: 'busy', phase: 'releasing' },
      'run-a',
    ),
    false,
  );
});

test('replaySlotReclaimCheck rejects slots owned by another active run', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'run-b', lifecycle: 'busy' }, 'run-a'),
    {
      ok: false,
      reason: 'owned-by-other',
      owner: 'run-b',
    },
  );
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'run-a', lifecycle: 'busy' }, 'run-a'),
    {
      ok: true,
    },
  );
  assert.deepEqual(replaySlotReclaimCheck({ current_run_id: null, lifecycle: 'ready' }, 'run-a'), {
    ok: true,
  });
  assert.deepEqual(replaySlotReclaimCheck({ current_run_id: null, lifecycle: 'busy' }, 'run-a'), {
    ok: false,
    reason: 'not-reclaimable',
    lifecycle: 'busy',
  });
});

test('replaySlotReclaimCheck refuses a slot reserved for a foreign handoff', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ lifecycle: 'busy', handoff_run_id: 'other-run' }, 'run-1'),
    { ok: false, reason: 'owned-by-other', owner: 'other-run' },
  );
  // The reservation holder itself may proceed to the normal owner checks.
  assert.deepEqual(
    replaySlotReclaimCheck({ lifecycle: 'ready', handoff_run_id: 'run-1' }, 'run-1'),
    { ok: true },
  );
});

test('replaySlotReclaimCheck refuses a slot mid-release even for its own run id', () => {
  assert.deepEqual(
    replaySlotReclaimCheck(
      { phase: 'releasing', lifecycle: 'busy', current_run_id: 'run-1' },
      'run-1',
    ),
    { ok: false, reason: 'not-reclaimable', lifecycle: 'busy/releasing' },
  );
});

test('replaySlotReclaimCheck allows reclaim when slot owner run record is missing', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'ghost-run', lifecycle: 'busy' }, 'run-a', {
      ownerRunExists: () => false,
    }),
    { ok: true },
  );
});

test(
  'review replay coalesces preflight and active fix observation without a second generation',
  { timeout: 2_000 },
  async (t) => {
    const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    const previousTestContext = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = '1';
    process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
    const run = createRun({
      flowType: 'fix-bug',
      project: 'example-mobile-farm',
      ticketOrPr: 'PROJ-2585',
    });
    let release: (() => void) | undefined;
    const replayTasks: Promise<unknown>[] = [];
    let finishDriver!: () => void;
    const driver = new Promise<void>((resolve) => {
      finishDriver = resolve;
    });
    t.after(async () => {
      release?.();
      finishDriver();
      await Promise.allSettled(replayTasks);
      if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
      else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
      if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = previousTestContext;
      await evictTestRun(run.id, 'failed');
    });
    updateRun(run.id, {
      status: 'failed',
      engineState: { generation: 2 },
      steps: run.steps.map((step) => ({
        ...step,
        status: step.name === 'review' ? 'failed' : 'done',
      })),
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredReplay = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const params = { runId: run.id, stepName: 'review' };
    const replay = runReplayStep(params, () => {}, {
      startEngine: () => driver,
      afterGenerationBump: async () => {
        entered();
        await held;
      },
    });
    replayTasks.push(replay);
    await enteredReplay;
    const generation = getRun(run.id)?.engineState?.generation;
    const duplicate = runReplayStep(params, () => {}, {
      afterGenerationBump: async () => {
        assert.fail('duplicate replay must not bump generation');
      },
    });
    replayTasks.push(duplicate);
    release?.();
    await Promise.all([replay, duplicate]);
    assert.equal(getRun(run.id)?.engineState?.generation, generation);
    assert.equal(getRun(run.id)?.recoveryAttempts?.length, 1);

    for (const status of ['reviewing', 'fixing', 'reconciling'] as const) {
      updateRun(run.id, { status });
      const before = structuredClone(getRun(run.id));
      const result = await runReplayStep(params, () =>
        assert.fail('duplicate replay must not emit'),
      );
      assert.deepEqual(result.run, before);
      assert.deepEqual(getRun(run.id), before);
    }

    finishDriver();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Simulate retained state after observer exit/restart. The durable attempt
    // still says started, but manual recovery must create a new observer.
    for (const status of ['fixing', 'reconciling'] as const) {
      updateRun(run.id, { status });
      const priorGeneration = getRun(run.id)?.engineState?.generation ?? 0;
      await runReplayStep(params, () => {});
      assert.equal(getRun(run.id)?.engineState?.generation, priorGeneration + 1);
    }

    const current = getRun(run.id)!;
    updateRun(run.id, {
      engineState: {
        ...current.engineState,
        publishGate: {
          reviewRecovery: {
            status: 'operator-required',
            attempts: 1,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      },
    });
    await runReplayStep(params, () => {});
    assert.equal(getRun(run.id)?.engineState?.generation, (generation ?? 0) + 3);
    assert.equal(getRun(run.id)?.recoveryAttempts?.length, 4);

    updateRun(run.id, { status: 'failed' });
    await runReplayStep(params, () => {});
    assert.equal(getRun(run.id)?.engineState?.generation, (generation ?? 0) + 4);
    assert.equal(getRun(run.id)?.recoveryAttempts?.length, 5);
  },
);

test('in-flight replay refuses revive after operator force-complete', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-2585',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      backlogReconcilePending: undefined,
    });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'review exhausted',
    engineState: { generation: 2 },
    steps: run.steps.map((step) =>
      step.name === 'review'
        ? { ...step, status: 'failed' }
        : step.name === 'complete' ||
            step.name === 'human-gate' ||
            step.name === 'finalize' ||
            step.name === 'ci-watch'
          ? { ...step, status: 'skipped' }
          : { ...step, status: 'done' },
    ),
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let replayEntered = false;
  const replay = runReplayStep({ runId: run.id, stepName: 'review' }, () => {}, {
    afterGenerationBump: async () => {
      replayEntered = true;
      await held;
    },
  });
  while (!replayEntered) {
    await Promise.race([
      new Promise<void>((resolve) => setImmediate(resolve)),
      replay.then(
        () => {
          throw new Error('replay finished before generation-bump hook');
        },
        (err: unknown) => {
          throw err;
        },
      ),
    ]);
  }

  const completed = await runForceComplete({ runId: run.id, prNumber: 35145 }, () => {});
  assert.equal(completed.run.status, 'done');
  const forceGen = completed.run.engineState?.generation;
  release();
  await assert.rejects(replay, /force-completed and cannot be replayed/);
  const stored = getRun(run.id)!;
  assert.equal(stored.status, 'done');
  assert.equal(stored.engineState?.generation, forceGen);
  assert.equal(stored.steps.find((step) => step.name === 'review')?.status, 'skipped');
});

test('runReplayStep refuses a force-completed run before mutating', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-2586',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      backlogReconcilePending: undefined,
    });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'review exhausted',
    engineState: { generation: 2 },
  });
  await runForceComplete({ runId: run.id, prNumber: 35145 }, () => {});
  const generation = getRun(run.id)!.engineState?.generation;
  let bumpHook = false;
  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'review' }, () => {}, {
        afterGenerationBump: async () => {
          bumpHook = true;
        },
      }),
    /force-completed and cannot be replayed/,
  );
  assert.equal(bumpHook, false);
  assert.equal(getRun(run.id)?.engineState?.generation, generation);
});

test('runReplayStep still allows an ordinary done run', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-2587',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      backlogReconcilePending: undefined,
    });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    metrics: { ...run.metrics, outcome: 'success' },
    engineState: { generation: 4 },
    steps: run.steps.map((step) =>
      step.name === 'finalize' || step.name === 'ci-watch'
        ? { ...step, status: 'pending' }
        : { ...step, status: 'done' },
    ),
  });
  const result = await runReplayStep({ runId: run.id, stepName: 'finalize' }, () => {});
  assert.notEqual(result.run.status, 'done');
  assert.equal(result.run.engineState?.operatorForceCompleted, undefined);
});

test('runReplayStep rejects read-only imported reference runs', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `REF-${Date.now()}`,
  });
  updateRun(run.id, { readOnly: true, status: 'done' });
  t.after(async () => {
    if (getRun(run.id)) {
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'prepare' }, () => {}),
    /read-only imported reference and cannot be replayed/,
  );
});

test('replaying a cancelled graph run reclaims the node instead of double-dispatching', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4102',
    prNumber: 4102,
    workGraphId: 'wg_replay_reclaim',
    workNodeId: 'wn_replay_reclaim',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: 'Cancelled by user',
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  // Cancelling releases the node, so the scheduler re-queues its work. That queue
  // item must not survive the run being revived, or the node dispatches twice.
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4102',
      workGraphId: 'wg_replay_reclaim',
      workNodeId: 'wn_replay_reclaim',
    },
    { kind: 'system' },
  );
  assert.ok(
    getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_reclaim'),
    'precondition: the graph has re-queued the node',
  );

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  assert.ok(
    !getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_reclaim'),
    'the duplicate queue item was reclaimed by the revived run',
  );
});

test('a replay that fails validation leaves the re-queued node intact', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4103',
    prNumber: 4103,
    workGraphId: 'wg_replay_strand',
    workNodeId: 'wn_replay_strand',
  });
  updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4103',
      workGraphId: 'wg_replay_strand',
      workNodeId: 'wn_replay_strand',
    },
    { kind: 'system' },
  );

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });

  // Fails on an unknown step, after the old reclaim point but before the run revives.
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'not-a-step' }, () => {}),
    /Step not found: not-a-step/,
  );
  // The run never went live, so its replacement work must still be queued.
  assert.equal(getRun(run.id)?.status, 'cancelled');
  assert.ok(
    getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_strand'),
    'a failed replay must not strand the node by dropping its queue item',
  );
});

test('replay revokes a claimed dispatching row and revives the cancelled run', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104',
    prNumber: 4104,
    workGraphId: 'wg_replay_handoff',
    workNodeId: 'wn_replay_handoff',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4104',
      workGraphId: 'wg_replay_handoff',
      workNodeId: 'wn_replay_handoff',
    },
    { kind: 'system' },
  );
  // Claim through the public API (not a direct status mutate) so holder/epoch
  // persistence matches production. Replay must revoke it and revive the run.
  const staged = getQueueSnapshot().find((item) => item.workNodeId === 'wn_replay_handoff');
  assert.ok(staged);
  const claim = claimQueueItem(staged.id, 'stale-dispatcher');
  assert.ok(claim);

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  assert.ok(
    !getQueueSnapshot().some((item) => item.workNodeId === 'wn_replay_handoff'),
    'claimed replacement row was reclaimed',
  );
});

test('replay refuses when a live Run owns the node even without a queue row', async (t) => {
  const cancelled = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-live-owner',
    prNumber: 4104,
    workGraphId: 'wg_replay_live_owner',
    workNodeId: 'wn_replay_live_owner',
  });
  updateRun(cancelled.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  const genBefore = getRun(cancelled.id)?.engineState?.generation ?? 0;
  const stepsBefore = getRun(cancelled.id)
    ?.steps.map((s) => s.status)
    .join(',');
  // Successful handoff already dropped the queue row; a later replacement Run is live.
  const live = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-live-owner',
    prNumber: 4104,
    workGraphId: 'wg_replay_live_owner',
    workNodeId: 'wn_replay_live_owner',
  });

  t.after(async () => {
    for (const id of [cancelled.id, live.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'cancelled', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await assert.rejects(
    () =>
      runReplayStep(
        { runId: cancelled.id, stepName: 'ci-watch', triggeredBy: 'operator' },
        () => {},
      ),
    /already owned by live run/,
  );
  assert.equal(getRun(cancelled.id)?.status, 'cancelled');
  assert.equal(getRun(live.id)?.status, 'created');
  // Rejection must not mutate the cancelled run (generation / step reset).
  assert.equal(getRun(cancelled.id)?.engineState?.generation ?? 0, genBefore);
  assert.equal(
    getRun(cancelled.id)
      ?.steps.map((s) => s.status)
      .join(','),
    stepsBefore,
  );
  assert.equal(getRun(cancelled.id)?.recoveryProposal, undefined);
});

test('replay refuses when replacement row already has a stamped runId', async (t) => {
  const cancelled = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-stamped',
    prNumber: 4104,
    workGraphId: 'wg_replay_stamped',
    workNodeId: 'wn_replay_stamped',
  });
  updateRun(cancelled.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4104-stamped',
      workGraphId: 'wg_replay_stamped',
      workNodeId: 'wn_replay_stamped',
    },
    { kind: 'system' },
  );
  const staged = getQueueSnapshot().find((item) => item.workNodeId === 'wn_replay_stamped');
  assert.ok(staged);
  const claim = claimQueueItem(staged.id, 'dispatcher');
  assert.ok(claim);
  const handedOff = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4104-stamped',
    prNumber: 4104,
    workGraphId: 'wg_replay_stamped',
    workNodeId: 'wn_replay_stamped',
  });
  stampQueueItemRunId(claim.itemId, handedOff.id);

  t.after(async () => {
    for (const id of [cancelled.id, handedOff.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'cancelled', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
    const leftover = getQueueSnapshot().find((item) => item.workNodeId === 'wn_replay_stamped');
    if (leftover) {
      removeQueueItemInternal(leftover.id, 'test-cleanup');
    }
  });

  await assert.rejects(
    () =>
      runReplayStep(
        { runId: cancelled.id, stepName: 'ci-watch', triggeredBy: 'operator' },
        () => {},
      ),
    // Live owner check (no queue required) or stamped-row check both refuse.
    /already owned by live run|redispatched to run/,
  );
  assert.equal(getRun(cancelled.id)?.status, 'cancelled');
  assert.ok(getRun(handedOff.id));
});

test('replay does not reclaim a sibling launch-plan candidate sharing the node', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4105',
    prNumber: 4105,
    workGraphId: 'wg_replay_sibling',
    workNodeId: 'wn_replay_sibling',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  // Comparison candidates are built with the baseline's graph and node ids, so a
  // graph/node-only reclaim would delete this row — and the candidate projection
  // would keep the dead queue id, so the work never comes back.
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4105',
      workGraphId: 'wg_replay_sibling',
      workNodeId: 'wn_replay_sibling',
      launchPlanId: 'lp_1',
      launchCandidateId: 'cand_comparison',
    },
    { kind: 'system' },
  );

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
  assert.ok(
    getQueueSnapshot().some((item) => item.launchCandidateId === 'cand_comparison'),
    'the comparison candidate must survive the baseline being replayed',
  );
});

test('replay does not reclaim a replacement plan reusing the same candidate id', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-4106',
    prNumber: 4106,
    workGraphId: 'wg_replay_plan',
    workNodeId: 'wn_replay_plan',
    launchPlanId: 'lp_superseded',
    launchCandidateId: 'cand_shared',
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  // Candidate ids are scoped to their plan (launchCandidateKey keys on
  // [backlogItemId, launchPlanId, candidateId]), so a replacement plan may reuse
  // one. This row belongs to the CURRENT plan and must not be taken by a run from
  // the superseded plan — the current plan would keep a dead queue id, and the
  // revived run's observations are rejected as foreign-plan.
  addItem(
    {
      project: 'farmslot-farm',
      flowType: 'update-branch',
      ticketOrPr: 'PROJ-4106',
      workGraphId: 'wg_replay_plan',
      workNodeId: 'wn_replay_plan',
      launchPlanId: 'lp_current',
      launchCandidateId: 'cand_shared',
    },
    { kind: 'system' },
  );

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.ok(
    getQueueSnapshot().some((item) => item.launchPlanId === 'lp_current'),
    "the current plan's work must survive a replay from the superseded plan",
  );
});

test('runReplayStep rejects monitor replay when dispatch is still running', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'dispatching',
    slotId: 'macwork-ff-1',
    steps: run.steps.map((step) =>
      step.name === 'write-task' || step.name === 'find-slot' || step.name === 'prepare'
        ? { ...step, status: 'done' }
        : step.name === 'dispatch'
          ? { ...step, status: 'running', startedAt: new Date().toISOString() }
          : step,
    ),
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {}),
    /dispatch has not completed/,
  );
});

test('runReplayStep rejects non-authorized triggeredBy actor before replay', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });
  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'llm' as any }, () => {}),
    /Invalid runReplayStep triggeredBy/,
  );
});

test('runReplayStep does not open a recovery attempt before replay validation passes', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Math.floor(Date.now() / 1000)}`,
  });
  const badTicketRun = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `not-a-ticket-${Date.now()}`,
  });
  const events: any[] = [];
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
    if (getRun(badTicketRun.id)) {
      updateRun(badTicketRun.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(badTicketRun.id);
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'not-a-step' }, (event, payload) =>
        events.push({ event, payload }),
      ),
    /Step not found: not-a-step/,
  );

  assert.equal(events.length, 0);
  assert.equal(getRun(run.id)?.recoveryProposal?.status, undefined);
  assert.equal(getRun(run.id)?.recoveryAttempts?.length ?? 0, 0);

  await assert.rejects(
    () =>
      runReplayStep({ runId: badTicketRun.id, stepName: 'prepare' }, (event, payload) =>
        events.push({ event, payload }),
      ),
    /Cannot replay run:/,
  );
  assert.equal(events.length, 0);
  assert.equal(getRun(badTicketRun.id)?.recoveryProposal?.status, undefined);
  assert.equal(getRun(badTicketRun.id)?.recoveryAttempts?.length ?? 0, 0);
});

test('runReplayStep allows prepare replay for backlog-dispatched MANUAL-* runs', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    backlogItemId: 'backlog-item-1',
  });
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-1', lifecycle: 'busy', current_run_id: run.id }] },
      null,
      2,
    ) + '\n',
  );
  updateRun(run.id, {
    status: 'failed',
    slotId: 'macwork-ff-1',
    taskFile: '/tmp/farmslot-task/TASK.md',
    steps: run.steps.map((step) =>
      step.name === 'find-slot' || step.name === 'write-task'
        ? { ...step, status: 'done', completedAt: new Date().toISOString() }
        : step.name === 'prepare'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'preparing');
});

test('runReplayStep still rejects MANUAL-* replay without backlogItemId', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep still rejects PR-bound replays without a linked prNumber', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep still rejects write-task replay for chained PR-bound runs with Jira ticketOrPr', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
    prNumber: 3398,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep allows chained PR-bound replays when prNumber is already linked', async (t) => {
  const run = createRun({
    flowType: 'update-branch',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
    prNumber: 3398,
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: 'Cancelled by user',
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'cancelled');
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
});

test('runReplayStep restores taskFile from completed write-task output for downstream replays', async (t) => {
  const taskFile = '/tmp/farmslot-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'No task file specified',
    taskFile: null,
    steps: run.steps.map((step) =>
      step.name === 'write-task'
        ? { ...step, status: 'done', outputs: { taskFile } }
        : step.name === 'prepare'
          ? { ...step, status: 'done' }
          : step.name === 'dispatch'
            ? { ...step, status: 'failed' }
            : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' }, () => {});

  assert.equal(getRun(run.id)?.taskFile, taskFile);
});

test('runReplayStep moves terminal runs back to the active replay phase immediately', async (t) => {
  const taskFile = '/tmp/farmslot-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'dispatch failed',
    taskFile,
    steps: run.steps.map((step) =>
      step.name === 'write-task' || step.name === 'prepare'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'dispatch'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });
  const emittedStatuses: string[] = [];

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' },
    (event, payload) => {
      if (event === Events.RUN_UPDATED) {
        emittedStatuses.push((payload as { run: { status: string } }).run.status);
      }
    },
  );

  assert.equal(emittedStatuses[0], 'dispatching');
});

test('runReplayStep normalizes stale earlier steps when replaying from a later step', async (t) => {
  const previousDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  process.env.NODE_TEST_CONTEXT = '1';
  t.after(() => {
    if (previousDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = previousDisableStart;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  });
  const taskFile = '/tmp/farmslot-stale-monitor-task/TASK.md';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    // Lifecycle-only retained fixture predates frozen dispatch contracts.
    recordedEvidenceContractVersion: 0,
    status: 'blocked',
    error: 'monitor timed out',
    taskFile,
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'monitor'
          ? { ...step, status: 'running', startedAt: '2026-06-22T12:00:00.000Z' }
          : step.name === 'review'
            ? { ...step, status: 'failed', detail: 'retry requested' }
            : step,
    ),
  });
  const emittedStatuses: string[] = [];

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'review', triggeredBy: 'operator' },
    (event, payload) => {
      if (event === Events.RUN_UPDATED) {
        emittedStatuses.push((payload as { run: { status: string } }).run.status);
      }
    },
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.steps.find((step) => step.name === 'monitor')?.status, 'done');
  assert.equal(
    replayed.steps.find((step) => step.name === 'monitor')?.outputs?.replayPrerequisiteNormalized,
    true,
  );
  assert.equal(replayed.steps.find((step) => step.name === 'review')?.status, 'pending');
  assert.equal(emittedStatuses[0], 'reviewing');
});

test('runReplayStep can replace an exhausted runner before review', async (t) => {
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  const taskFile = '/tmp/farmslot-runner-replacement/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    runner: 'grok',
    model: 'grok-4.6',
  });
  updateRun(run.id, {
    // Lifecycle-only retained fixture predates frozen dispatch contracts.
    recordedEvidenceContractVersion: 0,
    status: 'blocked',
    taskFile,
    metrics: {
      ...run.metrics,
      runner: 'grok',
      model: 'grok-4.6',
      runnerSessionId: 'old-grok-session',
      runnerSessionPath: '/tmp/old-grok-session',
    },
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Bugfix',
        status: 'blocked',
        slotId: 'mini-mm-2',
        runId: run.id,
        runner: 'grok',
        model: 'grok-4.6',
        runnerSessionId: 'old-grok-session',
        runnerSessionPath: '/tmp/old-grok-session',
      },
    ],
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch' ||
      step.name === 'monitor'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'review'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await runReplayStep(
    {
      runId: run.id,
      stepName: 'review',
      runner: 'claude',
      model: 'opus',
      triggeredBy: 'operator',
    },
    () => {},
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.metrics.runner, 'claude');
  assert.equal(replayed.metrics.model, 'opus');
  assert.equal(replayed.metrics.runnerSessionId, null);
  assert.equal(replayed.metrics.runnerSessionPath, null);
  const workerContext = replayed.agentContexts?.find((context) => context.role === 'fix-bug');
  assert.equal(workerContext?.runner, 'claude');
  assert.equal(workerContext?.model, 'opus');
  assert.equal(workerContext?.runnerSessionId, null);
  assert.equal(workerContext?.runnerSessionPath, null);
  assert.equal(replayed.status, 'reviewing');
  assert.equal(replayed.steps.find((step) => step.name === 'review')?.status, 'pending');
});

test('runReplayStep rejects an incompatible runner/model override before mutation', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    runner: 'grok',
    model: 'grok-4.6',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const before = structuredClone(getRun(run.id));

  await assert.rejects(
    runReplayStep(
      {
        runId: run.id,
        stepName: 'review',
        runner: 'codex',
        model: 'opus',
      },
      () => {},
    ),
    /does not support model 'opus'/,
  );
  assert.deepEqual(getRun(run.id), before);
});

test('runReplayStep clears stale decisions when replaying task generation', async (t) => {
  const taskFile = '/tmp/farmslot-stale-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const staleDecision: RunDecision = {
    id: 'stale-recipe-strategy',
    type: 'engine_recipe_strategy',
    title: 'Stale recipe strategy',
    description: 'Old decision from a prior task generation',
    actions: [{ id: 'accept', label: 'Use recommended', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: { kind: 'recipe-strategy' } as any,
  };
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    executionTemplate: {
      id: 'fix-bug/default',
      sourceId: 'project:farmslot-farm',
      flow: 'fix-bug',
      platforms: ['*'],
      labels: [],
      relativePath: 'fix-bug.md',
      sha256: 'a'.repeat(64),
    },
    templateProvenance: {
      kind: 'task-template',
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      role: 'worker',
      templatePath: '/tmp/fix-bug.md',
      templateName: 'fix-bug.md',
      contentHash: 'a'.repeat(64),
      source: 'current-project',
      renderedAt: '2026-09-02T00:00:00.000Z',
    },
    decisions: [staleDecision],
    steps: run.steps.map((step) =>
      step.name === 'write-task' ? { ...step, status: 'failed', outputs: { taskFile } } : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.taskFile, null);
  assert.equal(replayed.executionTemplate, undefined);
  assert.equal(replayed.templateProvenance, undefined);
  assert.deepEqual(replayed.decisions, []);
});

test('runReplayStep clears stale publish approval when replaying human gate', async (t) => {
  const taskFile = '/tmp/farmslot-human-gate-task/TASK.md';
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const staleApproval: RunDecision = {
    id: 'stale-approve-publish',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Old approval from a prior gate generation',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:10:00.000Z',
    resolvedAction: 'approve-publish',
    payload: { kind: 'ready' } as any,
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'review',
    'complete',
  ]);
  updateRun(run.id, {
    status: 'failed',
    taskFile,
    decisions: [staleApproval],
    engineState: {
      publishGate: {
        packageId: 'pkg-stale',
        packageHash: 'package-hash-stale',
        approvedPackageHash: 'package-hash-stale',
        approvedAt: '2026-04-15T00:10:00.000Z',
        publicationStatus: 'publish_failed',
        reviews: [],
        reviewRecovery: {
          status: 'operator-required',
          attempts: 3,
          startedAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:10:00.000Z',
          lastError: 'Reviewer result requires operator remediation',
        },
      },
    },
    steps: run.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate' || step.name === 'finalize'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    cancelRunEngine(run.id);
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(replayed.decisions, []);
  assert.equal(replayed.engineState?.publishGate?.publicationStatus, 'not_published');
  assert.equal(replayed.engineState?.publishGate?.approvedAt, undefined);
  assert.equal(replayed.engineState?.publishGate?.approvedPackageHash, undefined);
  assert.equal(replayed.engineState?.publishGate?.reviewRecovery, undefined);
});

test('runReplayStep supersedes a pending human-gate decision instead of deleting it', async (t) => {
  const taskFile = '/tmp/farmslot-human-gate-pending/TASK.md';
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const pendingGate: RunDecision = {
    id: 'pending-gate',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Pending decision owned by a dead engine loop',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-07-18T10:00:00.000Z',
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'review',
    'complete',
  ]);
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    decisions: [pendingGate],
    reviewResult: { recommendation: 'COMMENT', reviewMd: 'Saved report', lineComments: [] },
    metrics: {
      ...run.metrics,
      outcome: 'success',
      disposition: 'already_fixed',
      terminalEvidence: { reportPath: 'artifacts/no-change-report.md' },
    },
    steps: run.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  t.after(async () => {
    cancelRunEngine(run.id);
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  // Retained for audit and closed to concurrent resolution — deleting it both
  // destroyed the trail and let an operator resolve a decision the replayed
  // gate no longer owned.
  const superseded = replayed.decisions.find((d) => d.id === 'pending-gate');
  assert.ok(superseded, 'pending gate decision must be retained');
  assert.equal(superseded.resolvedAction, 'superseded');
  assert.ok(superseded.resolvedAt);
  assert.equal(superseded.context?.supersededBy, 'gate-reentry');
  assert.equal(replayed.metrics.outcome, 'success');
  assert.equal(replayed.reviewResult?.reviewMd, 'Saved report');
  assert.equal(replayed.metrics.disposition, 'already_fixed');
  assert.deepEqual(replayed.metrics.terminalEvidence, {
    reportPath: 'artifacts/no-change-report.md',
  });
});

test('runReplayStep supersedes pending gate decisions before its first awaited operation and reopens them when it fails', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const taskFile = '/tmp/farmslot-human-gate-race/TASK.md';
  const slotOwner = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}1`,
  });
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}2`,
  });
  const pendingGate: RunDecision = {
    id: 'pending-gate-race',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Pending decision that must close before any await',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-07-18T10:00:00.000Z',
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'review',
    'complete',
  ]);
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    slotId: 'macwork-ff-9',
    decisions: [pendingGate],
    steps: run.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  // The slot is owned by ANOTHER live run, so the replay's first awaited
  // operation — the slot re-claim — fails.
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-9', lifecycle: 'busy', current_run_id: slotOwner.id }] },
      null,
      2,
    ) + '\n',
  );
  t.after(async () => {
    cancelRunEngine(run.id);
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    for (const r of [run, slotOwner]) {
      if (getRun(r.id)) {
        updateRun(r.id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(r.id);
      }
    }
  });

  // The hook runs right after the synchronous supersession, before the slot re-claim
  // (the replay's first awaited operation), so it sees what a resolver would see then.
  let duringReplay: RunDecision | undefined;
  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {}, {
        afterGenerationBump: async () => {
          duringReplay = structuredClone(
            getRun(run.id)?.decisions.find((d) => d.id === 'pending-gate-race'),
          );
        },
      }),
    /no longer safely reclaimable/,
  );

  // An operator resolving it during the awaited window can no longer spawn a
  // competing engine loop.
  assert.equal(duringReplay?.resolvedAction, 'superseded');
  assert.equal(duringReplay?.context?.supersededBy, 'gate-reentry');
  // The replay died before reviving the run, so the blocked run gets it back.
  const after = getRun(run.id);
  const reopened = after?.decisions.find((d) => d.id === 'pending-gate-race');
  assert.equal(after?.status, 'blocked');
  assert.equal(reopened?.resolvedAt, undefined);
  assert.equal(reopened?.context?.supersededBy, undefined);
});

test('runReplayStep drops a stale monitor decision when replaying from prepare', async (t) => {
  const taskFile = '/tmp/farmslot-monitor-replay/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  // A monitor-owned handoff decision left unresolved from a prior generation.
  const staleHandoff: RunDecision = {
    id: 'stale-monitor-handoff',
    type: 'monitor_interactive_handoff',
    title: 'Interactive handoff',
    description: 'Prior monitor run left this open',
    actions: [
      { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' as const },
    ],
    createdAt: '2026-04-15T00:00:00.000Z',
  };
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    decisions: [staleHandoff],
    steps: run.steps.map((step) =>
      step.name === 'write-task' ? { ...step, status: 'done', outputs: { taskFile } } : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  // Monitor re-runs from a prepare replay, so its stale handoff must be cleared
  // instead of re-blocking the reset run.
  assert.equal(
    replayed.decisions.some((d) => d.id === 'stale-monitor-handoff'),
    false,
  );
});

test('runReplayStep forces eval worker replays through prepare to reinstall harness', async (t) => {
  const taskFile = '/tmp/farmslot-eval-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-replay-harness',
        experimentKey: 'experiment-key-replay-harness',
        experimentManifestPath: '/tmp/experiment-manifest.json',
        packagePath: '/tmp/candidate.result-package.json',
        candidateStrategyFingerprint: 'fingerprint-replay-harness',
        trialId: 'trial-replay-harness',
      },
    },
    steps: run.steps.map((step) =>
      step.name === 'write-task'
        ? { ...step, status: 'done', outputs: { taskFile } }
        : step.name === 'prepare' || step.name === 'dispatch'
          ? { ...step, status: 'done' }
          : step.name === 'monitor'
            ? { ...step, status: 'failed' }
            : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.taskFile, taskFile);
  assert.equal(replayed.steps.find((step) => step.name === 'write-task')?.status, 'done');
  assert.equal(replayed.steps.find((step) => step.name === 'prepare')?.status, 'pending');
  assert.equal(replayed.steps.find((step) => step.name === 'dispatch')?.status, 'pending');
  assert.equal(replayed.steps.find((step) => step.name === 'monitor')?.status, 'pending');
  assert.equal(replayed.recoveryAttempts?.at(-1)?.stepName, 'prepare');
});

test('blocked eval monitor without a slot restarts at find-slot instead of requiring proof', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'blocked',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-blocked',
        experimentKey: 'experiment-key-blocked',
        experimentManifestPath: '/tmp/experiment-manifest.json',
        packagePath: '/tmp/candidate.result-package.json',
        candidateStrategyFingerprint: 'fingerprint-blocked',
        trialId: 'trial-blocked',
      },
    },
    steps: run.steps.map((step) =>
      step.name === 'monitor'
        ? {
            ...step,
            status: 'done',
            completedAt: '2026-09-23T01:01:00Z',
            outputs: {
              workerSignal: {
                status: 'blocked',
                attemptId: 'old',
                timestamp: '2026-09-23T01:00:00Z',
              },
            },
          }
        : step,
    ),
  });
  t.after(() => evictTestRun(run.id, 'failed'));

  await runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {});
  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, null);
  assert.equal(replayed.recoveryAttempts?.at(-1)?.stepName, 'find-slot');
});

const preparationPolicies = [
  { label: 'default reuse', params: {}, expectedSkipPrepare: true },
  { label: 'explicit preparation', params: { skipPrepare: false }, expectedSkipPrepare: undefined },
  {
    label: 'profile selection',
    params: { prepareProfile: 'attach' },
    expectedSkipPrepare: undefined,
  },
  {
    label: 'explicit skip',
    params: { prepareProfile: 'attach', skipPrepare: true },
    expectedSkipPrepare: true,
  },
];
for (const initialSkipPrepare of [true, undefined]) {
  for (const preparationPolicy of preparationPolicies) {
    test(`runReplayStep honors ${preparationPolicy.label} with ${initialSkipPrepare ? 'retained' : 'absent'} skip flag`, async (t) => {
      const parent = createRun({
        flowType: 'dev',
        project: 'farmslot-farm',
        ticketOrPr: `PROJ-${Date.now()}`,
      });
      const run = createRun({
        flowType: 'pr-complete',
        project: 'farmslot-farm',
        ticketOrPr: 'example-org/example-browser#123456',
        familyId: parent.id,
        parentRunId: parent.id,
        familyRootTicketOrPr: parent.ticketOrPr,
        slotId: 'runner-browser-1',
      });
      updateRun(run.id, {
        status: 'failed',
        error: 'prepare failed',
        engineState: { flags: { warmRecovery: true, skipPrepare: initialSkipPrepare } },
        steps: run.steps.map((step) =>
          step.name === 'find-slot'
            ? { ...step, status: 'done' }
            : step.name === 'write-task' || step.name === 'prepare'
              ? { ...step, status: 'failed' }
              : step,
        ),
      });

      t.after(async () => {
        for (const id of [run.id, parent.id]) {
          if (getRun(id)) {
            updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
            await deleteRun(id);
          }
        }
      });

      await runReplayStep(
        {
          runId: run.id,
          stepName: 'write-task',
          triggeredBy: 'operator',
          ...preparationPolicy.params,
        },
        () => {},
      );

      const replayed = getRun(run.id);
      assert.ok(replayed);
      assert.equal(replayed.engineState?.flags?.skipPrepare, preparationPolicy.expectedSkipPrepare);
      assert.equal(replayed.engineState?.flags?.warmRecovery, true);
    });
  }
}

test('runReplayStep clears skipPrepare when chained follow-up replays from find-slot', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'find-slot failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ? { ...step, status: 'failed' } : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, null);
  assert.equal(replayed.engineState?.flags?.skipPrepare, undefined);
});

// Any run the slot row still names releases it before re-selection, not only a
// blocked one. A release fence the replay cannot take keeps the claim and the binding.
for (const status of ['blocked', 'failed', 'monitoring'] as const) {
  test(`find-slot replay preserves a ${status} run while its old slot is still releasing`, async (t) => {
    const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
    const run = createRun({
      flowType: 'fix-bug',
      project: 'farmslot-farm',
      ticketOrPr: `PROJ-${Date.now()}`,
    });
    const slotId = `macwork-ff-releasing-${status}`;
    updateRun(run.id, { status, slotId });
    await writeFile(
      statusFile,
      `${JSON.stringify({ slots: [{ slot: slotId, lifecycle: 'busy', phase: 'releasing', current_run_id: run.id }] })}\n`,
    );
    t.after(async () => {
      if (priorStatus === null) await rm(statusFile, { force: true });
      else await writeFile(statusFile, priorStatus);
      if (getRun(run.id)) await evictTestRun(run.id, 'failed');
    });

    await assert.rejects(
      runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {}, {
        startEngine: async () => {},
      }),
      // The refusal names its exits: the slot needs its machine back before either works.
      new RegExp(
        `could not be released before restarting this run \\(.+\\)\\. If its machine is offline, bring it back first; then replay again, or discard the workspace through slot\\.release RPC with forceReset:true and expectedRunId:${run.id}`,
      ),
    );
    assert.equal(getRun(run.id)?.slotId, slotId);
    assert.equal(getRun(run.id)?.status, status);
  });
}

test('runReplayStep preserves skipPrepare for review-pr chained follow-up replays', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'write-task failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
});

test('runReplayStep preserves skipPrepare for CI-watch chained follow-up replays', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'write-task failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
  assert.equal(replayed.engineState?.flags?.nudgeReuse, undefined);
});

test('runReplayStep preserves resolved publish approvals for post-gate publish retries', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const approvedDecision: RunDecision = {
    id: 'publish-gate',
    type: 'engine_human_gate',
    title: 'Approve publication',
    description: 'Approve publication',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:01:00.000Z',
    resolvedAction: 'approve-publish',
    payload: { kind: 'ready' } as any,
  };
  const pendingDecision: RunDecision = {
    ...approvedDecision,
    id: 'pending-followup',
    resolvedAt: undefined,
    resolvedAction: undefined,
  };
  updateRun(run.id, {
    status: 'failed',
    error: 'publish failed',
    decisions: [approvedDecision, pendingDecision],
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'finalize', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(
    replayed.decisions.map((decision) => decision.id),
    ['publish-gate', 'pending-followup'],
    'finalize replay should keep the resolved publish approval as well as unresolved decisions',
  );
});

test('runReplayStep keeps unresolved decisions for no-human-gate finalize retries', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
  });
  const resolvedDecision: RunDecision = {
    id: 'old-decision',
    type: 'engine_human_gate',
    title: 'Old decision',
    description: 'Old decision',
    actions: [{ id: 'ok', label: 'OK', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:01:00.000Z',
    resolvedAction: 'ok',
    payload: { kind: 'test' } as any,
  };
  const pendingDecision: RunDecision = {
    ...resolvedDecision,
    id: 'pending-decision',
    resolvedAt: undefined,
    resolvedAction: undefined,
  };
  updateRun(run.id, {
    status: 'failed',
    error: 'publish failed',
    decisions: [resolvedDecision, pendingDecision],
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'finalize', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(
    replayed.decisions.map((decision) => decision.id),
    ['pending-decision'],
    'no-human-gate finalize replay should not clear unresolved decisions by pretending there is a gate boundary',
  );
});

test('runReplayStep rejects monitor replay when dispatch is still pending', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'preparing',
    slotId: 'macwork-ff-4',
    taskFile: '/tmp/TASK.md',
    steps: run.steps.map((step) => {
      if (step.name === 'find-slot' || step.name === 'write-task' || step.name === 'prepare') {
        return { ...step, status: 'done' as const };
      }
      return step;
    }),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {}),
    /dispatch has not completed/,
  );
  assert.equal(getRun(run.id)?.slotId, 'macwork-ff-4');
});

test('runReplayStep preserves worker session state when replaying monitor only', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const priorDisableStart = process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-4', lifecycle: 'ready', current_run_id: null }] },
      null,
      2,
    ) + '\n',
  );
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    runner: 'grok',
    model: 'grok-4.6',
  });
  updateRun(run.id, {
    // Lifecycle-only retained fixture predates frozen dispatch contracts.
    recordedEvidenceContractVersion: 0,
    status: 'failed',
    slotId: 'macwork-ff-4',
    taskFile: '/tmp/TASK.md',
    metrics: {
      ...run.metrics,
      runnerSessionId: 'preserved-session',
      runnerSessionPath: '/tmp/preserved-session',
    },
    reviewResult: { recommendation: 'COMMENT', reviewMd: 'Previous attempt', lineComments: [] },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch'
        ? { ...step, status: 'done' as const }
        : step.name === 'monitor'
          ? { ...step, status: 'failed' as const }
          : step,
    ),
  });

  t.after(async () => {
    if (priorDisableStart === undefined) delete process.env.FARMSLOT_DISABLE_RUN_ENGINE_START;
    else process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = priorDisableStart;
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  await runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.status, 'monitoring');
  assert.equal(replayed.metrics.runnerSessionId, 'preserved-session');
  assert.equal(replayed.metrics.runnerSessionPath, '/tmp/preserved-session');
  assert.equal(
    replayed.reviewResult,
    undefined,
    'A replayed worker attempt must supply new review evidence',
  );
});

test('runReplayStep recovers slotId from find-slot outputs on dispatch replay', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-4', lifecycle: 'ready', current_run_id: null }] },
      null,
      2,
    ) + '\n',
  );

  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'No slot assigned',
    slotId: null,
    taskFile: '/tmp/TASK.md',
    steps: run.steps.map((step) => {
      if (step.name === 'find-slot') {
        return {
          ...step,
          status: 'done' as const,
          outputs: { selectedSlot: 'macwork-ff-4', runner: 'grok', model: 'grok-build' },
        };
      }
      if (step.name === 'write-task' || step.name === 'prepare') {
        return { ...step, status: 'done' as const };
      }
      if (step.name === 'dispatch') {
        return { ...step, status: 'failed' as const, detail: 'No slot assigned' };
      }
      return step;
    }),
  });

  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      await evictTestRun(run.id, 'failed');
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'dispatch', skipPrepare: true, triggeredBy: 'operator' },
    () => {},
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, 'macwork-ff-4');
  assert.notEqual(replayed.steps.find((step) => step.name === 'dispatch')?.status, 'failed');
  cancelRunEngine(run.id);
});

test('a write-task replay re-validates its slot binding before the run reaches prepare', async (t) => {
  // Two runs bound to one slot both failed at write-task, so terminal cleanup
  // freed the slot while each kept its slotId. The first replay must claim the
  // slot; the second must be refused at replay time, not fail inside prepare.
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const slotId = 'macwork-ff-8';
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: slotId, lifecycle: 'ready', current_run_id: null }] },
      null,
      2,
    ) + '\n',
  );
  const failedAtWriteTask = (ticket: string) => {
    const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: ticket });
    return updateRun(run.id, {
      status: 'failed',
      error: 'write-task failed',
      slotId,
      steps: run.steps.map((step) =>
        step.name === 'find-slot'
          ? { ...step, status: 'done' as const, outputs: { selectedSlot: slotId } }
          : step.name === 'write-task'
            ? { ...step, status: 'failed' as const, detail: 'write-task failed' }
            : { ...step, status: 'skipped' as const },
      ),
    });
  };
  const first = failedAtWriteTask(`PROJ-${Date.now()}1`);
  const second = failedAtWriteTask(`PROJ-${Date.now()}2`);
  t.after(async () => {
    for (const run of [first, second]) cancelRunEngine(run.id);
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    for (const run of [first, second]) await evictTestRun(run.id, 'failed');
  });
  const hooks = { startEngine: async () => {} };

  await runReplayStep(
    { runId: first.id, stepName: 'write-task', triggeredBy: 'operator' },
    () => {},
    hooks,
  );
  const slotAfterFirst = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.equal(slotAfterFirst.current_run_id, first.id);

  await assert.rejects(
    () =>
      runReplayStep(
        { runId: second.id, stepName: 'write-task', triggeredBy: 'operator' },
        () => {},
        hooks,
      ),
    new RegExp(`slot ${slotId} is no longer safely reclaimable \\(run ${first.id} holds it\\)`),
  );
  const refused = getRun(second.id);
  assert.ok(refused);
  assert.equal(refused.status, 'failed');
  assert.deepEqual(refused.steps, second.steps);
  assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).slots[0].current_run_id, first.id);
});

/** A refused COMPLETE prerequisite: failed, slot and checkout retained on `slotId`. */
async function retainedCompletionRun(t: test.TestContext, slotId: string): Promise<Run> {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const priorInject = process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  const taskFile = '/tmp/farmslot-retained-completion/TASK.md';
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const completeIdx = created.steps.findIndex((step) => step.name === 'complete');
  const run = updateRun(created.id, {
    status: 'failed',
    error: 'A declared deterministic check has no current passing receipt.',
    taskFile,
    slotId,
    steps: created.steps.map((step, i) =>
      i < completeIdx
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : i === completeIdx
          ? { ...step, status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }
          : { ...step, status: 'skipped' },
    ),
  });
  const row = { lifecycle: 'held', phase: 'occupied', agent: 'idle', current_run_id: run.id };
  await writeFile(
    statusFile,
    JSON.stringify({ slots: [{ slot: slotId, slot_epoch: 3, ...row }] }, null, 2) + '\n',
  );
  // Fail a replay right after its claim, as the disposable gateway recipe does.
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS = run.id;
  t.after(async () => {
    cancelRunEngine(run.id);
    if (priorInject === undefined) delete process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS;
    else process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS = priorInject;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    updateRun(run.id, { slotId: null });
    await evictTestRun(run.id, 'failed');
  });
  return run;
}

async function retainedSlotRow(): Promise<Record<string, unknown>> {
  const slot = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  return {
    lifecycle: slot.lifecycle,
    phase: slot.phase,
    agent: slot.agent,
    owner: slot.current_run_id,
    epoch: slot.slot_epoch,
  };
}

test('a failed completion replay restores the retained slot claim instead of releasing it', async (t) => {
  const run = await retainedCompletionRun(t, 'macwork-ff-7');

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'complete', triggeredBy: 'operator' }, () => {}, {
        startEngine: async () => {},
      }),
    /Injected replay failure after claim/,
  );

  const { lifecycle, phase, agent, owner } = await retainedSlotRow();
  assert.deepEqual(
    { lifecycle, phase, agent, owner },
    { lifecycle: 'held', phase: 'occupied', agent: 'idle', owner: run.id },
    'the retained checkout stays bound to the run',
  );
  assert.equal(getRun(run.id)?.slotId, 'macwork-ff-7');
  assert.equal(isCompletionPrerequisiteFailure(getRun(run.id)!), true);
});

test('a later-step replay of a refused completion is refused before it touches the run', async (t) => {
  const run = await retainedCompletionRun(t, 'macwork-ff-6');
  const before = structuredClone(getRun(run.id)!.steps);

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'human-gate', triggeredBy: 'operator' }, () => {}, {
        startEngine: async () => {},
      }),
    /retains its slot for a refused completion prerequisite — replay from the refused step or earlier/,
  );

  assert.deepEqual(getRun(run.id)?.steps, before, 'the refused COMPLETE is not normalized');
  assert.equal(isCompletionPrerequisiteFailure(getRun(run.id)!), true);
  assert.deepEqual(await retainedSlotRow(), {
    lifecycle: 'held',
    phase: 'occupied',
    agent: 'idle',
    owner: run.id,
    epoch: 3,
  });
});

test('a find-slot replay of a refused completion is refused while the run still holds its slot', async (t) => {
  const run = await retainedCompletionRun(t, 'macwork-ff-5');
  const before = structuredClone(getRun(run.id)!.steps);

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {}, {
        startEngine: async () => {},
      }),
    /retains slot macwork-ff-5 for a refused completion prerequisite; a fresh slot selection would abandon it/,
  );

  assert.equal(getRun(run.id)?.slotId, 'macwork-ff-5', 'the run still names its retained slot');
  assert.deepEqual(getRun(run.id)?.steps, before, 'the refused COMPLETE is not normalized');
  assert.equal(isCompletionPrerequisiteFailure(getRun(run.id)!), true);
  assert.deepEqual(await retainedSlotRow(), {
    lifecycle: 'held',
    phase: 'occupied',
    agent: 'idle',
    owner: run.id,
    epoch: 3,
  });
});

/**
 * A pool slot outside the operator root, so release guards past the owner check
 * pass. `remote` puts it on a machine whose node never connects.
 */
async function disposablePoolSlot(
  t: test.TestContext,
  label: string,
  remote?: { machine: string; host: string },
): Promise<string> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { poolDir } = await import('../../core/config.js');
  const repo = mkdtempSync(path.join(os.tmpdir(), `farmslot-replay-${label}-`));
  const slotId = `replay-${label}-${process.pid}`;
  const poolFile = path.join(poolDir, `replay-${label}-fixture-${process.pid}.json`);
  t.after(() => {
    rmSync(poolFile, { force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  writeFileSync(
    poolFile,
    JSON.stringify({
      machine: remote?.machine ?? os.hostname(),
      project: 'farmslot-farm',
      platform: 'cli',
      host: remote?.host ?? 'localhost',
      ssh_user: os.userInfo().username,
      // Disabled and with its own dev-server, like the demo pool, so it never joins
      // another test's device catalog.
      slots: [
        {
          id: slotId,
          enabled: false,
          repo,
          session: slotId,
          resources: { 'dev-server': { port: 47779, metro_port: 47849 } },
        },
      ],
    }),
  );
  return slotId;
}

/** `run` holds `slotId` as its only slot row; the prior status file returns afterwards. */
async function holdOnlySlot(t: test.TestContext, slotId: string, row: Record<string, unknown>) {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  await writeFile(statusFile, `${JSON.stringify({ slots: [{ slot: slotId, ...row }] })}\n`);
  t.after(async () => {
    if (priorStatus === null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
  });
}

test('a find-slot replay of a gate-held run is refused before its engine is cancelled', async (t) => {
  const priorDemoPool = process.env.FARMSLOT_DEMO_POOL;
  process.env.FARMSLOT_DEMO_POOL = '1';
  const slotId = 'demo-work-1';
  const created = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId,
  });
  const run = updateRun(created.id, {
    status: 'human-gating',
    steps: created.steps.map((step) =>
      step.name === 'complete'
        ? { ...step, status: 'done', outputs: { slotDisposition: 'gate-held' } }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  await holdOnlySlot(t, slotId, { lifecycle: 'busy', phase: 'working', current_run_id: run.id });
  t.after(async () => {
    if (priorDemoPool === undefined) delete process.env.FARMSLOT_DEMO_POOL;
    else process.env.FARMSLOT_DEMO_POOL = priorDemoPool;
    if (getRun(run.id)) await evictTestRun(run.id, 'failed');
  });
  const generation = getRun(run.id)?.engineState?.generation;

  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {}, {
      startEngine: async () => {},
    }),
    new RegExp(`gate-held for run ${run.id}`),
  );
  assert.equal(getRun(run.id)?.engineState?.generation, generation, 'the gate driver still runs');
  assert.equal(getRun(run.id)?.status, 'human-gating');
  assert.equal(getRun(run.id)?.slotId, slotId);
});

test('a find-slot replay whose run fails its completion prerequisite meanwhile keeps the slot', async (t) => {
  const slotId = await disposablePoolSlot(t, 'completing');
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId,
  });
  const run = updateRun(created.id, { status: 'completing' });
  await holdOnlySlot(t, slotId, {
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: run.id,
    slot_epoch: 2,
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { slotId: null });
    await evictTestRun(run.id, 'failed');
  });
  const generation = getRun(run.id)?.engineState?.generation;

  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {}, {
      startEngine: async () => {},
      // The live engine refuses COMPLETE while replay reads device requirements.
      afterSlotPlanning: async () => {
        updateRun(run.id, {
          status: 'failed',
          steps: getRun(run.id)!.steps.map((step) =>
            step.name === 'complete'
              ? { ...step, status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }
              : step,
          ),
        });
      },
    }),
    /Run changed while reading replay device requirements/,
  );
  assert.equal(isCompletionPrerequisiteFailure(getRun(run.id)!), true);
  assert.equal(getRun(run.id)?.engineState?.generation, generation);
  assert.equal(getRun(run.id)?.slotId, slotId);
  const row = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.deepEqual([row.current_run_id, row.phase, row.slot_epoch], [run.id, 'working', 2]);
});

test('a find-slot replay whose run reaches its publication gate meanwhile keeps the gate driver', async (t) => {
  const slotId = await disposablePoolSlot(t, 'gating');
  const created = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId,
  });
  const run = updateRun(created.id, { status: 'completing' });
  await holdOnlySlot(t, slotId, { lifecycle: 'busy', phase: 'working', current_run_id: run.id });
  t.after(async () => {
    if (getRun(run.id)) await evictTestRun(run.id, 'failed');
  });
  const generation = getRun(run.id)?.engineState?.generation;

  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {}, {
      startEngine: async () => {},
      // The live engine finishes COMPLETE and holds the slot for its gate.
      afterSlotPlanning: async () => {
        updateRun(run.id, {
          status: 'human-gating',
          steps: getRun(run.id)!.steps.map((step) =>
            step.name === 'complete'
              ? { ...step, status: 'done', outputs: { slotDisposition: 'gate-held' } }
              : step.name === 'human-gate'
                ? { ...step, status: 'running' }
                : step,
          ),
        });
      },
    }),
    new RegExp(`gate-held for run ${run.id}`),
  );
  assert.equal(getRun(run.id)?.engineState?.generation, generation, 'the gate driver still runs');
  assert.equal(getRun(run.id)?.status, 'human-gating');
  assert.equal(getRun(run.id)?.slotId, slotId);
});

test('a find-slot replay whose old slot is on a disconnected machine is refused before mutation', async (t) => {
  const slotId = await disposablePoolSlot(t, 'offline', {
    machine: 'replay-offline-node',
    host: 'replay-offline-node.invalid',
  });
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId,
  });
  const run = updateRun(created.id, { status: 'failed', completedAt: new Date().toISOString() });
  await holdOnlySlot(t, slotId, {
    lifecycle: 'held',
    phase: 'occupied',
    current_run_id: run.id,
    slot_epoch: 4,
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { slotId: null });
    await evictTestRun(run.id, 'failed');
  });
  const generation = getRun(run.id)?.engineState?.generation;

  await assert.rejects(
    runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {}, {
      startEngine: async () => {},
    }),
    new RegExp(
      `Slot ${slotId} could not be released before restarting this run \\(machine replay-offline-node is not connected\\)\\. If its machine is offline, bring it back first; then replay again, or discard the workspace through slot\\.release RPC with forceReset:true and expectedRunId:${run.id}`,
    ),
  );
  assert.equal(getRun(run.id)?.engineState?.generation, generation, 'refused before mutation');
  assert.equal(getRun(run.id)?.slotId, slotId);
  const row = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.deepEqual([row.current_run_id, row.phase], [run.id, 'occupied']);
});

// TAT-4158 4237202e: restart recovery replayed the gate before macpro reconnected.
// The replay superseded the open decision, then failed, so the run was no
// longer held and recovery had nothing left to retry.
test('a human-gate replay whose slot machine is disconnected keeps the open decision', async (t) => {
  const slotId = await disposablePoolSlot(t, 'gate-offline', {
    machine: 'replay-gate-offline-node',
    host: 'replay-gate-offline-node.invalid',
  });
  const taskFile = '/tmp/farmslot-human-gate-offline/TASK.md';
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId,
  });
  const pendingGate: RunDecision = {
    id: 'pending-gate-offline',
    type: 'engine_human_gate',
    title: 'Ready to publish?',
    description: 'Open decision at restart',
    actions: [{ id: 'approve-publish', label: 'Approve publish', style: 'primary' as const }],
    createdAt: '2026-10-19T21:25:33.487Z',
  };
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'review',
    'complete',
  ]);
  const run = updateRun(created.id, {
    status: 'blocked',
    taskFile,
    decisions: [pendingGate],
    steps: created.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  await holdOnlySlot(t, slotId, {
    lifecycle: 'held',
    phase: 'occupied',
    current_run_id: run.id,
    slot_epoch: 4,
  });
  t.after(async () => {
    cancelRunEngine(run.id);
    if (!getRun(run.id)) return;
    updateRun(run.id, { slotId: null });
    await evictTestRun(run.id, 'failed');
  });
  const generation = getRun(run.id)?.engineState?.generation;

  const refusal: unknown = await runReplayStep(
    { runId: run.id, stepName: 'human-gate', triggeredBy: 'auto-recovery' },
    () => {},
    { startEngine: async () => {} },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const after = getRun(run.id);
  const decision = after?.decisions.find((d) => d.id === 'pending-gate-offline');
  assert.equal(decision?.resolvedAt, undefined, 'the open decision stays actionable');
  assert.equal(after?.engineState?.generation, generation, 'refused before mutation');
  assert.equal(after?.status, 'blocked');
  assert.ok(after && isPublicationReviewRecoveryHeld(after), 'recovery can re-arm and retry');
  assert.equal(after?.slotId, slotId);
  const row = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.deepEqual([row.current_run_id, row.phase, row.slot_epoch], [run.id, 'occupied', 4]);
  assert.ok(refusal instanceof Error);
  assert.match(
    refusal.message,
    new RegExp(`machine replay-gate-offline-node for slot ${slotId} is not connected`),
  );
});

/** A run blocked at its human gate on a local held slot, with `decisions` open. */
async function blockedGateRun(t: test.TestContext, label: string, decisions: RunDecision[]) {
  const slotId = await disposablePoolSlot(t, label);
  const taskFile = `/tmp/farmslot-${label}/TASK.md`;
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId,
  });
  const doneThroughComplete = new Set([
    'write-task',
    'find-slot',
    'prepare',
    'dispatch',
    'monitor',
    'review',
    'complete',
  ]);
  const run = updateRun(created.id, {
    status: 'blocked',
    taskFile,
    decisions,
    steps: created.steps.map((step) =>
      doneThroughComplete.has(step.name)
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'human-gate'
          ? { ...step, status: 'running' }
          : step,
    ),
  });
  await holdOnlySlot(t, slotId, {
    lifecycle: 'held',
    phase: 'occupied',
    current_run_id: run.id,
    slot_epoch: 4,
  });
  t.after(async () => {
    cancelRunEngine(run.id);
    if (!getRun(run.id)) return;
    updateRun(run.id, { slotId: null });
    await evictTestRun(run.id, 'failed');
  });
  return run;
}

const holdGate = (id: string): RunDecision => ({
  id,
  type: 'engine_human_gate',
  title: 'Publication package is unavailable',
  description: 'Open decision at restart',
  actions: [{ id: 'hold', label: 'Hold', style: 'secondary' as const }],
  createdAt: '2026-10-20T11:06:34.000Z',
});

const gateReplay = (runId: string, afterGenerationBump: () => Promise<void>) =>
  runReplayStep({ runId, stepName: 'human-gate', triggeredBy: 'auto-recovery' }, () => {}, {
    startEngine: async () => {},
    afterGenerationBump,
  });

// TAT-4158 4237202e, 2026-10-20: restart recovery replayed the blocked gate. The replay
// superseded its open decision, then failed refreshing the worker's publication
// evidence, and left the run blocked with nothing to resolve.
test('a human-gate replay that fails after superseding the open decision reopens it', async (t) => {
  const run = await blockedGateRun(t, 'gate-refresh', [holdGate('pending-gate-refresh')]);
  let supersededDuringReplay: string | undefined;
  await assert.rejects(
    gateReplay(run.id, async () => {
      supersededDuringReplay = getRun(run.id)?.decisions.find(
        (d) => d.id === 'pending-gate-refresh',
      )?.resolvedAction;
      throw new Error('Publication declaration belongs to another recipe attempt');
    }),
    /another recipe attempt/,
  );

  assert.equal(supersededDuringReplay, 'superseded', 'the replay superseded it first');
  const after = getRun(run.id);
  const decision = after?.decisions.find((d) => d.id === 'pending-gate-refresh');
  assert.equal(after?.status, 'blocked');
  assert.equal(decision?.resolvedAt, undefined, 'the blocked run has its decision back');
  assert.equal(decision?.resolvedAction, undefined);
  assert.equal(decision?.context?.supersededBy, undefined);
  assert.deepEqual(
    decision?.actions.map((action) => action.id),
    ['hold'],
  );
});

test('a gate replay that fails after reclaiming the slot restores the slot and reopens the decision', async (t) => {
  const run = await blockedGateRun(t, 'gate-claim', [holdGate('pending-gate-claim')]);
  const priorInject = process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS;
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  // The incident's shape: the claim succeeds, then the replay fails.
  process.env.NODE_TEST_CONTEXT = '1';
  process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS = run.id;
  t.after(() => {
    if (priorInject === undefined) delete process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS;
    else process.env.FARMSLOT_TEST_REPLAY_FAIL_AFTER_CLAIM_RUN_IDS = priorInject;
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  });
  const events: string[] = [];
  await assert.rejects(
    runReplayStep(
      { runId: run.id, stepName: 'human-gate', triggeredBy: 'auto-recovery' },
      (event) => events.push(event),
      { startEngine: async () => {} },
    ),
  );

  const after = getRun(run.id);
  const row = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.deepEqual([row.current_run_id, row.phase], [run.id, 'occupied'], 'the slot is back');
  assert.equal(after?.slotId, run.slotId);
  assert.equal(after?.status, 'blocked');
  assert.equal(after?.decisions.find((d) => d.id === 'pending-gate-claim')?.resolvedAt, undefined);
  assert.ok(events.includes(Events.RUN_DECISION_NEW), 'the inbox shows the card again');
});

test('a failed replay of a live gate retires the stale engine waiter of the decision it reopens', async (t) => {
  const run = await blockedGateRun(t, 'gate-live', []);
  const waiting = createEngineDecision(
    run.id,
    'human_gate',
    'Publication package is unavailable',
    [{ id: 'hold', label: 'Hold', style: 'secondary' }],
    undefined,
    { readProgress: async () => ({ kind: 'idle' }) },
  );
  let gateId: string | undefined;
  for (let i = 0; i < 400 && !(gateId && hasEngineDecisionWaiter(gateId)); i++) {
    gateId = getRun(run.id)!.decisions[0]?.id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(gateId && hasEngineDecisionWaiter(gateId), 'the gate waits on its engine loop');
  updateRun(run.id, { status: 'blocked' });

  await assert.rejects(
    gateReplay(run.id, async () => {
      throw new Error('refresh failed');
    }),
    /refresh failed/,
  );

  // The cancelled loop's waiter would otherwise swallow the reopened card's resolution.
  assert.equal(await waiting, 'abort');
  assert.equal(hasEngineDecisionWaiter(gateId), false);
  assert.equal(getRun(run.id)?.decisions.find((d) => d.id === gateId)?.resolvedAt, undefined);
});

test('overlapping failed replays reopen the gate decision when the last of them fails', async (t) => {
  const run = await blockedGateRun(t, 'gate-overlap', [holdGate('pending-gate-overlap')]);
  const decision = () => getRun(run.id)?.decisions.find((d) => d.id === 'pending-gate-overlap');
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstEntered = false;
  const first = gateReplay(run.id, async () => {
    firstEntered = true;
    await released;
    throw new Error('first refresh failed');
  });
  while (!firstEntered) await new Promise<void>((resolve) => setImmediate(resolve));

  // A second replay starts while the first still holds the superseded decision.
  await assert.rejects(
    gateReplay(run.id, async () => {
      throw new Error('second refresh failed');
    }),
    /second refresh failed/,
  );
  assert.equal(decision()?.resolvedAction, 'superseded', 'the first replay is still in flight');

  release();
  await assert.rejects(first, /first refresh failed/);
  assert.equal(getRun(run.id)?.status, 'blocked');
  assert.equal(decision()?.resolvedAt, undefined, 'the last failure reopens it');
});

test('a replay refused for PR ownership leaves the discarded run untouched', async (t) => {
  const prWork = {
    kind: 'review' as const,
    id: 'review:replay-ownership',
    sourceId: 'replay-ownership',
    pr: { host: 'github.com', repo: 'owner/repo', number: 99126 },
    headSha: 'head-a',
  };
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(() => evictTestRun(created.id, 'failed'));
  const completeIdx = created.steps.findIndex((step) => step.name === 'complete');
  updateRun(created.id, {
    prWork,
    status: 'failed',
    steps: created.steps.map((step, i) =>
      i < completeIdx
        ? { ...step, status: 'done' }
        : i === completeIdx
          ? { ...step, status: 'failed', outputs: { gatePrerequisiteRefusal: { reason: 'r' } } }
          : { ...step, status: 'skipped' },
    ),
  });
  await markCompletionFailureDiscarded(created.id, () => {});
  const successor = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now() + 1}`,
  });
  t.after(() => evictTestRun(successor.id, 'cancelled'));
  updateRun(successor.id, { prWork });
  const before = structuredClone(getRun(created.id)!);

  await assert.rejects(
    () =>
      runReplayStep(
        { runId: created.id, stepName: 'complete', triggeredBy: 'operator' },
        () => {},
        {
          startEngine: async () => {},
        },
      ),
    new RegExp(`PR execution is owned by run ${successor.id}`),
  );
  const after = getRun(created.id)!;
  assert.equal(after.status, 'failed');
  assert.deepEqual(after.steps, before.steps, 'the refusal and the discard stamp stay');
});

test('a review replay keeps the fix pass its worker blocked', () => {
  // TAT-4006 7721a02b at 17:06Z: review done with the worker's block and findings pending delivery.
  const steps: Run['steps'] = [
    {
      name: 'review',
      status: 'done',
      outputs: { verdict: 'blocked', recoveryContinuationPending: true, retryCount: 1 },
    },
  ];
  const fix: AgentContext = {
    id: 'review-fix',
    role: 'review-fix',
    runId: '7721a02b-ceda-431a-a741-d743837c40b4',
    slotId: 'macwork-coredev-2',
    label: 'Fix',
    status: 'blocked',
    taskFile: 'temp/tasks/feat/tat-4006-1019-171024/REVIEW-FIX.md',
  };
  const run: Run = { ...makeRun({ status: 'blocked', steps }), agentContexts: [fix] };
  assert.equal(blockedReviewFixTaskFile(run), fix.taskFile);
  const delivered = run.steps.map((step) =>
    step.name === 'review'
      ? { ...step, outputs: { ...step.outputs, recoveryContinuationPending: false } }
      : step,
  );
  assert.equal(blockedReviewFixTaskFile({ ...run, steps: delivered }), undefined);
  assert.equal(
    blockedReviewFixTaskFile({ ...run, agentContexts: [{ ...fix, status: 'complete' }] }),
    undefined,
  );
});
