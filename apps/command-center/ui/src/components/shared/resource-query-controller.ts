import type { ReactiveController, ReactiveControllerHost } from 'lit';

import type {
  GatewayResourceCache,
  ResourceQuery,
  ResourceQueryError,
  ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import {
  getResourceCache,
  getResourceWorkspaceAccess,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';

/** How long reads may keep being superseded before the held data counts as saved. */
const SUPERSEDED_READ_GRACE_MS = 60_000;

/**
 * The gateway refuses a read whose source changed while it ran. It has already published that
 * change, so the next read is scheduled: the held data is outdated, not unreadable.
 */
export function isSupersededRead(error: ResourceQueryError | undefined): boolean {
  return error?.code === 'RESOURCE_OBSERVATION_CHANGED';
}

/**
 * Held data stays saved while disconnected, after a failed read, or while the gateway's own source
 * check is not current. A reread in flight also marks it stale, but only for that read, so a notice
 * shown then would come and go with every change. A superseded read counts once it keeps happening.
 */
export function heldDataIsSaved(
  state: ResourceQueryState<unknown>,
  connected = gateway.connectionState === 'connected',
  now = Date.now(),
): boolean {
  return (
    state.status === 'stale' &&
    state.data !== undefined &&
    (!connected ||
      (state.error !== undefined &&
        (!isSupersededRead(state.error) ||
          now - (state.observedAt ?? 0) >= SUPERSEDED_READ_GRACE_MS)) ||
      (state.sourceObservation !== undefined && state.sourceObservation.status !== 'ready'))
  );
}

/**
 * Nothing held, and reads have kept failing (superseded or not) for the grace period. The cache
 * clears a cold entry's error while it rereads, so this counts from the query's first failure.
 */
export function readKeepsFailing<T>(query: ResourceQueryController<T>, now = Date.now()): boolean {
  return (
    query.state.data === undefined &&
    query.failingSince !== undefined &&
    now - query.failingSince >= SUPERSEDED_READ_GRACE_MS
  );
}

/**
 * The read failure a panel names. A superseded read already has its reread scheduled, so it is not
 * named; held data shows as saved once the grace period passes, and with nothing held the panel
 * says it was never read.
 */
export function readFailureText<T>(
  query: ResourceQueryController<T>,
  now = Date.now(),
): string | undefined {
  const error = query.state.error;
  if (error && !isSupersededRead(error)) return error.message;
  return readKeepsFailing(query, now) ? 'not read yet' : undefined;
}

/** Binds a panel's query to the current farm owner; the shared cache owns all reads. */
export class ResourceQueryController<T> implements ReactiveController {
  state: ResourceQueryState<T> = { status: 'loading' };
  /** When the reads of this query started failing with nothing held; cleared by an answer. */
  failingSince?: number;
  private query?: ResourceQuery<T>;
  private cache?: GatewayResourceCache;
  private workspaceKey?: string;
  private connected = false;
  private version = 0;
  private stopQuery?: () => void;
  private stopOwner?: () => void;
  private stopConnection?: () => void;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly onChange?: (state: ResourceQueryState<T>) => void,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connected = true;
    this.stopOwner = subscribeResourceCache(() => this.bind());
    this.stopConnection = gateway.onConnectionChange(() => {
      this.bind();
      this.host.requestUpdate();
    });
    this.bind(true);
  }

  hostDisconnected(): void {
    this.connected = false;
    this.version++;
    this.stopQuery?.();
    this.stopOwner?.();
    this.stopConnection?.();
    this.stopQuery = undefined;
    this.cache = undefined;
  }

  setQuery(query?: ResourceQuery<T>): void {
    if (query?.id === this.query?.id) return;
    this.query = query;
    this.bind(true);
  }

  get belongsToWorkspace(): boolean {
    return (
      this.connected &&
      this.cache !== undefined &&
      this.cache === getResourceCache() &&
      this.workspaceKey === getResourceWorkspaceKey() &&
      (gateway.connectionState !== 'connected' || gateway.workspaceAccess === 'farm')
    );
  }

  get ready(): boolean {
    return (
      this.belongsToWorkspace &&
      gateway.connectionState === 'connected' &&
      this.state.status === 'ready'
    );
  }

  requireReady(): T {
    const state = this.cache && this.query ? this.cache.read(this.query) : undefined;
    if (!this.ready || state?.status !== 'ready' || state.data === undefined)
      throw new Error('Wait for a current read before acting.');
    return state.data;
  }

  async retry(): Promise<ResourceQueryState<T>> {
    if (!this.cache || !this.query) return this.state;
    return this.cache.retry(this.query);
  }

  private bind(force = false): void {
    if (!this.connected) return;
    const farm =
      getResourceWorkspaceAccess() === 'farm' ||
      (gateway.connectionState === 'connected' && gateway.workspaceAccess === 'farm');
    const cache = farm ? getResourceCache() : undefined;
    const key = getResourceWorkspaceKey();
    if (!force && cache === this.cache && key === this.workspaceKey) return;
    this.stopQuery?.();
    this.stopQuery = undefined;
    const version = ++this.version;
    this.cache = cache;
    this.workspaceKey = key;
    this.failingSince = undefined;
    this.publish({ status: 'loading' });
    if (cache && this.query && version === this.version && key === getResourceWorkspaceKey()) {
      const stop = cache.observe(this.query, (state) => {
        if (version === this.version && key === getResourceWorkspaceKey()) this.publish(state);
      });
      // An immediate cached reply may retire or replace this query from its callback.
      if (version === this.version && cache === this.cache && key === getResourceWorkspaceKey())
        this.stopQuery = stop;
      else stop();
    }
  }

  private publish(state: ResourceQueryState<T>): void {
    if (state.data !== undefined || state.status === 'ready' || state.status === 'unsupported')
      this.failingSince = undefined;
    else if (state.error) this.failingSince ??= Date.now();
    this.state = state;
    this.onChange?.(state);
    this.host.requestUpdate();
  }
}
