// terminal-subscriptions.ts — Terminal subscription key ownership and cleanup helpers

import { type PtyDataHandler, unsubscribePty } from '../runtime/pty-stream.js';
import { unsubscribe as unsubscribeTerminalPoll } from '../runtime/tmux-stream.js';

import type { ClientState, TerminalSubscriptionState } from './client-state.js';

export function terminalKeysForSlot(state: ClientState, slotId: string): string[] {
  const slotPrefix = `${slotId}:`;
  return [...new Set([...state.terminalHandlers.keys(), ...state.ptyHandlers.keys()])].filter(
    (key) => key === slotId || key.startsWith(slotPrefix),
  );
}

export function removeTerminalSubscriptionForKey(
  state: ClientState,
  _slotId: string,
  key: string,
): void {
  const handler = state.terminalHandlers.get(key);
  if (handler) {
    unsubscribeTerminalPoll(key, handler);
    state.terminalHandlers.delete(key);
  }
  const ptyHandler = state.ptyHandlers.get(key);
  if (ptyHandler) {
    unsubscribePty(key, ptyHandler);
    state.ptyHandlers.delete(key);
  }
  state.terminalIdentities.delete(key);
}

export function terminalUnsubscribeKeysForRequest(
  state: TerminalSubscriptionState,
  slotId: string,
  requestedKey: string,
  rawKey: string,
): string[] {
  if (state.terminalHandlers.has(requestedKey) || state.ptyHandlers.has(requestedKey)) {
    return [requestedKey];
  }
  if (rawKey === slotId && (state.terminalHandlers.has(slotId) || state.ptyHandlers.has(slotId))) {
    return [slotId];
  }
  return [];
}

/** Async node attachment may finish after Unsubscribe, a replacement, or client disconnect. */
export function adoptWorkerTerminalSubscription(
  state: TerminalSubscriptionState,
  key: string,
  sequence: number,
  handler: PtyDataHandler,
  active: boolean,
): boolean {
  if (!active || state.terminalSubscribeSeq.get(`worker:${key}`) !== sequence) {
    unsubscribePty(key, handler);
    return false;
  }
  state.workerTerminalHandlers.set(key, handler);
  return true;
}
