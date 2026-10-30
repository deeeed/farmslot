import type { NativeCommandReceipt, NativeSessionReadResult } from '@farmslot/protocol';
import {
  canActOn,
  nativeHistoryCanAct,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

/**
 * Input is open for an open conversation this account may drive, while its history and run follow
 * the shared held-data rule: current, or only waiting for the reread a change called for.
 */
export function nativeConversationWritable(input: {
  allowed: boolean;
  ready: boolean;
  connected: boolean;
  history: ResourceQueryState<NativeSessionReadResult>;
  snapshot: NativeSessionReadResult | undefined;
  /** The worker's run, for a run-linked view. */
  run?: ResourceQueryState<unknown>;
  workerControl: boolean;
  now?: number;
}): boolean {
  const session = input.snapshot?.session;
  const now = input.now ?? Date.now();
  return (
    !!session &&
    input.allowed &&
    input.ready &&
    !input.snapshot?.scope?.released &&
    (!input.run || canActOn(input.run, input.connected, now)) &&
    nativeHistoryCanAct(input.history, input.snapshot, input.connected, now) &&
    !['closed', 'failed', 'closing', 'starting'].includes(session.state) &&
    (session.workerManaged ? input.workerControl : !input.run)
  );
}

/** A message whose delivery is unconfirmed can be sent again; a queued one waits for its turn. */
export function nativeRetryAvailable(receipt: NativeCommandReceipt | undefined): boolean {
  return !receipt || (['pending', 'unknown'].includes(receipt.state) && !receipt.queued);
}
