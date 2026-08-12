import type { AgentContext, AgentRole, WorkerSignal } from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
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

  const rearmingTerminalContext = ['complete', 'failed', 'blocked', 'idle'].includes(match.status);
  if (rearmingTerminalContext && !signalIsNewerThanContext(signal, match)) return false;
  const observedAt = signal.timestamp;
  await upsertAgentContext(runId, match.role, {
    id: match.id,
    status: 'working',
    ...(rearmingTerminalContext ? { attemptStartedAt: observedAt } : {}),
    lastSignalAt: observedAt,
  });
  return rearmingTerminalContext;
}
