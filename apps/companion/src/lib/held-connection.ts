import { useEffect, useRef, useState } from 'react';

import { SUPERSEDED_READ_GRACE_MS } from '@farmslot/protocol/client-cache';

import type { GatewayClient } from './gateway-client';

/**
 * How long a dropped connection still counts as connected for held data. Saved data is the
 * normal state: a short reconnect renders it silently and keeps typing queued, and only an
 * outage past the shared threshold says so.
 */
export const RECONNECT_GRACE_MS = SUPERSEDED_READ_GRACE_MS;

interface TransportState {
  status: string;
  client: Pick<GatewayClient, 'connectionState'> | null;
}

export function transportConnected(state: TransportState): boolean {
  return state.status === 'connected' && state.client?.connectionState === 'connected';
}

/** Tracks when the transport last dropped; a cold start counts from launch. */
export function createOfflineClock(now = Date.now()) {
  let offlineSince: number | null = now;
  return {
    observe(state: TransportState, at = Date.now()) {
      if (transportConnected(state)) offlineSince = null;
      else if (offlineSince === null) offlineSince = at;
    },
    /** True while connected, or within the grace of the last drop. */
    held(state: TransportState, at = Date.now()) {
      this.observe(state, at);
      return offlineSince === null || at - offlineSince < RECONNECT_GRACE_MS;
    },
    graceLeft(at = Date.now()) {
      return offlineSince === null ? null : Math.max(0, RECONNECT_GRACE_MS - (at - offlineSince));
    },
  };
}

/**
 * Re-renders when a value that is currently `true` should turn `false` after `delayMs`, so
 * time-based rules switch without waiting for another store change.
 */
function useExpiry(active: boolean, delayMs: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || delayMs === null || delayMs <= 0) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
}

/** A flag that only counts once it has held for `graceMs`; a brief one never shows. */
export function usePersistentFlag(flag: boolean, graceMs = RECONNECT_GRACE_MS): boolean {
  const since = useRef<number | null>(null);
  if (!flag) since.current = null;
  else if (since.current === null) since.current = Date.now();
  const left = since.current === null ? null : graceMs - (Date.now() - since.current);
  useExpiry(flag, left);
  return flag && left !== null && left <= 0;
}

type TransportStore = (<T>(select: (state: TransportState) => T) => T) & {
  getState: () => TransportState;
  subscribe?: (listener: (state: TransportState) => void) => () => void;
};

/** One clock per connection store: it watches every transport change, rendered or not. */
export function createHeldConnection(store: TransportStore) {
  const clock = createOfflineClock();
  clock.observe(store.getState());
  store.subscribe?.((state) => clock.observe(state));
  const isHeld = () => clock.held(store.getState());
  function useHeldConnection(): boolean {
    const connected = store(transportConnected);
    const held = isHeld();
    useExpiry(!connected && held, clock.graceLeft());
    return held;
  }
  return { isHeld, useHeldConnection };
}
