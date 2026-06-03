import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('farm-hydrating')
export class FarmHydrating extends LitElement {
  @property() message = 'Loading…';

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      min-height: 120px;
      padding: ${unsafeCSS(spacing.xxl)};
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .wrap {
      display: inline-flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      animation: pulse 1.4s ease-in-out infinite;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${unsafeCSS(colors.statusWarn)};
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.55;
      }
      50% {
        opacity: 1;
      }
    }
  `;

  render() {
    return html`<span class="wrap" role="status" aria-live="polite" aria-busy="true"
      ><span class="dot" aria-hidden="true"></span>${this.message}</span
    >`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'farm-hydrating': FarmHydrating;
  }
}
