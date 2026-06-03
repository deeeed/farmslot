import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { MonitorViolation } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

const MAX_VIOLATIONS = 50;

type ViolationType = MonitorViolation['type'];

function typeColor(type: ViolationType): string {
  switch (type) {
    case 'stuck':
      return colors.statusFail;
    case 'idle':
      return colors.statusWarn;
    case 'error':
      return colors.statusFail;
    case 'waiting':
      return colors.statusWarn;
    case 'skipped':
      return colors.statusUnknown;
    default:
      return colors.statusUnknown;
  }
}

@customElement('violation-feed')
export class ViolationFeed extends LitElement {
  /** Initial violations to seed the feed (e.g. from dev harness mock data). */
  @property({ attribute: false }) violations: MonitorViolation[] = [];

  @state() private _stateViolations: MonitorViolation[] = [];
  private _unsubState?: () => void;

  private get _allViolations(): MonitorViolation[] {
    return this.violations.length > 0 ? this.violations : this._stateViolations;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: ${unsafeCSS(colors.bgBase)};
    }

    .feed-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .feed-title {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeLg)};
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .feed-count {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .feed-body {
      flex: 1;
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.lg)};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.md)};
    }

    .feed-body::-webkit-scrollbar {
      width: 6px;
    }
    .feed-body::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .violation {
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #1e1e36;
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.lg)};
    }

    .violation-top {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
    }

    .slot-id {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 600;
      color: ${unsafeCSS(colors.accent)};
    }

    .type-badge {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 1px 6px;
      border-radius: 9px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .violation-time {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: auto;
    }

    .violation-message {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
      margin-top: ${unsafeCSS(spacing.md)};
      line-height: 1.4;
    }

    .violation-actions {
      margin-top: ${unsafeCSS(spacing.md)};
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
    }

    .view-btn,
    .nudge-btn {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      border-radius: ${unsafeCSS(radii.sm)};
      border: 1px solid ${unsafeCSS(colors.accent)}44;
      background: transparent;
      color: ${unsafeCSS(colors.accent)};
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .view-btn:hover,
    .nudge-btn:hover {
      opacity: 0.85;
    }

    .nudge-btn {
      border-color: ${unsafeCSS(colors.statusWarn)}44;
      color: ${unsafeCSS(colors.statusWarn)};
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: ${unsafeCSS(spacing.lg)};
    }

    .empty-text {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._syncState(getState());
    this._unsubState = subscribe((s) => this._syncState(s));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubState?.();
  }

  private _syncState(s: AppState): void {
    this._stateViolations = s.violations.slice(0, MAX_VIOLATIONS);
  }

  private _formatTime(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return new Date(iso).toLocaleDateString();
  }

  private _view(v: MonitorViolation) {
    this.dispatchEvent(
      new CustomEvent('violation-view', {
        detail: { slotId: v.slotId, violation: v },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _nudge(v: MonitorViolation) {
    const text = `[NUDGE] ${v.type}: ${v.message}`;
    gateway
      .request(Methods.TERMINAL_SEND, {
        slotId: v.slotId,
        ...(v.role ? { role: v.role } : {}),
        ...(v.contextId ? { contextId: v.contextId } : {}),
        ...(v.target ? { target: v.target } : {}),
        text,
        enter: true,
      })
      .catch((err) => {
        console.warn(`[violation-feed] nudge dispatch failed:`, (err as Error).message);
      });
    this._view(v);
  }

  render() {
    return html`
      <div class="feed-header">
        <span class="feed-title">Violations</span>
        <span class="feed-count">${this._allViolations.length} recorded</span>
      </div>
      <div class="feed-body">
        ${this._allViolations.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-text">No violations</div>
              </div>
            `
          : this._allViolations.map((v) => {
              const color = typeColor(v.type);
              return html`
                <div class="violation">
                  <div class="violation-top">
                    <span class="slot-id">${v.slotId}</span>
                    <span class="type-badge" style="background:${color}22; color:${color}"
                      >${v.type}</span
                    >
                    <span class="violation-time">${this._formatTime(v.timestamp)}</span>
                  </div>
                  <div class="violation-message">${v.message}</div>
                  <div class="violation-actions">
                    <button class="view-btn" @click=${() => this._view(v)}>View</button>
                    <button class="nudge-btn" @click=${() => this._nudge(v)}>Nudge</button>
                  </div>
                </div>
              `;
            })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'violation-feed': ViolationFeed;
  }
}
