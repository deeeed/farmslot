import type { ReactiveController, ReactiveControllerHost } from 'lit';

import {
  canActOn as canActOnHeldData,
  type GatewayResourceCache,
  heldDataIsSaved as heldDataIsSavedFor,
  type ResourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import {
  getResourceCache,
  getResourceWorkspaceAccess,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../../resource-cache.js';
import { notificationTray, publishReadNotice } from '../../utils/notification-tray.js';

import { readCurrent } from './read-current.js';

export {
  isSupersededRead,
  readFailureText,
  readKeepsFailing,
} from '../../utils/resource-read-status.js';

/** The shared held-data rule for this tab's gateway connection. */
export function heldDataIsSaved(
  state: ResourceQueryState<unknown>,
  connected = gateway.connectionState === 'connected',
  now = Date.now(),
): boolean {
  return heldDataIsSavedFor(state, connected, now);
}

/** The shared action rule for this tab's gateway connection. */
export function canActOn(
  state: ResourceQueryState<unknown>,
  connected = gateway.connectionState === 'connected',
  now = Date.now(),
): boolean {
  return canActOnHeldData(state, connected, now);
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
  private readonly noticeSource = {};
  private noticeRoute = '#fleet';
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
    notificationTray.clear(this.noticeSource);
    this.version++;
    this.stopQuery?.();
    this.stopOwner?.();
    this.stopConnection?.();
    this.stopQuery = undefined;
    this.cache = undefined;
  }

  setQuery(query?: ResourceQuery<T>): void {
    if (query?.id === this.query?.id) return;
    notificationTray.clear(this.noticeSource);
    this.query = query;
    this.noticeRoute = typeof location === 'undefined' ? '#fleet' : location.hash;
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

  /** An action can start; requireCurrent rereads a paced query before it runs. */
  get actable(): boolean {
    return this.belongsToWorkspace && canActOn(this.state);
  }

  requireReady(): T {
    const state = this.cache && this.query ? this.cache.read(this.query) : undefined;
    if (!this.ready || state?.status !== 'ready' || state.data === undefined)
      throw new Error('Wait for a current read before acting.');
    return state.data;
  }

  async requireCurrent(): Promise<T> {
    if (this.cache && this.query && this.actable) await readCurrent(this.cache, [this.query]);
    return this.requireReady();
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
    notificationTray.setOwner(farm ? key : undefined);
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
    if (this.query) {
      const owner = this.workspaceKey;
      const query = this.query;
      publishReadNotice(this.noticeSource, owner, this.query, state, this.noticeRoute, {
        connected: gateway.connectionState === 'connected',
        retry: () => {
          if (owner === this.workspaceKey && query === this.query && this.belongsToWorkspace)
            void this.retry();
        },
      });
    }
    this.onChange?.(state);
    this.host.requestUpdate();
  }
}
