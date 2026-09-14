import { isTerminalRunStatus, primaryRoleForFlow } from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { execOnSlot } from '../../core/exec.js';
import { loadSlotVars, readSlotRow } from '../../core/index.js';
import { loadFleetStatus } from '../../fleet/state.js';
import { getAllRuns, getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';
import { resolveSafeSendTimeoutMs } from '../registry.js';

import { validateNativeRunner } from './manager.js';
import { readNativeWorkerSnapshot } from './worker-control.js';

/** Wait for the owned native turn before handing a new task to its existing conversation. */
export async function nudgeNativeWorker(
  runId: string,
  emit: (event: string, payload: unknown) => void,
) {
  // The run store mutates existing objects when replay advances the generation.
  const original = structuredClone(getRun(runId));
  if (!original || original.transport !== 'native' || !original.slotId || !original.taskFile)
    throw new Error('Native nudge requires a persisted run, slot and task');
  if (!['pr-complete', 'review-pr'].includes(original.flowType))
    throw new Error('Native nudge requires a PR-bound flow');
  assertNativeRunOwner(original);
  const slotId = original.slotId;
  const slot = await readSlotRow(slotId);
  const destination = selectAgentContext(original, { role: primaryRoleForFlow(original.flowType) });
  const recordedSource = destination?.nativeSession?.handoffFrom;
  const parent = structuredClone(
    getRun(
      recordedSource?.runId ??
        (typeof slot?.current_run_id === 'string' ? slot.current_run_id : ''),
    ),
  );
  const source =
    parent &&
    selectAgentContext(
      parent,
      recordedSource
        ? { contextId: recordedSource.contextId }
        : { role: primaryRoleForFlow(parent.flowType) },
    );
  const binding = destination?.nativeSession ?? source?.nativeSession;
  if (
    !parent ||
    parent.id === runId ||
    parent.transport !== 'native' ||
    !source?.nativeSession ||
    !binding?.generation ||
    binding.closedAt ||
    binding.releasedAt ||
    binding.recovery ||
    !source.runner ||
    !source.model ||
    !binding.safetyTier ||
    parent.nativeOwnerPrincipalId !== original.nativeOwnerPrincipalId ||
    parent.project !== original.project ||
    parent.familyId !== original.familyId ||
    parent.lane !== original.lane ||
    parent.variant !== original.variant ||
    parent.slotId !== slotId
  )
    throw new Error(
      'Native nudge requires the same owned task family and an available native worker',
    );
  assertNativeRunOwner(parent);
  validateNativeRunner(source.runner, source.model);
  const retainedFrom = { runId: parent.id, contextId: source.id };
  const vars = await loadSlotVars(slotId);
  const assertDestinationCurrent = () => {
    const current = getRun(runId);
    const currentSource = getRun(retainedFrom.runId)?.agentContexts?.find(
      (context) => context.id === retainedFrom.contextId,
    )?.nativeSession;
    if (
      !current ||
      isTerminalRunStatus(current.status) ||
      ['paused', 'blocked'].includes(current.status) ||
      current.engineState?.generation !== original.engineState?.generation ||
      current.slotId !== slotId ||
      current.taskFile !== original.taskFile ||
      current.branch !== original.branch ||
      currentSource?.sessionId !== source.nativeSession!.sessionId ||
      currentSource?.leaseId !== source.nativeSession!.leaseId ||
      currentSource?.generation !== source.nativeSession!.generation
    )
      throw new Error('Native nudge ownership changed while waiting for the worker');
    assertNativeRunOwner(current);
  };
  const assertCurrent = async () => {
    const currentSlot = await readSlotRow(slotId);
    assertDestinationCurrent();
    const currentParent = getRun(parent.id);
    const sourceBinding = currentParent?.agentContexts?.find(
      (context) => context.id === source.id,
    )?.nativeSession;
    if (
      !currentSlot ||
      currentSlot.phase === 'releasing' ||
      (currentSlot.current_run_id !== parent.id && currentSlot.current_run_id !== runId) ||
      (currentSlot.handoff_run_id && currentSlot.handoff_run_id !== runId) ||
      !sourceBinding ||
      sourceBinding.sessionId !== source.nativeSession!.sessionId ||
      sourceBinding.leaseId !== source.nativeSession!.leaseId ||
      sourceBinding.generation !== source.nativeSession!.generation ||
      (!destination?.nativeSession &&
        (sourceBinding.closedAt || sourceBinding.releasedAt || sourceBinding.recovery))
    )
      throw new Error('Native nudge ownership changed while waiting for the worker');
    assertNativeRunOwner(currentParent!);
  };
  const assertBranch = async () => {
    if (!original.branch) throw new Error('Native nudge requires the authorized PR branch');
    const branch = await execOnSlot(vars, 'git branch --show-current');
    if (branch.exitCode !== 0 || branch.stdout.trim() !== original.branch)
      throw new Error('Native nudge branch changed; select the slot again');
    await assertCurrent();
  };
  const assertEligibility = async () => {
    if (destination?.nativeSession) return;
    const { verifyBranchAffinityNudgeStillEligible } =
      await import('../../methods/dispatch/preview.js');
    const { activeRunIds } = await import('../../methods/dispatch/slot-scoring.js');
    const fleet = await loadFleetStatus();
    const failure = await verifyBranchAffinityNudgeStillEligible(
      fleet.slots.find((slot) => slot.slot === slotId),
      original.project,
      original.ticketOrPr,
      {
        familyId: original.familyId,
        lane: original.lane,
        variant: original.variant,
        allowedSlots: original.allowedSlots,
        targetBranch: original.branch,
        requiredPrepareProfile: original.prepareProfile,
        activeRunIds: activeRunIds(getAllRuns(), runId),
      },
    );
    if (failure) throw new Error(`Native nudge no longer eligible: ${failure}`);
    await assertCurrent();
  };
  await assertCurrent();
  await assertEligibility();
  await assertBranch();
  if (!destination?.nativeSession) {
    const deadline = Date.now() + resolveSafeSendTimeoutMs(source.runner);
    emit('dispatch.step', {
      name: 'nudge',
      detail: 'Waiting for the current native turn to finish',
    });
    for (;;) {
      await assertCurrent();
      const snapshot = await readNativeWorkerSnapshot(parent.id, undefined, source.id);
      if (
        snapshot.session.generation !== binding.generation ||
        snapshot.session.workerLeaseId !== binding.leaseId ||
        snapshot.session.processStopped ||
        ['failed', 'closed'].includes(snapshot.session.state)
      )
        throw new Error('Native worker stopped or changed while waiting for task reuse');
      if (snapshot.pendingRequests.length)
        throw new Error('Resolve the native worker permission or question before reusing it');
      if (snapshot.session.state === 'idle') break;
      if (Date.now() >= deadline)
        throw new Error('Native worker is still busy; retry task reuse after its turn finishes');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await assertEligibility();
  await assertBranch();
  // The retained process owns these settings. Persist them before dispatch so recovery
  // cannot substitute the wizard's unrelated runner/model or change its account.
  assertDestinationCurrent();
  const current = getRun(runId)!;
  await persistRunNow(
    updateRun(runId, {
      effort: binding.effort,
      safetyTier: binding.safetyTier,
      metrics: {
        ...current.metrics,
        runner: source.runner,
        model: source.model,
        providerAccountLabel: binding.accountLabel,
      },
    }),
    'native nudge launch settings',
  );
  await assertCurrent();
  const { dispatchExecute } = await import('../../methods/dispatch/execute.js');
  await dispatchExecute(
    {
      runId,
      slotId,
      taskFile: original.taskFile,
      transport: 'native',
      skipPrepare: true,
      runner: source.runner,
      model: source.model,
      effort: binding.effort ?? 'auto',
      safetyTier: binding.safetyTier,
      providerAccountLabel: binding.accountLabel,
      mode: original.mode,
    },
    emit,
    { nativeRetainedFrom: retainedFrom, assertCurrent: assertDestinationCurrent },
  );
  const context = selectAgentContext(getRun(runId)!, {
    role: primaryRoleForFlow(original.flowType),
  });
  if (!context?.nativeSession?.acceptedAt)
    throw new Error('Native nudge acceptance was not recorded');
  return {
    nudged: true,
    runner: source.runner,
    model: source.model,
    nativeSession: context.nativeSession,
    taskFile: context.taskFile,
  };
}
