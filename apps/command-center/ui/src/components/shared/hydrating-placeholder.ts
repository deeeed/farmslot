import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import './skeleton.js';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('farm-hydrating')
export class FarmHydrating extends LitElement {
  @property() message = 'Loading…';
  @property() error = '';

  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-height: 120px;
      padding: ${unsafeCSS(spacing.xxl)};
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .wrap {
      position: relative;
      display: grid;
      gap: ${unsafeCSS(spacing.md)};
    }
    .shapes {
      display: grid;
      gap: ${unsafeCSS(spacing.lg)};
    }
    .spacer {
      visibility: hidden;
    }
    .error {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .error span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    button {
      min-width: 44px;
      min-height: 44px;
      color: inherit;
      background: transparent;
      border: 1px solid currentColor;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
    }
  `;

  render() {
    return html`<div
      class="wrap"
      role=${this.error ? 'alert' : 'status'}
      aria-label=${this.error || this.message}
      aria-busy=${String(!this.error)}
    >
      <div class=${`shapes ${this.error ? 'spacer' : ''}`} aria-hidden="true">
        <slot>
          <farm-skeleton width="38%"></farm-skeleton>
          <farm-skeleton kind="row"></farm-skeleton>
          <farm-skeleton kind="row"></farm-skeleton>
          <farm-skeleton kind="row" width="72%"></farm-skeleton>
        </slot>
      </div>
      ${this.error
        ? html`<div class="error">
            <span title=${this.error}>${this.error}</span
            ><button
              @click=${() =>
                this.dispatchEvent(new CustomEvent('retry', { bubbles: true, composed: true }))}
            >
              Retry
            </button>
          </div>`
        : nothing}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'farm-hydrating': FarmHydrating;
  }
}
