import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ResourceControlAction, ResourceStatus } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

import type { ResourceEntry } from './fleet-canvas.js';

const statusColor: Record<ResourceStatus, string> = {
  running: colors.statusOk,
  stopped: colors.statusUnknown,
  error: colors.statusFail,
  unknown: colors.statusUnknown,
  stale: colors.statusWarn,
};

@customElement('resource-overview')
export class ResourceOverview extends LitElement {
  @property() resourceId = '';
  @property() label = '';
  @property({ type: Array }) entries: ResourceEntry[] = [];
  @property({ attribute: false }) onlineMachines: Set<string> = new Set();
  @state() private _busy = new Set<string>(); // slotIds with in-flight control
  @state() private _flash = ''; // brief status message
  @state() private _refreshing = false;

  static styles = css`
    :host {
      display: block;
    }
    .group {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.lg)};
      padding: ${unsafeCSS(spacing.lg)};
      box-shadow: ${unsafeCSS(shadows.card)};
    }
    .group-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.lg)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeMd)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }
    .resource-icon {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
    }
    .count {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
      margin-left: auto;
    }
    .count-running {
      color: ${unsafeCSS(colors.statusOk)};
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    th {
      text-align: left;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 4px 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    td {
      padding: 6px 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)}66;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:hover td {
      background: ${unsafeCSS(colors.bgCard)}44;
    }
    .machine-link {
      color: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .machine-link:hover {
      text-decoration: underline;
    }
    .slot-link {
      color: ${unsafeCSS(colors.accent)};
      cursor: pointer;
      text-decoration: none;
    }
    .slot-link:hover {
      text-decoration: underline;
    }
    .status-cell {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .control-btn {
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      cursor: pointer;
    }
    .control-btn:hover {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }
    .control-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }
    .bulk-btn {
      padding: 2px 10px;
      border-radius: 3px;
      border: 1px solid ${unsafeCSS(colors.textMuted)}44;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      cursor: pointer;
    }
    .bulk-btn:hover {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }
    .bulk-btn:disabled,
    .control-btn[aria-busy='true'] {
      opacity: 0.3;
      cursor: default;
      pointer-events: none;
    }
    .flash {
      font-size: 10px;
      font-family: ${unsafeCSS(fonts.mono)};
      padding: 2px 6px;
      border-radius: 3px;
    }
    .flash-ok {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .flash-err {
      color: ${unsafeCSS(colors.statusFail)};
    }
  `;

  private get runningCount() {
    return this.entries.filter((e) => e.status === 'running').length;
  }

  private get hasMixedLabels() {
    if (this.entries.length <= 1) return false;
    const first = this.entries[0].label;
    return this.entries.some((e) => e.label !== first);
  }

  private showFlash(msg: string, ok: boolean) {
    this._flash = `${ok ? 'ok' : 'err'}:${msg}`;
    this.requestUpdate();
    setTimeout(() => {
      this._flash = '';
      this.requestUpdate();
    }, 3000);
  }

  private async handleControl(slotId: string, action: ResourceControlAction): Promise<boolean> {
    this._busy = new Set([...this._busy, slotId]);
    this.requestUpdate();
    try {
      const res = (await gateway.request(Methods.RESOURCE_CONTROL, {
        slotId,
        resourceId: this.resourceId,
        action,
      })) as { ok: boolean; detail?: string };
      if (!res.ok) {
        console.error(`[resource-overview] ${action} ${slotId}/${this.resourceId}: ${res.detail}`);
        this.showFlash(`${slotId}: ${res.detail}`, false);
        return false;
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[resource-overview] ${action} failed for ${slotId}/${this.resourceId}:`, msg);
      this.showFlash(`${slotId}: ${msg}`, false);
      return false;
    } finally {
      this._busy = new Set([...this._busy].filter((id) => id !== slotId));
      this.requestUpdate();
    }
  }

  private async handleRefresh() {
    this._refreshing = true;
    this.dispatchEvent(new CustomEvent('refresh-resources', { bubbles: true, composed: true }));
  }

  updated(changed: Map<string, unknown>) {
    // Clear refresh spinner when entries prop changes (fleet-canvas finished fetching)
    if (changed.has('entries') && this._refreshing) {
      this._refreshing = false;
    }
  }

  private async handleBulk(action: ResourceControlAction) {
    const targets = this.entries.filter((e) => {
      if (!e.controllable) return false;
      if (action === 'boot') return (e.status === 'stopped' || e.status === 'unknown') && e.hasBoot;
      if (action === 'shutdown') return e.status === 'running' && e.hasShutdown;
      return false;
    });
    if (targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((e) => this.handleControl(e.slotId, action)),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    const failed = targets.length - succeeded;
    if (failed === 0) {
      this.showFlash(`${action} sent to ${succeeded} resource${succeeded > 1 ? 's' : ''}`, true);
    } else {
      this.showFlash(`${failed}/${targets.length} failed`, false);
    }
  }

  render() {
    const total = this.entries.length;
    const running = this.runningCount;
    const mixed = this.hasMixedLabels;
    return html`
      <div class="group">
        <div class="group-header">
          <span class="resource-icon">[${this.resourceId}]</span>
          <span>${this.label}</span>
          <span class="count">
            <span class="${running > 0 ? 'count-running' : ''}">${running}</span>/${total} running
          </span>
          <button
            class="bulk-btn"
            ?disabled=${this._refreshing}
            @click=${() => this.handleRefresh()}
          >
            ${this._refreshing ? '...' : 'Refresh'}
          </button>
          ${running > 0
            ? html`<button
                class="bulk-btn"
                ?disabled=${this._busy.size > 0}
                @click=${() => this.handleBulk('shutdown')}
              >
                Off All
              </button>`
            : ''}
          ${this._flash
            ? html`<span class="flash ${this._flash.startsWith('ok:') ? 'flash-ok' : 'flash-err'}"
                >${this._flash.slice(this._flash.indexOf(':') + 1)}</span
              >`
            : ''}
        </div>
        <table>
          <thead>
            <tr>
              <th>Slot</th>
              <th>Machine</th>
              ${mixed ? html`<th>Type</th>` : ''}
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${this.entries.map((e) => this.renderRow(e, mixed))}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderRow(e: ResourceEntry, showLabel: boolean) {
    const sc = statusColor[e.status];
    const isRunning = e.status === 'running';
    const isStopped = e.status === 'stopped' || e.status === 'unknown';
    return html`
      <tr>
        <td>
          <span
            class="slot-link"
            @click=${() => {
              location.hash = `slot/${e.slotId}`;
            }}
            >${e.slotId}</span
          >
        </td>
        <td><a class="machine-link" href="#config/${e.machine}">${e.machine}</a></td>
        ${showLabel ? html`<td>${e.label}</td>` : ''}
        <td>
          <span class="status-cell">
            <span class="status-dot" style="background:${sc}"></span>
            ${e.status}
          </span>
        </td>
        <td>
          ${e.controllable
            ? html`
                ${isStopped && e.hasBoot
                  ? html`<button
                      class="control-btn"
                      aria-busy="${this._busy.has(e.slotId)}"
                      @click=${() => this.handleControl(e.slotId, 'boot')}
                    >
                      Boot
                    </button>`
                  : ''}
                ${isRunning && e.hasShutdown
                  ? html`<button
                      class="control-btn"
                      aria-busy="${this._busy.has(e.slotId)}"
                      @click=${() => this.handleControl(e.slotId, 'shutdown')}
                    >
                      Off
                    </button>`
                  : ''}
              `
            : ''}
        </td>
      </tr>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resource-overview': ResourceOverview;
  }
}
