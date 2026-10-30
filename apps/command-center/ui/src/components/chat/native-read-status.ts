import { type NativeSessionInfo, sourceObservationAge } from '@farmslot/protocol';

export interface NativeReadStatusContext {
  connected: boolean;
  selected: boolean;
  caughtUp: boolean;
  taskHistory: boolean;
  refreshingHistory?: boolean;
  readError?: string;
  unavailableSince?: number;
  observedAt?: number;
  saved?: boolean;
  unsupported?: boolean;
  sessionState?: NativeSessionInfo['state'];
  now: number;
}

export function nativeReadStatus(ctx: NativeReadStatusContext) {
  const waiting = !ctx.connected || Boolean(ctx.readError) || ctx.unavailableSince !== undefined;
  const unavailable = waiting && ctx.now - (ctx.unavailableSince ?? ctx.now) >= 60_000;
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
                : ctx.selected
                  ? `Live${ctx.sessionState ? ` · ${ctx.sessionState}` : ''}`
                  : 'Ready';
  const age =
    ctx.observedAt === undefined
      ? ctx.selected
        ? 'No history read yet'
        : ''
      : ctx.saved
        ? `Saved conversation history, ${sourceObservationAge(ctx.observedAt, ctx.now)}. Actions wait for a current read.`
        : `Updated ${sourceObservationAge(ctx.observedAt, ctx.now).replace(/ old$/, ' ago')}`;
  return { state, text, age, retry: waiting && ctx.connected && !ctx.unsupported };
}
