import type { NativeWorkerSessionBinding } from '@farmslot/protocol';

import { onNativeSessionChange } from '../resources/native-session-changes.js';
import { onWorkerSignal } from '../tasks/watcher.js';

interface ReviewCompletionWatch {
  runId: string;
  slotId: string;
  contextId: string;
  binding: NativeWorkerSessionBinding;
}

const NATIVE_READ_FLOOR_MS = 100;

/** Notifications request a fresh validated read; they never establish completion themselves. */
export function watchNativeReviewCompletion(input: ReviewCompletionWatch) {
  let nativeChanged = false;
  let signalChanged = false;
  let readStartedAt = 0;
  let stopped = false;
  let pending: (() => void) | undefined;
  const stopNative = onNativeSessionChange(
    input.binding.executionNodeId,
    input.binding.ownerPrincipalId,
    () => {
      if (nativeChanged) return;
      nativeChanged = true;
      pending?.();
    },
  );
  const stopSignal = onWorkerSignal((slotId, runId, _signal, role, contextId) => {
    if (
      slotId === input.slotId &&
      runId === input.runId &&
      role === 'review' &&
      contextId === input.contextId
    ) {
      signalChanged = true;
      pending?.();
    }
  });
  return {
    beforeRead() {
      nativeChanged = false;
      signalChanged = false;
      readStartedAt = Date.now();
    },
    wait(fallbackMs: number): Promise<void> {
      // Preserve notifications received while the snapshot or signal RPC was in flight.
      if (signalChanged || stopped) return Promise.resolve();
      const nativeDelay = () => Math.max(0, readStartedAt + NATIVE_READ_FLOOR_MS - Date.now());
      if (nativeChanged && nativeDelay() === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const fallbackAt = Date.now() + fallbackMs;
        const finish = () => {
          clearTimeout(timer);
          pending = undefined;
          resolve();
        };
        let timer = setTimeout(
          finish,
          nativeChanged ? Math.min(nativeDelay(), fallbackMs) : fallbackMs,
        );
        pending = () => {
          if (signalChanged || stopped || nativeDelay() === 0) finish();
          else if (nativeChanged) {
            // Native notifications include neighbouring sessions on this node and owner.
            // Coalesce them at a fixed read-start floor, without delaying exact signals.
            clearTimeout(timer);
            timer = setTimeout(finish, Math.min(nativeDelay(), fallbackAt - Date.now()));
          }
        };
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
