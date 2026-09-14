import type {
  NativeSessionInfo,
  NativeWorkerControlTarget,
  NativeWorkerSessionBinding,
  Run,
} from '@farmslot/protocol';

export interface NativeWorkerViewTarget {
  runId: string;
  contextId: string;
  label: string;
  binding: NativeWorkerSessionBinding;
  readOnly: boolean;
}

/** Controls keep the task's lease and generation even if a late session poll finds a successor. */
export function nativeWorkerViewControl(
  target: NativeWorkerViewTarget,
  session: NativeSessionInfo | undefined,
): NativeWorkerControlTarget | undefined {
  const binding = target.binding;
  if (
    target.readOnly ||
    binding.closedAt ||
    binding.releasedAt ||
    binding.recovery ||
    !binding.acceptedAt ||
    !binding.generation ||
    !session ||
    session.id !== binding.sessionId ||
    session.executionNodeId !== binding.executionNodeId ||
    session.generation !== binding.generation ||
    session.workerLeaseId !== binding.leaseId ||
    session.ownerPrincipalId !== binding.ownerPrincipalId
  )
    return undefined;
  return {
    runId: target.runId,
    contextId: target.contextId,
    generation: binding.generation,
    leaseId: binding.leaseId,
  };
}

/** Overview controls open the current primary task; archived attempts keep explicit links. */
export function nativeRunConversationParams(run: Run): Record<string, string> | undefined {
  const contexts = (run.agentContexts ?? []).filter((context) => context.nativeSession);
  const context = contexts.find((item) => item.role === 'primary') ?? contexts[0];
  const binding = context?.nativeSession;
  if (!context || !binding) return undefined;
  return {
    runId: run.id,
    contextId: context.id,
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    leaseId: binding.leaseId,
    generation: binding.generation ?? '',
  };
}
