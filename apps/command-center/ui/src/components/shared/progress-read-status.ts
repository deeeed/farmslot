import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii } from '../../styles/theme-tokens.js';
import type { ProgressReadNotice } from '../../utils/progress-read-status.js';

import { ReadNoticeDelay } from './read-notice-delay.js';

/** Shared read notice and retry control; an absent notice occupies no space. */
@customElement('progress-read-status')
export class ProgressReadStatus extends LitElement {
  @property({ attribute: false }) notice?: ProgressReadNotice;
  @property({ attribute: false }) retry?: () => void;
  @property({ type: Boolean }) connected = true;
  @property({ type: Boolean }) delayRefresh = false;
  @property() scopeKey = '';
  private readonly delayed = new ReadNoticeDelay(() => this.requestUpdate());

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('scopeKey')) this.delayed.clear();
    if (changed.has('notice') || changed.has('delayRefresh') || changed.has('scopeKey'))
      this.delayed.update(this.delayRefresh ? this.notice : undefined);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.delayed.update(this.delayRefresh ? this.notice : undefined);
  }

  disconnectedCallback(): void {
    this.delayed.clear();
    super.disconnectedCallback();
  }

  static styles = css`
    :host {
      display: block;
      flex: none;
      min-width: 0;
    }
    .row {
      min-height: 28px;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 0 8px;
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: ${unsafeCSS(radii.sm)};
      box-sizing: border-box;
    }
    span {
      color: ${unsafeCSS(colors.textSecondary)};
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
    const notice = this.delayRefresh ? this.delayed.visible : this.notice;
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
