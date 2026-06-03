import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { FleetSummary, GitHubRateLimitPayload } from '@farmslot/protocol';

import type { ConnectionState } from '../../gateway-client.js';
import { colors, fonts, layout, spacing } from '../../styles/theme-tokens.js';

@customElement('fleet-summary-bar')
export class FleetSummaryBar extends LitElement {
  @property({ type: Object }) summary: FleetSummary | null = null;
  @property() connection: ConnectionState = 'disconnected';
  @property({ type: Boolean }) hydrated = true;
  @property({ type: Object }) quota: GitHubRateLimitPayload | null = null;
  @property() gatewayUrl = '';
  @property() authMode: 'token' | 'password' | 'none' = 'none';

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      height: ${unsafeCSS(layout.summaryHeight)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      padding: 0 ${unsafeCSS(spacing.xl)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      gap: ${unsafeCSS(spacing.lg)};
      flex-shrink: 0;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .stat .count {
      font-weight: 600;
    }
    .conn {
      margin-left: auto;
      display: flex;
      align-items: center;
    }
    .conn-button {
      display: flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 999px;
      color: ${unsafeCSS(colors.textSecondary)};
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: 4px 8px;
    }
    .conn-button:hover {
      background: ${unsafeCSS(colors.bgCard)};
      border-color: ${unsafeCSS(colors.bgCardHover)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .conn-meta {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .conn-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .conn-dot.connected {
      background: ${unsafeCSS(colors.statusOk)};
    }
    .conn-dot.connecting {
      background: ${unsafeCSS(colors.statusWarn)};
      animation: pulse 1s infinite;
    }
    .conn-dot.hydrating {
      background: ${unsafeCSS(colors.statusWarn)};
      animation: pulse 1s infinite;
    }
    .conn-dot.disconnected {
      background: ${unsafeCSS(colors.statusFail)};
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
    .sep {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .quota {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: default;
    }
    .quota.ok {
      color: ${unsafeCSS(colors.statusOk)};
      background: ${unsafeCSS(colors.statusOk)}15;
    }
    .quota.warn {
      color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}25;
    }
    .quota.crit {
      color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}25;
      font-weight: 600;
    }
    .quota-label {
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;

  render() {
    const s = this.summary;
    return html`
      <span class="stat">
        <span class="count" style="color: ${colors.textPrimary}">${s?.total ?? '-'}</span> slots
      </span>
      <span class="sep">|</span>
      <span class="stat">
        <span class="count" style="color: ${colors.lifecycleBusy}">${s?.busy ?? 0}</span> busy
      </span>
      <span class="stat">
        <span class="count" style="color: ${colors.lifecycleReady}">${s?.ready ?? 0}</span> ready
      </span>
      <span class="stat">
        <span class="count" style="color: ${colors.lifecycleHeld}">${s?.held ?? 0}</span> held
      </span>
      <span class="stat">
        <span class="count" style="color: ${colors.statusFail}">${s?.blocked ?? 0}</span> blocked
      </span>
      <span class="stat">
        <span class="count" style="color: ${colors.lifecycleDisabled}">${s?.disabled ?? 0}</span>
        disabled
      </span>
      ${this.renderQuota()}
      <span class="conn">
        <button
          class="conn-button"
          title=${this.connectionTitle()}
          @click=${() => this.dispatchEvent(new CustomEvent('connection-details'))}
        >
          <span class="conn-dot ${this.connStateLabel()}"></span>
          <span>${this.connStateLabel()}</span>
          <span class="conn-meta">${this.connectionMeta()}</span>
        </button>
      </span>
    `;
  }

  private connStateLabel(): ConnectionState | 'hydrating' {
    if (this.connection === 'connected' && !this.hydrated) return 'hydrating';
    return this.connection;
  }

  private connectionMeta(): string {
    const auth = this.authMode === 'none' ? 'no auth' : this.authMode;
    if (!this.gatewayUrl) return auth;
    return `${auth} · ${this.gatewayUrl}`;
  }

  private connectionTitle(): string {
    return `Gateway ${this.connStateLabel()} · ${this.connectionMeta()} · click for connection and companion pairing`;
  }

  private renderQuota() {
    const q = this.quota;
    if (!q || !q.limit) return '';
    const pctRemaining = Math.max(0, 100 - q.percentUsed);
    const severity = pctRemaining < 5 ? 'crit' : pctRemaining < 20 ? 'warn' : 'ok';
    const resetMin = Math.max(0, Math.round((new Date(q.resetAt).getTime() - Date.now()) / 60000));
    const title = `GitHub API: ${q.remaining}/${q.limit} remaining (${q.percentUsed}% used). Resets in ${resetMin}m at ${new Date(q.resetAt).toLocaleTimeString()}.`;
    return html`
      <span class="quota ${severity}" title=${title}>
        <span class="quota-label">gh</span>
        ${q.remaining}/${q.limit}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fleet-summary-bar': FleetSummaryBar;
  }
}
