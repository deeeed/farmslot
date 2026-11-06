import type { NativeWorkerSessionBinding } from '@farmslot/protocol';

import { onNativeSessionChange } from '../resources/native-session-changes.js';
import { onWorkerSignal } from '../tasks/watcher.js';

interface ReviewCompletionWatch {
  runId: string;
  slotId: string;
  contextId: string;
  binding: NativeWorkerSessionBinding;
}

/** Notifications request a fresh validated read; they never establish completion themselves. */
export function watchNativeReviewCompletion(input: ReviewCompletionWatch) {
  let changed = false;
  let stopped = false;
  let pending: (() => void) | undefined;
  const wake = () => {
    changed = true;
    pending?.();
  };
  const stopNative = onNativeSessionChange(
    input.binding.executionNodeId,
    input.binding.ownerPrincipalId,
    wake,
  );
  const stopSignal = onWorkerSignal((slotId, runId, _signal, role, contextId) => {
    if (
      slotId === input.slotId &&
      runId === input.runId &&
      role === 'review' &&
      contextId === input.contextId
    )
      wake();
  });
  return {
    beforeRead() {
      changed = false;
    },
    wait(fallbackMs: number): Promise<void> {
      // Preserve notifications received while the snapshot or signal RPC was in flight.
      if (changed || stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          pending = undefined;
          resolve();
        };
        const timer = setTimeout(finish, fallbackMs);
        pending = finish;
      });
    },
    stop() {
      stopped = true;
      stopNative();
      stopSignal();
      pending?.();
    },
  };
}
