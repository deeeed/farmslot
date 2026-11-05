import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement } from 'lit/decorators.js';

import { gatewayOfflineLabel } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';

@customElement('gateway-connection-indicator')
export class GatewayConnectionIndicator extends LitElement {
  private stop?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.stop = gateway.onConnectionChange(() => this.requestUpdate());
  }
  disconnectedCallback() {
    this.stop?.();
    super.disconnectedCallback();
  }
  static styles = css`
    :host {
      position: fixed;
      top: 8px;
      right: 16px;
      z-index: 1200;
      pointer-events: none;
    }
    span {
      display: block;
      padding: 5px 9px;
      border-radius: 6px;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.statusWarn)};
      font:
        11px/16px system-ui,
        sans-serif;
    }
  `;
  render() {
    const label = gatewayOfflineLabel(gateway.connectionState, gateway.recoveryEnabled);
    return label
      ? html`<span
          role="status"
          aria-live="polite"
          title="Showing saved data. The gateway will reconnect automatically."
          >${label}</span
        >`
      : nothing;
  }
}
