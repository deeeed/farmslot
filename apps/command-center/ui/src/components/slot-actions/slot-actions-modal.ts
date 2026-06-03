// slot-actions-modal.ts — Modal wrapper around <slot-actions-panel>.
// Opened from fleet-view (slot-card "···" menu) so users can trigger
// lifecycle actions on any slot without navigating away from the fleet
// overview. Backdrop click + ESC dismiss.

import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import './slot-actions-panel.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

@customElement('slot-actions-modal')
export class SlotActionsModal extends LitElement {
  @property({ attribute: 'slot-id' }) slotId = '';
  @property({ type: Boolean }) open = false;

  static override styles = css`
    .sam-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 60px 16px 16px;
      z-index: 1000;
    }
    .sam-panel {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      width: min(960px, 100%);
      max-height: calc(100vh - 80px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .sam-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid #2a2a44;
    }
    .sam-title {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }
    .sam-close {
      background: transparent;
      border: 1px solid #2a2a44;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 4px 10px;
      border-radius: ${unsafeCSS(radii.sm)};
      cursor: pointer;
    }
    .sam-close:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .sam-body {
      overflow-y: auto;
      flex: 1;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onKeydown);
  }

  private _onKeydown = (e: KeyboardEvent) => {
    if (this.open && e.key === 'Escape') this._close();
  };

  private _close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  override render() {
    if (!this.open || !this.slotId) return null;
    return html`
      <div
        class="sam-backdrop"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this._close();
        }}
      >
        <div class="sam-panel">
          <div class="sam-header">
            <span class="sam-title">${this.slotId}</span>
            <button class="sam-close" @click=${this._close}>Close (Esc)</button>
          </div>
          <div class="sam-body">
            <slot-actions-panel slot-id=${this.slotId}></slot-actions-panel>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-actions-modal': SlotActionsModal;
  }
}
