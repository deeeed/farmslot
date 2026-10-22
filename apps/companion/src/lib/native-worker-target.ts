import {
  type AgentContext,
  isTerminalRunStatus,
  type NativeSessionInfo,
  type NativeWorkerControlTarget,
  type NativeWorkerSessionBinding,
  type Run,
} from '@farmslot/protocol';

export interface NativeWorkerViewTarget {
  runId: string;
  contextId: string;
  label: string;
  binding: NativeWorkerSessionBinding;
  readOnly: boolean;
}

export interface NativeWorkerViewSelection {
  runId: string;
  contextId?: string;
  sessionId?: string;
  executionNodeId: string;
  leaseId?: string;
  generation?: string;
}

/** Resolve only the pinned task attempt, including its declared session owner. */
export function nativeWorkerViewForRun(
  run: Run,
  selection: NativeWorkerViewSelection,
): NativeWorkerViewTarget | undefined {
  if (run.id !== selection.runId || !selection.sessionId || !selection.leaseId) return;
  const context = run.agentContexts?.find((item) => item.id === selection.contextId);
  if (!context) return;
  const reference = context.nativeSessionOwner;
  const owner = reference
    ? run.agentContexts?.find((item) => item.id === reference.contextId)
    : context;
  if (
    !owner ||
    (reference &&
      (reference.sessionId !== selection.sessionId || reference.leaseId !== selection.leaseId))
  )
    return;
  const bindings = [owner.nativeSession, ...(owner.nativeSessionHistory ?? [])].filter(
    (binding): binding is NativeWorkerSessionBinding =>
      !!binding &&
      binding.sessionId === selection.sessionId &&
      binding.executionNodeId === selection.executionNodeId &&
      binding.leaseId === selection.leaseId,
  );
  if (bindings.length !== 1) return;
  const binding = bindings[0];
  if (selection.generation !== undefined && selection.generation !== binding.generation) return;
  return {
    runId: run.id,
    contextId: context.id,
    label: context.label,
    binding,
    readOnly: isTerminalRunStatus(run.status) || !!binding.closedAt || !!binding.releasedAt,
  };
}

/** Metadata changes do not rebind a transcript; task/session ownership changes do. */
export function sameNativeWorkerViewBinding(
  left: NativeWorkerViewTarget | undefined,
  right: NativeWorkerViewTarget | undefined,
): boolean {
  return !!(
    left &&
    right &&
    left.runId === right.runId &&
    left.contextId === right.contextId &&
    left.binding.sessionId === right.binding.sessionId &&
    left.binding.executionNodeId === right.binding.executionNodeId &&
    left.binding.leaseId === right.binding.leaseId &&
    left.binding.generation === right.binding.generation &&
    left.binding.ownerPrincipalId === right.binding.ownerPrincipalId
  );
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
export function nativeRunConversationParams(
  run: Run,
  selected?: AgentContext | null,
): Record<string, string> | undefined {
  const contexts = (run.agentContexts ?? []).filter((context) => context.nativeSession);
  const context = selected ?? contexts.find((item) => item.role === 'primary') ?? contexts[0];
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
