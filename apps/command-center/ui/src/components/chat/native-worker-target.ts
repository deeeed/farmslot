import type {
  NativeSessionInfo,
  NativeSessionReadResult,
  NativeWorkerControlTarget,
  NativeWorkerSessionBinding,
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
