// <resource-panel> — container managing resource toolbar + stream grid + subscriptions

import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ResourceControlAction, SlotActionSummary, SlotResource } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './resource-toolbar.js';
import './resource-grid.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

import type { ActiveStream } from './resource-grid.js';

@customElement('resource-panel')
export class ResourcePanel extends LitElement {
  @property({ type: String }) slotId = '';
  @property({ type: Array }) resources: SlotResource[] = [];
  @property({ type: Array }) actions: SlotActionSummary[] = [];
  @property({ type: Array }) runningActionIds: string[] = [];

  @state() private _activeStreams: ActiveStream[] = [];

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgSurface)};
      min-width: 0;
      min-height: 0;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      height: 28px;
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
      box-sizing: border-box;
      min-width: 0;
    }

    .panel-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
      letter-spacing: 0.03em;
      flex-shrink: 0;
    }

    resource-toolbar {
      flex: 1 1 0;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    resource-toolbar::-webkit-scrollbar {
      display: none;
    }

    .close-btn {
      flex-shrink: 0;
      background: none;
      border: none;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font-size: 14px;
      padding: 0 4px;
    }

    .close-btn:hover {
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('slotId')) {
      // Reset streams when slot changes
      this._activeStreams = [];
    }
    if (changed.has('_activeStreams')) {
      this.dispatchEvent(
        new CustomEvent('resource-streams-changed', {
          detail: { activeIds: this.activeIds },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _onResourceToggle(e: CustomEvent<{ resourceId: string; active: boolean }>) {
    const { resourceId, active } = e.detail;
    if (active) {
      // Add stream
      const resource = this.resources.find((r) => r.id === resourceId);
      if (!resource) return;
      if (this._activeStreams.some((s) => s.resourceId === resourceId)) return;
      // resourceIndex -1 = accept all frames; server assigns real index on subscribe
      this._activeStreams = [...this._activeStreams, { resourceId, resource, resourceIndex: -1 }];
    } else {
      // Remove stream
      this._activeStreams = this._activeStreams.filter((s) => s.resourceId !== resourceId);
      // If no streams left, emit close event
      if (this._activeStreams.length === 0) {
        this.dispatchEvent(new CustomEvent('panel-close', { bubbles: true, composed: true }));
      }
    }
  }

  private async _onResourceControl(
    e: CustomEvent<{ resourceId: string; action: ResourceControlAction }>,
  ) {
    const { resourceId, action } = e.detail;
    try {
      await gateway.request(Methods.RESOURCE_CONTROL, {
        slotId: this.slotId,
        resourceId,
        action,
      });
    } catch (err) {
      console.error(
        `[resource-panel] control ${action} failed for ${resourceId}:`,
        (err as Error).message,
      );
    }
    // On shutdown, remove the stream for this resource
    if (action === 'shutdown') {
      this._activeStreams = this._activeStreams.filter((s) => s.resourceId !== resourceId);
      if (this._activeStreams.length === 0) {
        this.dispatchEvent(new CustomEvent('panel-close', { bubbles: true, composed: true }));
      }
    }
  }

  private _onSlotActionRun(e: CustomEvent<{ actionId: string }>) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('slot-action-run', {
        detail: e.detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _closeAll() {
    this._activeStreams = [];
    this.dispatchEvent(new CustomEvent('panel-close', { bubbles: true, composed: true }));
  }

  get activeIds(): string[] {
    return this._activeStreams.map((s) => s.resourceId);
  }

  get hasActiveStreams(): boolean {
    return this._activeStreams.length > 0;
  }

  activateResource(resourceId: string) {
    const resource = this.resources.find((entry) => entry.id === resourceId);
    if (!resource?.definition.streamable) return;
    if (this._activeStreams.some((stream) => stream.resourceId === resourceId)) return;
    this._activeStreams = [...this._activeStreams, { resourceId, resource, resourceIndex: -1 }];
  }

  render() {
    return html`
      <div class="panel-header">
        <span class="panel-label">STREAMS</span>
        <resource-toolbar
          .resources=${this.resources}
          .activeIds=${this.activeIds}
          .actions=${this.actions}
          .runningActionIds=${this.runningActionIds}
          @resource-toggle=${this._onResourceToggle}
          @resource-control=${this._onResourceControl}
          @slot-action-run=${this._onSlotActionRun}
        ></resource-toolbar>
        <button class="close-btn" @click=${this._closeAll} title="Close panel">&#x2715;</button>
      </div>
      <div class="body">
        <resource-grid .slotId=${this.slotId} .streams=${this._activeStreams}></resource-grid>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resource-panel': ResourcePanel;
  }
}
