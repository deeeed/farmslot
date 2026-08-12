import type { AgentContext, AgentRole, WorkerSignal } from '@farmslot/protocol';

import { TERMINAL_AGENT_STATUSES, upsertAgentContext } from '../agents/contexts.js';
import { getRun } from '../runs/store.js';

function signalIsNewerThanContext(signal: WorkerSignal, context: AgentContext): boolean {
  const signalAt = Date.parse(signal.timestamp);
  if (!Number.isFinite(signalAt)) return false;
  const priorAt = [context.lastSignalAt, context.completedAt]
    .map((value) => Date.parse(value ?? ''))
    .filter(Number.isFinite);
  return priorAt.every((timestamp) => signalAt > timestamp);
}

export async function applyRunningWorkerSignalToContext(
  slotId: string,
  runId: string | null,
  signal: WorkerSignal,
  role?: AgentRole,
  contextId?: string,
): Promise<boolean> {
  if (signal.status !== 'running') return false;
  if (!runId) return false;
  if (!Number.isFinite(Date.parse(signal.timestamp))) return false;

  const run = getRun(runId);
  if (!run || run.slotId !== slotId) return false;

  const contexts = run.agentContexts ?? [];
  const match = contexts.find((ctx) => {
    if (contextId) return ctx.id === contextId;
    if (signal.contextId) return ctx.id === signal.contextId;
    if (role) return ctx.role === role;
    if (signal.role) return ctx.role === signal.role;
    return ctx.role === 'primary';
  });
  if (!match) return false;

  const observedAt = signal.timestamp;
  let rearmingTerminalContext = false;
  const updated = await upsertAgentContext(
    runId,
    match.role,
    { id: match.id },
    {
      resolvePatch: (current) => {
        if (!current) return null;
        rearmingTerminalContext = TERMINAL_AGENT_STATUSES.has(current.status);
        if (rearmingTerminalContext && !signalIsNewerThanContext(signal, current)) return null;
        return {
          id: current.id,
          status: 'working',
          ...(rearmingTerminalContext ? { attemptStartedAt: observedAt } : {}),
          lastSignalAt: observedAt,
        };
      },
    },
  );
  return updated !== null && rearmingTerminalContext && match.role === 'self-review';
}
