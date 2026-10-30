import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { sourceObservationAge } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { notificationTray } from '../../utils/notification-tray.js';
import type { TrayItem } from '../../utils/notification-tray-model.js';
import {
  ATTENTION_PREFERENCES_CHANGED,
  getAttentionAlertPreferences,
} from '../../utils/notifications.js';

@customElement('farm-notification-tray')
export class NotificationTray extends LitElement {
  @state() private items: TrayItem[] = [];
  @state() private open = false;
  @state() private updateOpen = false;
  private stop?: () => void;
  private ageTimer?: ReturnType<typeof setInterval>;
  private readonly refresh = () => this.requestUpdate();
  private readonly onEscape = (event: KeyboardEvent) => {
    if (this.open && event.key === 'Escape') this.close();
  };
  private readonly outside = (event: Event) => {
    if (!event.composedPath().includes(this)) this.close(false);
  };
  connectedCallback() {
    super.connectedCallback();
    this.stop = notificationTray.subscribe(() => {
      this.items = notificationTray.items;
      if (!this.items.some((item) => item.view === 'update')) this.updateOpen = false;
      this.syncClock();
    });
    this.items = notificationTray.items;
    window.addEventListener(ATTENTION_PREFERENCES_CHANGED, this.refresh);
    window.addEventListener('storage', this.refresh);
    window.addEventListener('keydown', this.onEscape);
    document.addEventListener('pointerdown', this.outside);
  }
  disconnectedCallback() {
    this.stop?.();
    clearInterval(this.ageTimer);
    this.ageTimer = undefined;
    window.removeEventListener(ATTENTION_PREFERENCES_CHANGED, this.refresh);
    window.removeEventListener('storage', this.refresh);
    window.removeEventListener('keydown', this.onEscape);
    document.removeEventListener('pointerdown', this.outside);
    super.disconnectedCallback();
  }
  private syncClock() {
    const needed = this.open && this.items.some((item) => item.observedAt !== undefined);
    if (needed && !this.ageTimer) this.ageTimer = setInterval(this.refresh, 1000);
    if (!needed) {
      clearInterval(this.ageTimer);
      this.ageTimer = undefined;
    }
  }
  private close(focus = true) {
    this.open = false;
    this.updateOpen = false;
    this.syncClock();
    if (focus) this.renderRoot.querySelector<HTMLButtonElement>('.bell')?.focus();
  }
  private async toggle() {
    if (this.open) {
      this.close();
      return;
    }
    this.open = true;
    this.syncClock();
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLButtonElement>('.close')?.focus();
  }
  static styles = css`
    :host {
      display: block;
      flex: none;
      position: relative;
      height: 44px;
      min-height: 44px;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .strip {
      height: 44px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 12px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCardHover)};
      background: ${unsafeCSS(colors.bgCard)};
    }
    .attention {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .attention a {
      display: block;
      min-height: 44px;
      line-height: 44px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    button,
    a {
      font: inherit;
      color: inherit;
    }
    button {
      min-height: 44px;
      min-width: 44px;
      border: 0;
      background: transparent;
      cursor: pointer;
    }
    .bell {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      margin-left: auto;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .panel {
      position: fixed;
      top: 44px;
      right: 8px;
      z-index: 300;
      box-sizing: border-box;
      width: min(420px, calc(100vw - 16px));
      height: min(480px, 70vh);
      overflow: auto;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 6px;
      box-shadow: 0 8px 24px #0008;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      min-height: 44px;
    }
    .item {
      border-top: 1px solid ${unsafeCSS(colors.bgCardHover)};
    }
    .item a {
      display: block;
      padding: 12px;
      text-decoration: none;
      min-height: 44px;
      box-sizing: border-box;
    }
    .item a:hover,
    .item a:focus-visible {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .retry {
      margin: 0 12px;
    }
    strong {
      display: block;
      font-size: 12px;
    }
    p {
      margin: 4px 0 0;
      overflow-wrap: anywhere;
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .empty {
      padding: 16px;
      color: ${unsafeCSS(colors.textMuted)};
    }
  `;
  private openItem(event: MouseEvent, item: TrayItem) {
    if (item.view === 'update') {
      event.preventDefault();
      this.updateOpen = !this.updateOpen;
    } else this.close(false);
  }
  render() {
    const top = getAttentionAlertPreferences().attentionEnabled
      ? this.items.find((item) => item.needsYou && item.current)
      : undefined;
    return html`
      <div class="strip" data-testid="notification-strip">
        ${top
          ? html`<span class="attention" role="status"
              ><a href=${top.route} title=${top.body}>${top.title}</a></span
            >`
          : nothing}
        <button
          class="bell"
          aria-label="Notifications (${this.items.length})"
          aria-expanded=${this.open}
          aria-controls="notification-panel"
          @click=${() => void this.toggle()}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
          </svg>
          ${this.items.length}
        </button>
      </div>
      ${this.open
        ? html`<section
            class="panel"
            id="notification-panel"
            aria-label="Notifications"
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                this.close();
              }
            }}
          >
            <header>
              <strong>Notifications</strong
              ><button class="close" aria-label="Close notifications" @click=${() => this.close()}>
                ×
              </button>
            </header>
            ${this.items.length
              ? this.items.map(
                  (item) =>
                    html`<div class="item" data-notice-id=${item.id}>
                      <a
                        href=${item.route}
                        @click=${(event: MouseEvent) => this.openItem(event, item)}
                      >
                        <strong>${item.title}</strong>
                        <p>
                          ${item.observedAt !== undefined
                            ? `${sourceObservationAge(item.observedAt)} · `
                            : ''}${item.body}
                        </p>
                      </a>
                      ${item.retry
                        ? html`<button class="retry" @click=${item.retry}>Retry</button>`
                        : nothing}
                    </div>`,
                )
              : html`<div class="empty">No open notifications</div>`}
            ${this.updateOpen ? html`<slot name="update"></slot>` : nothing}
          </section>`
        : nothing}
    `;
  }
}
