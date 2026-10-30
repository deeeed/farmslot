import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  type CheckoutUpdateOperation,
  type GatewayUpdateStatus,
  Methods,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

/**
 * App-wide "a new Farmslot version is available" strip. Driven entirely by the
 * gateway.status freshness snapshot (local HEAD behind origin/<branch>); emits a
 * `dismiss` event so the host can suppress it until the next update lands.
 */
@customElement('update-banner')
export class UpdateBanner extends LitElement {
  @property({ attribute: false }) status: GatewayUpdateStatus | null = null;
  @property({ type: Boolean }) current = false;
  @property({ type: Boolean }) checking = false;
  @property() age = '';
  @property() readError = '';

  @state() private confirming = false;
  @state() private submitting = false;
  @state() private error = '';
  private requestedTarget = '';
  private priorOperationId?: string;
  private confirmationKey = '';

  protected updated() {
    if (
      this.confirming &&
      (!this.current ||
        this.confirmationKey !== `${this.status?.localSha}:${this.status?.remoteSha}`)
    ) {
      this.confirming = false;
      this.confirmationKey = '';
    }
    if (
      this.status?.operation &&
      this.requestedTarget &&
      this.status.operation.targetSha.startsWith(this.requestedTarget) &&
      this.status.operation.id !== this.priorOperationId &&
      this.error
    ) {
      // The start reply may be lost during a watcher restart. Persisted gateway
      // progress is authoritative once the client reconnects.
      this.error = '';
    }
  }

  private recheck() {
    this.dispatchEvent(new CustomEvent('recheck', { bubbles: true, composed: true }));
  }

  private async updateCheckout() {
    const s = this.status;
    if (
      !s?.remoteSha ||
      !s.canUpdate ||
      !this.current ||
      this.submitting ||
      gateway.connectionState !== 'connected' ||
      this.confirmationKey !== `${s.localSha}:${s.remoteSha}`
    )
      return;
    const owner = getResourceWorkspaceKey();
    const connection = gateway.resourceConnectionId;
    const sameOwner = () =>
      owner === getResourceWorkspaceKey() && connection === gateway.resourceConnectionId;
    this.submitting = true;
    this.requestedTarget = s.remoteSha;
    this.priorOperationId = s.operation?.id;
    this.error = '';
    try {
      await gateway.request<CheckoutUpdateOperation>(Methods.GATEWAY_UPDATE, {
        localSha: s.localSha,
        targetSha: s.remoteSha,
      });
      if (sameOwner()) this.confirming = false;
    } catch (error) {
      if (sameOwner()) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.submitting = false;
    }
  }

  static styles = css`
    :host {
      display: block;
    }
    .banner {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.lg)};
      padding: 6px ${unsafeCSS(spacing.xl)};
      background: ${unsafeCSS(colors.bgCard)};
      border-bottom: 1px solid ${unsafeCSS(colors.statusWarn)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${unsafeCSS(colors.statusWarn)};
      box-shadow: 0 0 6px ${unsafeCSS(colors.statusWarn)};
    }
    .text {
      flex: 1;
      min-width: 0;
    }
    .text strong {
      color: ${unsafeCSS(colors.statusWarn)};
      font-weight: 600;
    }
    .sha {
      margin-left: ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textMuted)};
    }
    code {
      flex: none;
      padding: 2px 8px;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.accent)};
      user-select: all;
    }
    .details {
      flex-basis: 100%;
      line-height: 1.5;
    }
    .error {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    button {
      font: inherit;
      cursor: pointer;
      color: inherit;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      padding: 3px 8px;
      border-radius: ${unsafeCSS(radii.sm)};
    }
    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }
    .dismiss {
      flex: none;
      border: none;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 1.1rem;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
    }
    .dismiss:hover {
      color: ${unsafeCSS(colors.textPrimary)};
    }
  `;

  private dismiss() {
    this.dispatchEvent(new CustomEvent('dismiss', { bubbles: true, composed: true }));
  }

  render() {
    const s = this.status;
    if (!s || (!s.updateAvailable && !s.operation && !this.readError)) return nothing;
    const operation = s.operation;
    const running = this.submitting || operation?.phase === 'running';
    return html`
      <div class="banner" role="status">
        <span class="dot"></span>
        <span class="text">
          ${!s.updateAvailable
            ? (operation?.message ?? 'Gateway update status is unavailable.')
            : html`Checkout update available:
                <strong
                  >${s.commitsBehind} commit${s.commitsBehind === 1 ? '' : 's'} behind</strong
                >`}
          <span class="sha"
            >${operation?.localSha || s.localSha || '?'} → ${s.remoteSha || '?'}</span
          >
        </span>
        <button
          class="refresh"
          ?disabled=${running || this.checking || gateway.connectionState !== 'connected'}
          @click=${() => this.recheck()}
        >
          ${this.checking ? 'Checking upstream…' : 'Recheck upstream'}
        </button>
        ${s.canUpdate && s.updateAvailable
          ? html`
              <button
                class="update"
                ?disabled=${running || this.checking || !this.current}
                @click=${() => {
                  if (this.confirming) void this.updateCheckout();
                  else {
                    this.confirmationKey = `${s.localSha}:${s.remoteSha}`;
                    this.confirming = true;
                  }
                }}
              >
                ${running ? 'Updating…' : this.confirming ? 'Confirm update' : 'Update checkout'}
              </button>
            `
          : !s.canUpdate && s.updateAvailable
            ? html`<span>Run in a terminal: <code>${s.updateCommand}</code></span>`
            : nothing}
        <button
          class="dismiss"
          ?disabled=${running}
          title="Dismiss until the next update"
          @click=${() => this.dismiss()}
        >
          ×
        </button>
        ${s.updateAvailable && operation
          ? html`<div class="details" role=${operation.phase === 'error' ? 'alert' : 'status'}>
              ${operation.message}
            </div>`
          : nothing}
        ${this.confirming
          ? html`<div class="details">
              Update the gateway checkout at <code>${s.checkoutPath}</code> to ${s.remoteSha}. Only
              a clean default branch can be fast-forwarded. The gateway may reconnect. This does not
              replace the installed macOS app.
              <button
                ?disabled=${running}
                @click=${() => {
                  this.confirming = false;
                }}
              >
                Cancel
              </button>
            </div>`
          : nothing}
        ${operation?.desktopRebuildRequired && operation.phase === 'complete'
          ? html`<div class="details">
              Desktop shell files changed. Rebuild and replace the macOS app to use those changes.
            </div>`
          : nothing}
        ${operation?.gatewayRestartRequired && operation.phase === 'complete'
          ? html`<div class="details">
              Gateway source changed. Development watch mode reloads it; a packaged gateway needs a
              restart.
            </div>`
          : nothing}
        ${this.error ? html`<div class="details error" role="alert">${this.error}</div>` : nothing}
        ${this.age && s.canUpdate && s.updateAvailable
          ? html`<div class="details">
              Saved gateway update, ${this.age}. Updating waits for a current source check.
            </div>`
          : nothing}
        ${this.readError
          ? html`<div class="details error" role="alert">
              ${this.readError}
              <button
                ?disabled=${gateway.connectionState !== 'connected'}
                @click=${() =>
                  this.dispatchEvent(new CustomEvent('retry', { bubbles: true, composed: true }))}
              >
                Retry failed read
              </button>
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'update-banner': UpdateBanner;
  }
}
