import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  type CheckoutUpdateOperation,
  type GatewayUpdateStatus,
  Methods,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

/**
 * App-wide "a new Farmslot version is available" strip. Driven entirely by the
 * gateway.status freshness snapshot (local HEAD behind origin/<branch>); emits a
 * `dismiss` event so the host can suppress it until the next update lands.
 */
@customElement('update-banner')
export class UpdateBanner extends LitElement {
  @property({ attribute: false }) status: GatewayUpdateStatus | null = null;

  @state() private confirming = false;
  @state() private submitting = false;
  @state() private error = '';
  private pollTimer?: ReturnType<typeof setInterval>;

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.pollTimer);
  }

  protected updated() {
    if (this.status?.operation && this.status.operation.phase !== 'error' && this.error) {
      // The start reply may be lost during a watcher restart. Persisted gateway
      // progress is authoritative once the client reconnects.
      this.error = '';
    }
    if (this.status?.operation?.phase === 'running' && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.refresh(false), 2_000);
    } else if (this.status?.operation?.phase !== 'running') {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private refresh(force = true) {
    this.dispatchEvent(
      new CustomEvent('refresh', { detail: force, bubbles: true, composed: true }),
    );
  }

  private async updateCheckout() {
    const s = this.status;
    if (!s?.remoteSha || !s.canUpdate || this.submitting) return;
    this.submitting = true;
    this.error = '';
    try {
      const operation = await gateway.request<CheckoutUpdateOperation>(Methods.GATEWAY_UPDATE, {
        localSha: s.localSha,
        targetSha: s.remoteSha,
      });
      this.status = { ...s, operation };
      this.confirming = false;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.submitting = false;
      this.refresh(false);
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
    if (!s || (!s.updateAvailable && !s.operation)) return nothing;
    const operation = s.operation;
    const running = this.submitting || operation?.phase === 'running';
    return html`
      <div class="banner" role="status">
        <span class="dot"></span>
        <span class="text">
          ${!s.updateAvailable && operation
            ? operation.message
            : html`Checkout update available:
                <strong
                  >${s.commitsBehind} commit${s.commitsBehind === 1 ? '' : 's'} behind</strong
                >`}
          <span class="sha"
            >${operation?.localSha || s.localSha || '?'} → ${s.remoteSha || '?'}</span
          >
        </span>
        <button class="refresh" ?disabled=${running} @click=${() => this.refresh()}>
          Check again
        </button>
        ${s.canUpdate && s.updateAvailable
          ? html`
              <button
                class="update"
                ?disabled=${running}
                @click=${() => {
                  if (this.confirming) void this.updateCheckout();
                  else this.confirming = true;
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
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'update-banner': UpdateBanner;
  }
}
