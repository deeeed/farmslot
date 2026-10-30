import { isTerminalRunStatus, type Run, type RunGetResult } from '@farmslot/protocol';
import { canActOn, type ResourceQueryState } from '@farmslot/protocol/client-cache';
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

/**
 * The worker an action targets. Its run follows the same held-data rule as the message field:
 * current, or only waiting for the reread a run write called for. A saved run refuses.
 */
export function nativeWorkerForAction(
  run: ResourceQueryState<RunGetResult> | undefined,
  selection: NativeWorkerViewSelection,
  connected: boolean,
  now = Date.now(),
): NativeWorkerViewTarget | undefined {
  if (!run?.data || !canActOn(run, connected, now)) return;
  const target = nativeWorkerViewForRun(run.data.run, selection);
  if (!target) throw new Error('This run no longer contains the selected worker conversation.');
  return target;
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
