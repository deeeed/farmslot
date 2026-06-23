import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { GatewayUpdateStatus } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

/**
 * App-wide "a new Farmslot version is available" strip. Driven entirely by the
 * gateway.status freshness snapshot (local HEAD behind origin/<branch>); emits a
 * `dismiss` event so the host can suppress it until the next update lands.
 */
@customElement('update-banner')
export class UpdateBanner extends LitElement {
  @property({ attribute: false }) status: GatewayUpdateStatus | null = null;

  static styles = css`
    :host {
      display: block;
    }
    .banner {
      display: flex;
      align-items: center;
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
    if (!s || !s.updateAvailable) return nothing;
    const n = s.commitsBehind;
    return html`
      <div class="banner" role="status">
        <span class="dot"></span>
        <span class="text">
          Farmslot update available — <strong>${n} commit${n === 1 ? '' : 's'} behind</strong>
          ${s.remoteSha
            ? html`<span class="sha">${s.localSha || '?'} → ${s.remoteSha}</span>`
            : nothing}
        </span>
        <code>${s.updateCommand}</code>
        <button
          class="dismiss"
          title="Dismiss until the next update"
          @click=${() => this.dismiss()}
        >
          ×
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'update-banner': UpdateBanner;
  }
}
