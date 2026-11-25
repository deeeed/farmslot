import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  browserResourceStoreDiagnostics,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import {
  type GatewayResourceCache,
  resourceSyncLabel,
  type ResourceSyncState,
  type StoredResourceQueryInfo,
} from '@farmslot/protocol/client-cache';

import {
  getResourceCache,
  getResourceStoreMetadata,
  getResourceStoreNotice,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../resource-cache.js';
import { resourceViewMatches } from '../utils/resource-view-sync.js';
import { hashRoute } from '../utils/url-state.js';

@customElement('farm-resource-store-notice')
export class ResourceStoreNotice extends LitElement {
  /** Read-only storage receipt for browser/desktop validation, with no query data or SQL execution. */
  resourceStoreDiagnostics() {
    return browserResourceStoreDiagnostics();
  }
  /** Inspect only this rendered owner's stored IDs and ages, without data or SQL access. */
  async resourceStoreQueryMetadata(): Promise<StoredResourceQueryInfo[]> {
    const metadata = getResourceStoreMetadata();
    const identity = getResourceWorkspaceKey();
    if (!metadata?.scope.principalId || !identity) return [];
    const store = await createBrowserSqliteResourceStore({ scope: metadata.scope });
    try {
      const queries = await store.listQueries();
      return identity === getResourceWorkspaceKey() ? queries : [];
    } finally {
      await store.close();
    }
  }
  @state() private notice = getResourceStoreNotice();
  @state() private syncState: ResourceSyncState = { status: 'syncing' };
  private cache?: GatewayResourceCache;
  private route?: string;
  private readonly routeChanged = () => this.bindSync();
  private stopSync?: () => void;
  private stop?: () => void;
  private bindSync(): void {
    const cache = getResourceCache();
    const route = hashRoute();
    if (cache === this.cache && route === this.route) return;
    this.stopSync?.();
    this.cache = cache;
    this.route = route;
    this.syncState = { status: 'syncing' };
    this.stopSync = cache?.observeSync?.(
      (state) => {
        if (
          state.status === this.syncState.status &&
          (state.status !== 'cached' ||
            (this.syncState.status === 'cached' &&
              state.observedAt === this.syncState.observedAt)) &&
          (state.status !== 'catch-up' ||
            (this.syncState.status === 'catch-up' &&
              state.done === this.syncState.done &&
              state.total === this.syncState.total))
        )
          return;
        this.syncState = state;
      },
      (query) => resourceViewMatches(route, query),
    );
  }
  static styles = css`
    /* A status row below the app in normal flow (start.ts appends it to body after farm-app),
       so it never covers the bottom of a view such as a chat composer or approval. */
    :host {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 2px 12px;
      pointer-events: none;
    }
    .sync {
      color: #999;
      background: transparent;
      border-color: transparent;
      padding: 0 8px;
    }
    div {
      padding: 4px 8px;
      border: 1px solid #70551e;
      border-radius: 4px;
      background: #241d10;
      color: #f2cf83;
      font:
        12px/18px 'SF Mono',
        monospace;
      white-space: normal;
      overflow-wrap: anywhere;
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.routeChanged);
    this.stop = subscribeResourceCache(() => {
      this.notice = getResourceStoreNotice();
      this.bindSync();
    });
    this.notice = getResourceStoreNotice();
    this.bindSync();
  }
  disconnectedCallback() {
    window.removeEventListener('hashchange', this.routeChanged);
    this.stop?.();
    this.stopSync?.();
    this.cache = undefined;
    super.disconnectedCallback();
  }
  render() {
    return html` <div class="sync" role="status" data-testid="resource-sync-status">
        ${resourceSyncLabel(this.syncState)}
      </div>
      ${this.notice
        ? html`<div role="status" data-testid="resource-store-notice">${this.notice}</div>`
        : nothing}`;
  }
}
