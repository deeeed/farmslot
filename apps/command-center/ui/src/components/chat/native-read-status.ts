import { type NativeSessionInfo, sourceObservationAge } from '@farmslot/protocol';
import { type NativeWork, nativeWorkLabel } from '@farmslot/protocol/client-cache';

export interface NativeReadStatusContext {
  connected: boolean;
  selected: boolean;
  caughtUp: boolean;
  taskHistory: boolean;
  refreshingHistory?: boolean;
  readError?: string;
  readErrorCode?: string;
  unavailableSince?: number;
  observedAt?: number;
  saved?: boolean;
  unsupported?: boolean;
  sessionState?: NativeSessionInfo['state'];
  /** The turn a running session is working on. */
  work?: NativeWork;
  now: number;
}

export function nativeReadStatus(ctx: NativeReadStatusContext) {
  const denied = ctx.connected && ctx.readErrorCode === 'AUTH_FORBIDDEN';
  const waiting =
    !ctx.connected || denied || Boolean(ctx.readError) || ctx.unavailableSince !== undefined;
  const unavailable = denied || (waiting && ctx.now - (ctx.unavailableSince ?? ctx.now) >= 60_000);
  const state = ctx.unsupported
    ? 'unsupported'
    : waiting
      ? unavailable
        ? 'unavailable'
        : 'reconnecting'
      : ctx.refreshingHistory
        ? 'refreshing'
        : ctx.selected && !ctx.caughtUp
          ? 'loading'
          : 'ready';
  const text =
    state === 'unsupported'
      ? 'Update the gateway to read history.'
      : denied
        ? 'Native access denied'
        : state === 'unavailable'
          ? ctx.connected
            ? 'Unavailable · Retry'
            : 'Unavailable · Reconnect'
          : state === 'reconnecting'
            ? 'Reconnecting'
            : state === 'refreshing'
              ? 'Refreshing history'
              : state === 'loading'
                ? 'Loading history'
                : ctx.taskHistory
                  ? 'Task history'
                  : ctx.selected && ctx.sessionState === 'running' && ctx.work
                    ? nativeWorkLabel(ctx.work, ctx.now)
                    : ctx.selected
                      ? `Live${ctx.sessionState ? ` · ${ctx.sessionState}` : ''}`
                      : 'Ready';
  const age = denied
    ? (ctx.readError ?? 'This account is not authorized for this native workspace.')
    : ctx.observedAt === undefined
      ? ctx.selected
        ? 'No history read yet'
        : ''
      : ctx.saved
        ? `Saved conversation history, ${sourceObservationAge(ctx.observedAt, ctx.now)}. Actions wait for a current read.`
        : `Updated ${sourceObservationAge(ctx.observedAt, ctx.now).replace(/ old$/, ' ago')}`;
  return { state, text, age, retry: waiting && ctx.connected && !ctx.unsupported && !denied };
}
