import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionReadResult,
} from '@farmslot/protocol';
import {
  canActOn,
  nativeHistoryCanAct,
  type NativeTimelineRow,
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

/**
 * One cell of the conversation list. Timeline rows are the items themselves, so a row
 * `nativeTimelineRows` kept is the same item and its cell can skip rendering.
 */
export type NativeTranscriptItem =
  | NativeTimelineRow
  | { kind: 'pending'; commandId: string }
  | { kind: 'request'; event: NativeSessionEvent };

export interface NativeTranscriptList {
  items: NativeTranscriptItem[];
  /** The work rows shown open. */
  openFolds: ReadonlySet<number>;
}

/**
 * The conversation's cells: its rows without the tools of closed folds, then the pending message
 * and the open requests. `foldIsOpen` takes a work row's key.
 */
export function nativeTranscriptList(
  rows: readonly NativeTimelineRow[],
  foldIsOpen: (key: number) => boolean,
  pendingCommandId: string | undefined,
  requests: readonly NativeSessionEvent[],
): NativeTranscriptList {
  const openFolds = new Set(
    rows.flatMap((row) => (row.kind === 'work' && foldIsOpen(row.key) ? [row.key] : [])),
  );
  const items: NativeTranscriptItem[] = rows.filter(
    (row) => row.kind === 'work' || row.fold === undefined || foldIsOpen(row.fold),
  );
  if (pendingCommandId !== undefined) items.push({ kind: 'pending', commandId: pendingCommandId });
  for (const event of requests) items.push({ kind: 'request', event });
  return { items, openFolds };
}

/** A cell's key: the key each of these always had in the conversation. */
export function nativeTranscriptItemKey(item: NativeTranscriptItem): string {
  switch (item.kind) {
    case 'work':
      return `work:${item.key}`;
    case 'entry':
      return String(item.key);
    case 'pending':
      return item.commandId;
    case 'request':
      return `${item.event.generation}:${item.event.request?.id}`;
  }
}

/** Cells recycle within a type: a tool reuses a tool's cell, a message a message's. */
export function nativeTranscriptItemType(item: NativeTranscriptItem): string {
  return item.kind === 'entry' ? item.entry.kind : item.kind;
}
