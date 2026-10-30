import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionReadResult,
} from '@farmslot/protocol';
import {
  canActOn,
  nativeHistoryCanAct,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

export interface NativeTranscript {
  events: NativeSessionEvent[];
  cursor: number;
}

/** Page sequence is authoritative. Ignore repeats; reject a gap rather than hide missing history. */
export function appendNativePage(
  previous: NativeTranscript,
  page: NativeSessionReadResult,
): NativeTranscript {
  const events = [...previous.events];
  let cursor = previous.cursor;
  for (const event of page.events) {
    if (event.sessionId !== page.session.id) throw new Error('Native replay changed session');
    if (event.sequence <= cursor) continue;
    if (event.sequence !== cursor + 1)
      throw new Error('Native history has a gap. Reload this session.');
    events.push(event);
    cursor = event.sequence;
  }
  return cursor === previous.cursor ? previous : { events, cursor };
}

export function nativeDeliveryLabel(receipt?: NativeCommandReceipt): string {
  if (!receipt) return 'Delivery unknown';
  if (receipt.outcome === 'interrupted') return 'Interrupted';
  switch (receipt.state) {
    case 'pending':
      return 'Submitting';
    case 'unknown':
      return 'Awaiting runner acceptance';
    case 'accepted':
      return 'Accepted';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
  }
}

export { nativeTimeline, type NativeTimelineEntry } from '@farmslot/protocol/client-cache';

/** A confirmed replacement generation must not inherit the old browser input lock. */
export function nativeCommandLockSettled(
  command: { commandId: string; generation: string },
  currentGeneration: string,
  receipt?: NativeCommandReceipt,
  events: NativeSessionEvent[] = [],
): boolean {
  return (
    command.generation !== currentGeneration ||
    (!!receipt &&
      receipt.commandId === command.commandId &&
      receipt.generation === command.generation &&
      ['completed', 'failed'].includes(receipt.state)) ||
    events.some(
      (event) =>
        event.type === 'turn.completed' &&
        event.commandId === command.commandId &&
        event.generation === command.generation,
    )
  );
}

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
