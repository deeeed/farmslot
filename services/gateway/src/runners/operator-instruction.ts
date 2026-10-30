import path from 'node:path';

import {
  isTerminalRunStatus,
  type MachinePauseTerminalRecoveryHandle,
  primaryRoleForFlow,
  type Run,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { resolveNativeContext } from '../agents/native-context.js';
import { loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { resolveTmuxPaneId } from '../core/tmux.js';
import { blindTrialWorkerCapsule } from '../evals/blind-git.js';
import { getRun } from '../runs/store.js';

import {
  nativeWorkerInstructionCommandId,
  readNativeWorkerSnapshot,
  sendNativeWorkerInstruction,
} from './native/worker-control.js';
import { resumeNativeWorker } from './native/worker-recovery.js';
import { sendRunnerInstructionWithOutcome } from './registry.js';
import { inspectRunnerRecovery, reloadRunnerForPark } from './session-lifecycle.js';
import { resolveRunRetainedSessionBinding, retainedSessionSendOption } from './session-process.js';

export class OperatorInstructionNotAttemptedError extends Error {}

/** Transport mechanics for one retained conversation, with no fresh-session fallback. */
export async function deliverOperatorInstruction(
  run: Run,
  key: string,
  text: string,
  observeSince?: number,
  contextId?: string,
  nativeCommandId?: string,
): Promise<'confirmed' | 'queued' | 'unconfirmed' | 'not-attempted'> {
  if (!run.slotId) throw new Error('Operator instruction requires an owned slot');
  const slotId = run.slotId;
  const context = selectAgentContext(
    run,
    contextId ? { contextId } : { role: primaryRoleForFlow(run.flowType) },
  );
  if (!context) throw new Error('Operator instruction has no retained worker context');
  const role = context.role;
  const generation = run.engineState?.generation ?? 0;
  const assertCurrent = () => {
    const current = getRun(run.id);
    if (
      !current ||
      isTerminalRunStatus(current.status) ||
      current.slotId !== slotId ||
      (current.engineState?.generation ?? 0) !== generation
    )
      throw new Error('Operator instruction worker generation changed');
  };
  assertCurrent();
  const native = resolveNativeContext(run, context);
  if (native) {
    const commandId =
      nativeCommandId ?? nativeWorkerInstructionCommandId(run.id, native.binding, key, text);
    const pendingRecovery = native.binding.recovery;
    if (pendingRecovery && pendingRecovery.commandId !== commandId)
      throw new Error('Another native worker recovery must be reconciled first');
    // A lost successful resume reply leaves the saved generation behind the node.
    // Only the matching recovery owner can reconcile before strict snapshot reads.
    const snapshot = pendingRecovery
      ? undefined
      : await readNativeWorkerSnapshot(run.id, role, context.id);
    if (pendingRecovery || snapshot?.session.processStopped) {
      await resumeNativeWorker(run.id, {
        purpose: 'operator-message',
        contextId: native.owner.id,
        commandId,
        text,
        assertCurrent,
      });
      return 'confirmed';
    }
    const result = await sendNativeWorkerInstruction({
      runId: run.id,
      slotId,
      role,
      contextId: context.id,
      key,
      text,
      logicalCommandId: nativeCommandId,
      allowBusyQueue: true,
      assertCurrent,
    });
    return result === 'confirmed' ? 'confirmed' : result === 'queued' ? 'queued' : 'unconfirmed';
  }
  let reloadAttempted = false;
  try {
    const retained = resolveRunRetainedSessionBinding(run, context);
    const binding = retained.binding;
    const target = context.target?.target;
    if (!binding || !target || !context.runner)
      throw new Error(
        retained.reason ?? 'Operator instruction has no exact retained worker binding',
      );
    const vars = await loadSlotVars(slotId);
    const paneId = context.target?.paneId ?? (await resolveTmuxPaneId(vars, target));
    if (!paneId) throw new Error('Operator instruction worker pane is unavailable');
    const handle: MachinePauseTerminalRecoveryHandle = {
      version: 1,
      runnerId: context.runner,
      contextId: context.id,
      sessionId: binding.runnerSessionId,
      sessionPath: binding.runnerSessionPath,
      target: { ...context.target!, paneId },
      model: context.model ?? run.metrics.model ?? null,
      effort: run.effort,
      safetyTier: run.safetyTier,
      runtimeDir: await resolveProjectRuntimeDir(run.project),
      taskDir: context.taskFile ? path.posix.dirname(context.taskFile) : undefined,
      capturedAt: new Date().toISOString(),
    };
    const inspection = await inspectRunnerRecovery({
      vars,
      runnerId: context.runner,
      recoveryHandle: handle,
      expectedRunnerState: 'stopped-or-live',
    });
    if (!inspection.supported)
      throw new Error(inspection.reason ?? 'Worker cannot continue its saved conversation');
    assertCurrent();
    if (inspection.liveTarget.state === 'stopped' && observeSince === undefined) {
      reloadAttempted = true;
      const resumed = await reloadRunnerForPark({
        vars,
        recoveryHandle: handle,
        initialPrompt: text,
        blindTrialCapsule: blindTrialWorkerCapsule(run, context.role),
      });
      if (!resumed.ok) throw new Error(resumed.error);
      return 'confirmed';
    }
    const outcome = await sendRunnerInstructionWithOutcome(
      vars,
      paneId,
      context.runner,
      text,
      'operator-message',
      observeSince === undefined ? undefined : 0,
      {
        ...retainedSessionSendOption(retained),
        ...(observeSince === undefined
          ? {}
          : { observeOnly: true, acceptanceSinceMs: observeSince }),
      },
    );
    return outcome === 'sent'
      ? 'confirmed'
      : outcome === 'held-untouched' && observeSince === undefined
        ? 'not-attempted'
        : 'unconfirmed';
  } catch (error) {
    // The shared adapter absorbs errors after touching the composer. A throw
    // before that boundary means an initial send can safely be tried again.
    if (observeSince === undefined && !reloadAttempted)
      throw new OperatorInstructionNotAttemptedError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    throw error;
  }
}
