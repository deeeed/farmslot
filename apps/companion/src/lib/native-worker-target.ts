import { isTerminalRunStatus, type Run } from '@farmslot/protocol';
import { nativeWorkerTargets, type NativeWorkerViewTarget } from '@farmslot/review-dispatch';

export {
  nativeRunConversationParams,
  nativeWorkerTargets,
  nativeWorkerViewControl,
  type NativeWorkerViewTarget,
} from '@farmslot/review-dispatch';

export interface NativeWorkerViewSelection {
  runId: string;
  contextId?: string;
  sessionId?: string;
  executionNodeId: string;
  leaseId?: string;
  generation?: string;
}

/** Resolve only the pinned task attempt from the canonical run. */
export function nativeWorkerViewForRun(
  run: Run,
  selection: NativeWorkerViewSelection,
): NativeWorkerViewTarget | undefined {
  if (run.id !== selection.runId || !selection.sessionId || !selection.leaseId) return;
  const matches = nativeWorkerTargets(run.agentContexts ?? []).filter(
    (target) =>
      target.contextId === selection.contextId &&
      target.binding.sessionId === selection.sessionId &&
      target.binding.executionNodeId === selection.executionNodeId &&
      target.binding.leaseId === selection.leaseId &&
      (selection.generation === undefined || target.binding.generation === selection.generation),
  );
  if (matches.length !== 1) return;
  return { ...matches[0], readOnly: matches[0].readOnly || isTerminalRunStatus(run.status) };
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
