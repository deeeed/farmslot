import type { ReactiveController, ReactiveControllerHost } from 'lit';

import type {
  GatewayResourceCache,
  ResourceQuery,
  ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import {
  getResourceCache,
  getResourceWorkspaceAccess,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';

/** Binds a panel's query to the current farm owner; the shared cache owns all reads. */
export class ResourceQueryController<T> implements ReactiveController {
  state: ResourceQueryState<T> = { status: 'loading' };
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
    this.state = state;
    this.onChange?.(state);
    this.host.requestUpdate();
  }
}
