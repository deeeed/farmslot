import { randomUUID } from 'node:crypto';

import {
  isGateParkInFlightOrFreed,
  NATIVE_WORKER_RESUME_ACTION,
  primaryRoleForFlow,
} from '@farmslot/protocol';

import { selectAgentContext } from '../../agents/contexts.js';
import { resumeNativeWorker } from '../../runners/native/worker-recovery.js';
import { getRun, persistRunNow, updateRun } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';

/** Caller holds the run transition lock. Decision intent survives a lost recovery reply. */
export async function resumeNativeWorkerDecision(runId: string, decisionId: string): Promise<void> {
  const original = getRun(runId);
  if (!original) throw new Error('Native worker run not found');
  const inspect = () => {
    const run = getRun(runId);
    const decision = run?.decisions.find((decision) => decision.id === decisionId);
    if (
      !run ||
      run.transport !== 'native' ||
      run.status !== 'blocked' ||
      run.engineState?.generation !== original.engineState?.generation ||
      !decision ||
      decision.resolvedAt ||
      decision.type !== 'monitor_interactive_handoff' ||
      !decision.actions.some((action) => action.id === NATIVE_WORKER_RESUME_ACTION)
    )
      throw new Error('Native stopped-worker decision changed');
    assertNativeRunOwner(run);
    if (isGateParkInFlightOrFreed(run))
      throw new Error('Restore the parked run before resuming its worker');
    const context = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
    if (!context?.nativeSession) throw new Error('Native worker decision has no session');
    return { run, decision, context, binding: context.nativeSession };
  };
  let current = inspect();
  if (!current.decision.context?.nativeWorkerResume) {
    const intent = {
      commandId: randomUUID(),
      contextId: current.context.id,
      sessionId: current.binding.sessionId,
      leaseId: current.binding.leaseId,
    };
    await persistRunNow(
      updateRun(runId, {
        decisions: current.run.decisions.map((decision) =>
          decision.id === decisionId
            ? { ...decision, context: { ...decision.context, nativeWorkerResume: intent } }
            : decision,
        ),
      }),
      'native stopped-worker decision intent',
    );
    current = inspect();
  }
  const value = current.decision.context?.nativeWorkerResume;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native worker decision recovery intent is invalid');
  const intent = value as Record<string, unknown>;
  const assertCurrent = () => {
    const current = inspect();
    if (
      intent.contextId !== current.context.id ||
      intent.sessionId !== current.binding.sessionId ||
      intent.leaseId !== current.binding.leaseId ||
      typeof intent.commandId !== 'string' ||
      !intent.commandId
    )
      throw new Error('Native worker decision belongs to a different task lease');
  };
  assertCurrent();
  await resumeNativeWorker(runId, {
    purpose: 'blocked-worker',
    commandId: intent.commandId as string,
    assertCurrent,
  });
  assertCurrent();
}
