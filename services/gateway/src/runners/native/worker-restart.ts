import { summarizeAgentContexts } from '../../agents/contexts.js';
import { updateSlotStatusIf } from '../../core/index.js';
import { getRun, persistRunNow, updateRunAgentContexts } from '../../runs/store.js';
import { assertNativeRunOwner } from '../../security/native-worker-owner.js';
import { unwatchContext } from '../../tasks/watcher.js';

import { cancelNativeRunWorkers } from './worker.js';

/** Stop-before-reset for an explicit task rerun. Reconciliation never calls this. */
export async function restartNativeWorkerContexts(
  runId: string,
  assertCurrent: () => void,
): Promise<void> {
  const original = getRun(runId);
  if (!original || original.transport !== 'native') throw new Error('Native run not found');
  assertNativeRunOwner(original);
  if (original.agentContexts?.some((context) => context.nativeSession?.recovery))
    throw new Error('Reconcile the pending native recovery before restarting its task');
  assertCurrent();
  await cancelNativeRunWorkers(runId);
  assertCurrent();
  const run = getRun(runId)!;
  for (const context of run.agentContexts ?? []) {
    const binding = context.nativeSession;
    if (!binding) continue;
    if (!binding.closedAt && !binding.releasedAt) throw new Error('Native stop was not confirmed');
    await unwatchContext(context.slotId, context.id, { expectedRunId: runId });
    assertCurrent();
    const updated = updateRunAgentContexts(runId, (_current, contexts) =>
      contexts.map((latest) => {
        if (latest.id !== context.id) return latest;
        assertCurrent();
        if (
          !latest.nativeSession ||
          latest.nativeSession.sessionId !== binding.sessionId ||
          latest.nativeSession.generation !== binding.generation ||
          latest.nativeSession.leaseId !== binding.leaseId ||
          (!latest.nativeSession.closedAt && !latest.nativeSession.releasedAt)
        )
          throw new Error('Native context changed during task restart');
        const history = latest.nativeSessionHistory ?? [];
        return {
          ...latest,
          nativeSession: undefined,
          nativeSessionHistory: history.some(
            (item) =>
              item.sessionId === binding.sessionId &&
              item.generation === binding.generation &&
              item.leaseId === binding.leaseId,
          )
            ? history
            : [...history, latest.nativeSession],
          target: null,
          runnerSessionId: null,
          runnerSessionPath: null,
          promptDeliveryStartedAt: undefined,
          startedAt: undefined,
          completedAt: undefined,
          status: 'idle',
          lastSignalAt: undefined,
          signalAttemptId: undefined,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
    if (updated.slotId)
      await updateSlotStatusIf(updated.slotId, (slot) => slot.current_run_id === runId, {
        agent_contexts: summarizeAgentContexts(updated),
      });
  }
  assertCurrent();
  await persistRunNow(getRun(runId)!, 'native task restart history');
}
