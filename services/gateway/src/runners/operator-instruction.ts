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
import { getRun } from '../runs/store.js';

import {
  nativeWorkerInstructionCommandId,
  readNativeWorkerSnapshot,
  sendNativeWorkerInstruction,
} from './native/worker-control.js';
import { resumeNativeWorker } from './native/worker-recovery.js';
import { sendRunnerInstructionSafely } from './registry.js';
import { inspectRunnerRecovery, reloadRunnerForPark } from './session-lifecycle.js';
import { resolveRunRetainedSessionBinding, retainedSessionSendOption } from './session-process.js';

/** Transport mechanics for one retained conversation, with no fresh-session fallback. */
export async function deliverOperatorInstruction(
  run: Run,
  key: string,
  text: string,
  observeSince?: number,
  contextId?: string,
  nativeCommandId?: string,
): Promise<'confirmed' | 'queued' | 'unconfirmed'> {
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
    const snapshot = await readNativeWorkerSnapshot(run.id, role, context.id);
    if (snapshot.session.processStopped) {
      await resumeNativeWorker(run.id, {
        purpose: 'operator-message',
        contextId: native.owner.id,
        commandId:
          nativeCommandId ?? nativeWorkerInstructionCommandId(run.id, native.binding, key, text),
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
  const retained = resolveRunRetainedSessionBinding(run, context);
  const binding = retained.binding;
  const target = context.target?.target;
  if (!binding || !target || !context.runner)
    throw new Error(retained.reason ?? 'Operator instruction has no exact retained worker binding');
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
  if (inspection.liveTarget.state === 'stopped') {
    const resumed = await reloadRunnerForPark({
      vars,
      recoveryHandle: handle,
      initialPrompt: text,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    return 'confirmed';
  }
  const confirmed = await sendRunnerInstructionSafely(
    vars,
    paneId,
    context.runner,
    text,
    'operator-message',
    observeSince === undefined ? undefined : 0,
    {
      ...retainedSessionSendOption(retained),
      ...(observeSince === undefined ? {} : { observeOnly: true, acceptanceSinceMs: observeSince }),
    },
  );
  return confirmed ? 'confirmed' : 'unconfirmed';
}
