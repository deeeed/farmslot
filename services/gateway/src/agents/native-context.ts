import type { AgentContext, Run } from '@farmslot/protocol';

/** Resolve one owner only. Historical subtask references cannot adopt a replacement task. */
export function resolveNativeContext(
  run: Pick<Run, 'agentContexts'>,
  context: AgentContext | null | undefined,
) {
  if (!context) return null;
  const reference = context.nativeSessionOwner;
  if (context.nativeSession && reference)
    throw new Error('Native context cannot both own and reference a session');
  if (!reference)
    return context.nativeSession ? { owner: context, binding: context.nativeSession } : null;
  const candidates = run.agentContexts?.filter((item) => item.id === reference.contextId) ?? [];
  if (candidates.length !== 1) return null;
  const owner = candidates[0];
  const binding = owner.nativeSession;
  if (
    owner.id === context.id ||
    owner.runId !== context.runId ||
    owner.slotId !== context.slotId ||
    owner.nativeSessionOwner ||
    !binding ||
    binding.sessionId !== reference.sessionId ||
    binding.leaseId !== reference.leaseId ||
    binding.releasedAt
  )
    return null;
  return { owner, binding };
}
