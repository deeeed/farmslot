import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii } from '../../styles/theme-tokens.js';
import type { ProgressReadNotice } from '../../utils/progress-read-status.js';

/** One shared status row and retry control; every state occupies the same height. */
@customElement('progress-read-status')
export class ProgressReadStatus extends LitElement {
  @property({ attribute: false }) notice?: ProgressReadNotice;
  @property({ attribute: false }) retry?: () => void;
  @property({ type: Boolean }) connected = true;
  static styles = css`
    :host {
      display: block;
      height: 28px;
      min-height: 28px;
      flex: 0 0 28px;
      min-width: 0;
    }
    .row {
      height: 100%;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 0 8px;
      box-sizing: border-box;
    }
    span {
      color: ${unsafeCSS(colors.textMuted)};
      font: 11px ${unsafeCSS(fonts.mono)};
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    button {
      min-height: 24px;
      appearance: none;
      font: 11px ${unsafeCSS(fonts.mono)};
      color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid ${unsafeCSS(colors.accent)}66;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 2px 8px;
      cursor: pointer;
    }
    button:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    button:focus-visible {
      outline: 2px solid ${unsafeCSS(colors.accent)};
      outline-offset: 1px;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `;
  render() {
    const notice = this.notice;
    if (!notice) return nothing;
    return html`<div class="row">
      <span role=${notice.kind === 'error' ? 'alert' : 'status'} title=${notice.detail ?? ''}
        >${notice.text}</span
      >
      ${notice.kind === 'error' && this.retry
        ? html`<button
            type="button"
            ?disabled=${!this.connected}
            @click=${(event: Event) => {
              event.stopPropagation();
              this.retry?.();
            }}
          >
            Retry
          </button>`
        : nothing}
    </div>`;
  }
}
