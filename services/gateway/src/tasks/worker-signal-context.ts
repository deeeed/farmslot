import type { AgentRole, WorkerSignal } from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import { getRun } from '../runs/store.js';

export async function applyRunningWorkerSignalToContext(
  slotId: string,
  runId: string | null,
  signal: WorkerSignal,
  role?: AgentRole,
  contextId?: string,
): Promise<void> {
  if (signal.status !== 'running') return;
  const effectiveRunId = runId;
  if (!effectiveRunId) return;

  const run = getRun(effectiveRunId);
  if (!run || run.slotId !== slotId) return;

  const contexts = run.agentContexts ?? [];
  const match = contexts.find((ctx) => {
    if (contextId) return ctx.id === contextId;
    if (role) return ctx.role === role;
    if (signal.contextId) return ctx.id === signal.contextId;
    if (signal.role) return ctx.role === signal.role;
    return ctx.role === 'primary';
  });
  if (!match) return;

  await upsertAgentContext(effectiveRunId, match.role, {
    lastSignalAt: signal.timestamp ?? new Date().toISOString(),
  });
}
