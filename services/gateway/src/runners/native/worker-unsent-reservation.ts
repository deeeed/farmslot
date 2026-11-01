import type { AgentRole, NativeWorkerSessionBinding } from '@farmslot/protocol';

import { upsertAgentContext } from '../../agents/contexts.js';
import { getRun, persistRunNow } from '../../runs/store.js';

/**
 * Retire a native reservation the host never received (ENSURE was not sent), so the engine's
 * retry reserves against re-read launch inputs. The run store refuses to drop a held binding, so
 * its lease is released first under its own session and lease; the released binding then moves
 * to the context's history, where the leftovers probe still sees it. `checkRun` runs inside each
 * write: a replay that superseded this attempt keeps its reservation.
 */
export async function retireUnsentNativeReservation(input: {
  runId: string;
  role: AgentRole;
  contextId: string;
  binding: Pick<NativeWorkerSessionBinding, 'sessionId' | 'leaseId'>;
  checkRun: () => unknown;
}): Promise<void> {
  const unsent = (
    live: NativeWorkerSessionBinding | undefined,
  ): live is NativeWorkerSessionBinding =>
    !!live &&
    live.sessionId === input.binding.sessionId &&
    live.leaseId === input.binding.leaseId &&
    !live.generation;
  await upsertAgentContext(
    input.runId,
    input.role,
    { id: input.contextId },
    {
      resolvePatch: (latest) => {
        input.checkRun();
        const live = latest?.nativeSession;
        if (!unsent(live)) return null;
        return {
          nativeSession: { ...live, releasedAt: live.releasedAt ?? new Date().toISOString() },
        };
      },
    },
  );
  await upsertAgentContext(
    input.runId,
    input.role,
    { id: input.contextId },
    {
      resolvePatch: (latest) => {
        input.checkRun();
        const live = latest?.nativeSession;
        if (!unsent(live) || !live.releasedAt) return null;
        return {
          nativeSession: undefined,
          nativeSessionHistory: [...(latest?.nativeSessionHistory ?? []), live],
          status: 'idle',
          target: null,
        };
      },
    },
  );
  const run = getRun(input.runId);
  if (run) await persistRunNow(run, 'unsent native reservation retired');
}
