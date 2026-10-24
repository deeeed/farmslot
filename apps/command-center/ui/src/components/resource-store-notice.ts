import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  browserResourceStoreDiagnostics,
  createBrowserSqliteResourceStore,
} from '@farmslot/local-store/browser';
import type { StoredResourceQueryInfo } from '@farmslot/protocol/client-cache';

import {
  getResourceStoreMetadata,
  getResourceStoreNotice,
  getResourceWorkspaceKey,
  subscribeResourceCache,
} from '../resource-cache.js';

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
  private stop?: () => void;
  static styles = css`
    :host {
      position: fixed;
      left: 12px;
      bottom: 8px;
      z-index: 200;
      pointer-events: none;
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
      white-space: nowrap;
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    this.stop = subscribeResourceCache(() => {
      this.notice = getResourceStoreNotice();
    });
    this.notice = getResourceStoreNotice();
  }
  disconnectedCallback() {
    this.stop?.();
    super.disconnectedCallback();
  }
  render() {
    return this.notice
      ? html`<div role="status" data-testid="resource-store-notice">
          Offline data will not survive a restart in this tab.
        </div>`
      : nothing;
  }
}
