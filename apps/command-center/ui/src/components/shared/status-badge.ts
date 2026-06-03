import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii } from '../../styles/theme-tokens.js';
import { statusColor } from '../../styles/theme-tokens.js';

@customElement('status-badge')
export class StatusBadge extends LitElement {
  @property() label = '';
  @property() status: 'ok' | 'warn' | 'fail' | 'unknown' = 'unknown';
  @property() size: 'sm' | 'md' = 'sm';

  static styles = css`
    :host {
      display: inline-flex;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      white-space: nowrap;
      line-height: 1;
    }
    .badge.sm {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 2px 5px;
    }
    .badge.md {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: 3px 7px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  `;

  render() {
    const c = statusColor(this.status);
    return html`
      <span
        class="badge ${this.size}"
        style="background: ${c}18; color: ${c}; border: 1px solid ${c}44;"
      >
        <span class="dot" style="background: ${c};"></span>
        ${this.label}
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'status-badge': StatusBadge;
  }
}
