import type {
  AgentContext,
  NativeSessionInfo,
  NativeSessionReadResult,
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

export function nativeWorkerViewKey(target: NativeWorkerViewTarget): string {
  return JSON.stringify([
    target.runId,
    target.contextId,
    target.binding.sessionId,
    target.binding.executionNodeId,
    target.binding.leaseId,
  ]);
}

export function nativeWorkerAttemptKey(target: NativeWorkerViewTarget): string {
  return JSON.stringify([nativeWorkerViewKey(target), target.binding.generation]);
}

/** One retained input owner opens directly; ambiguous or historical choices stay explicit. */
export function selectedNativeWorkerTarget(
  targets: readonly NativeWorkerViewTarget[],
  selectedKey: string,
): NativeWorkerViewTarget | undefined {
  const selected = targets.find((target) => nativeWorkerAttemptKey(target) === selectedKey);
  if (selected) return selected;
  const live = targets.filter(
    (target) =>
      !target.readOnly &&
      !target.binding.closedAt &&
      !target.binding.releasedAt &&
      !target.binding.recovery,
  );
  return live.length === 1 ? live[0] : undefined;
}

export function nativeWorkerViewPin(target: NativeWorkerViewTarget): NativeWorkerControlTarget {
  if (!target.binding.generation) throw new Error('Worker session generation is not yet available');
  return {
    runId: target.runId,
    contextId: target.contextId,
    generation: target.binding.generation,
    leaseId: target.binding.leaseId,
  };
}

export function assertNativeWorkerViewPage(
  target: NativeWorkerViewTarget,
  page: NativeSessionReadResult,
): void {
  const scope = page.scope;
  if (
    !scope ||
    scope.leaseId !== target.binding.leaseId ||
    page.session.workerLeaseId !== scope.leaseId ||
    !page.session.workerManaged ||
    page.session.ownerPrincipalId !== target.binding.ownerPrincipalId ||
    !Number.isSafeInteger(scope.startAfter) ||
    scope.startAfter < 0 ||
    !Number.isSafeInteger(scope.endAt) ||
    scope.endAt < scope.startAfter ||
    typeof scope.released !== 'boolean' ||
    !Number.isSafeInteger(page.cursor) ||
    page.cursor < scope.startAfter ||
    page.cursor > scope.endAt ||
    page.events.some(
      (event) => event.sequence <= scope.startAfter || event.sequence > scope.endAt,
    ) ||
    (scope.released && page.pendingRequests.length > 0)
  )
    throw new Error('Native replay returned an invalid task history scope');
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

/** Archived attempts retain their exact target even while the context starts another worker. */
export function archivedNativeWorkerTargets(
  contexts: readonly AgentContext[],
): NativeWorkerViewTarget[] {
  return contexts.flatMap((context) =>
    (context.nativeSessionHistory ?? []).map((binding, index) => ({
      runId: context.runId,
      contextId: context.id,
      label: `${context.label} · Attempt ${index + 1}`,
      binding,
      readOnly: true,
    })),
  );
}

/** Overview controls open the current primary task; archived attempts keep explicit links. */
export function nativeRunConversationParams(
  run: Pick<Run, 'id' | 'agentContexts'>,
  selected?: AgentContext | null,
): Record<string, string> | undefined {
  const contexts = (run.agentContexts ?? []).filter(
    (context) => context.nativeSession || context.nativeSessionOwner,
  );
  const context = selected ?? contexts.find((item) => item.role === 'primary') ?? contexts[0];
  const target = context && nativeWorkerTarget(run.agentContexts ?? [], context);
  if (!target) return undefined;
  const { binding } = target;
  return {
    runId: run.id,
    contextId: target.contextId,
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    leaseId: binding.leaseId,
    generation: binding.generation ?? '',
  };
}

/** A shared native subtask keeps its own context and the exact recorded owner lease. */
export function nativeWorkerTarget(
  contexts: readonly AgentContext[],
  context: AgentContext,
): NativeWorkerViewTarget | undefined {
  const reference = context.nativeSessionOwner;
  if (context.nativeSession && reference) return;
  const owners = reference ? contexts.filter((item) => item.id === reference.contextId) : [context];
  if (owners.length !== 1) return;
  const owner = owners[0];
  if (
    owner.nativeSessionOwner ||
    owner.runId !== context.runId ||
    owner.slotId !== context.slotId ||
    (reference && owner.id === context.id)
  )
    return;
  const bindings = reference
    ? [owner.nativeSession, ...(owner.nativeSessionHistory ?? [])].filter(
        (binding) =>
          binding?.sessionId === reference.sessionId && binding.leaseId === reference.leaseId,
      )
    : [context.nativeSession];
  if (bindings.length !== 1 || !bindings[0]) return;
  const binding = bindings[0];
  return {
    runId: context.runId,
    contextId: context.id,
    label: context.label,
    binding,
    readOnly: binding !== owner.nativeSession || Boolean(binding.closedAt || binding.releasedAt),
  };
}

/** All recorded native contexts share the same target, regardless of role or slot binding. */
export function nativeWorkerTargets(contexts: readonly AgentContext[]): NativeWorkerViewTarget[] {
  const current = contexts.flatMap((context) => {
    const target = nativeWorkerTarget(contexts, context);
    return target ? [target] : [];
  });
  return [...current, ...archivedNativeWorkerTargets(contexts)];
}

/** Native tabs sit beside tmux windows and keep their task lease when a session is reused. */
export function nativeWorkerTabs(contexts: readonly AgentContext[], slotId?: string) {
  const selected = slotId ? contexts.filter((context) => context.slotId === slotId) : contexts;
  return selected
    .flatMap((context) => {
      const target = nativeWorkerTarget(contexts, context);
      return target ? [target] : [];
    })
    .map((target) => {
      const context = selected.find((candidate) => candidate.id === target.contextId)!;
      const role = context.role === 'review' ? 'rev' : context.role;
      const round = context.reviewLoopNumber ? ` ${context.reviewLoopNumber}` : '';
      return {
        key: nativeWorkerAttemptKey(target),
        label: `${role}-${context.runner ?? 'agent'} native${round}${context.status === 'failed' ? ' · Failed' : target.readOnly ? ' · History' : ''}`,
        target,
      };
    });
}

export interface SlotSessionSelection {
  slotId: string;
  contextId: string;
  tmux: boolean;
}

/** A window click explicitly opens tmux, including slots whose primary worker is native. */
export function slotSessionView(
  contexts: readonly AgentContext[],
  selection: SlotSessionSelection,
) {
  const tabs = nativeWorkerTabs(contexts, selection.slotId || undefined);
  const target = selection.tmux
    ? undefined
    : tabs.find((tab) => tab.target.contextId === selection.contextId)?.target;
  const context = contexts.find((item) => item.id === selection.contextId);
  return {
    tabs,
    target,
    bareSession: selection.tmux,
    unavailable:
      !selection.tmux && !target && Boolean(context?.nativeSession || context?.nativeSessionOwner),
  };
}
