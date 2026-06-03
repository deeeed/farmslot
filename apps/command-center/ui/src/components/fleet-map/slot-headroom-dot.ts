import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

const HEADROOM_COLORS: Record<string, string> = {
  green: '#00ff88',
  yellow: '#ffcc00',
  red: '#ff4444',
};

@customElement('slot-headroom-dot')
export class SlotHeadroomDot extends LitElement {
  @property() headroom?: string;

  static styles = css`
    :host {
      display: inline-block;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
    }
  `;

  render() {
    if (!this.headroom) return nothing;
    const color = HEADROOM_COLORS[this.headroom] ?? '#666';
    return html`<span
      class="dot"
      style="background:${color};"
      title="host: ${this.headroom}"
    ></span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-headroom-dot': SlotHeadroomDot;
  }
}
