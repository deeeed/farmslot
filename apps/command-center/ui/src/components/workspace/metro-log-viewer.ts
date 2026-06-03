import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

const MAX_VISIBLE_LINES = 1000;

@customElement('metro-log-viewer')
export class MetroLogViewer extends LitElement {
  @property({ attribute: false }) lines: string[] = [];

  @state() private autoScroll = true;
  @state() private filter = '';

  private _scrollContainer: HTMLElement | null = null;
  private _userScrolled = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: ${unsafeCSS(colors.bgBase)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.xl)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .title {
      font-size: ${unsafeCSS(fonts.sizeLg)};
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .line-count {
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .filter-input {
      margin-left: auto;
      padding: 2px ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgInput)};
      border: 1px solid #1e1e36;
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      width: 140px;
      outline: none;
    }
    .filter-input::placeholder {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .filter-input:focus {
      border-color: ${unsafeCSS(colors.accent)}66;
    }

    .header-btn {
      padding: 2px ${unsafeCSS(spacing.md)};
      border-radius: ${unsafeCSS(radii.sm)};
      border: 1px solid #1e1e36;
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
      transition: background 0.1s;
    }
    .header-btn:hover {
      background: rgba(99, 102, 241, 0.1);
    }
    .header-btn.active {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}44;
    }

    .log-body {
      flex: 1;
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.xl)};
    }

    .log-body::-webkit-scrollbar {
      width: 6px;
    }
    .log-body::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .log-line {
      line-height: 18px;
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .log-line.error {
      color: #ff4444;
    }
    .log-line.warn {
      color: #ffcc00;
    }

    .timestamp {
      color: ${unsafeCSS(colors.textMuted)};
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('lines') && this.autoScroll) {
      this._scrollToBottom();
    }
  }

  private _getScrollContainer(): HTMLElement | null {
    if (!this._scrollContainer) {
      this._scrollContainer = this.renderRoot.querySelector('.log-body');
    }
    return this._scrollContainer;
  }

  private _scrollToBottom() {
    requestAnimationFrame(() => {
      const el = this._getScrollContainer();
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  private _onScroll(e: Event) {
    const el = e.target as HTMLElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (atBottom && !this.autoScroll) {
      this.autoScroll = true;
    } else if (!atBottom && this.autoScroll) {
      this.autoScroll = false;
    }
  }

  private _toggleAutoScroll() {
    this.autoScroll = !this.autoScroll;
    if (this.autoScroll) {
      this._scrollToBottom();
    }
  }

  private _onFilterInput(e: Event) {
    this.filter = (e.target as HTMLInputElement).value;
  }

  private _clear() {
    this.dispatchEvent(
      new CustomEvent('metro-clear', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _classifyLine(line: string): 'error' | 'warn' | '' {
    const lower = line.toLowerCase();
    if (lower.includes('error')) return 'error';
    if (lower.includes('warn')) return 'warn';
    return '';
  }

  private _renderLine(line: string) {
    const cls = this._classifyLine(line);
    // Extract timestamp prefix like [HH:MM:SS]
    const tsMatch = line.match(/^(\[\d{1,2}:\d{2}:\d{2}\])\s?/);
    if (tsMatch) {
      const ts = tsMatch[1];
      const rest = line.slice(tsMatch[0].length);
      return html`<div class="log-line ${cls}"><span class="timestamp">${ts}</span> ${rest}</div>`;
    }
    return html`<div class="log-line ${cls}">${line}</div>`;
  }

  private _getVisibleLines(): string[] {
    let filtered = this.lines;
    if (this.filter) {
      const lower = this.filter.toLowerCase();
      filtered = filtered.filter((l) => l.toLowerCase().includes(lower));
    }
    return filtered.slice(-MAX_VISIBLE_LINES);
  }

  render() {
    const visible = this._getVisibleLines();

    return html`
      <div class="header">
        <span class="title">Metro</span>
        <span class="line-count">${visible.length} line${visible.length !== 1 ? 's' : ''}</span>
        <input
          class="filter-input"
          type="text"
          placeholder="Filter..."
          .value=${this.filter}
          @input=${this._onFilterInput}
        />
        <button
          class="header-btn ${this.autoScroll ? 'active' : ''}"
          @click=${this._toggleAutoScroll}
          title="Auto-scroll to bottom"
        >
          Scroll
        </button>
        <button class="header-btn" @click=${this._clear} title="Clear log">Clear</button>
      </div>
      ${visible.length === 0
        ? html`<div class="empty-state">No log output</div>`
        : html`
            <div class="log-body" @scroll=${this._onScroll}>
              ${visible.map((l) => this._renderLine(l))}
            </div>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'metro-log-viewer': MetroLogViewer;
  }
}
