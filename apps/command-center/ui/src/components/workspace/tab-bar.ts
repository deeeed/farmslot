import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export interface TabInfo {
  path: string;
  type: 'file' | 'diff';
  pinned: boolean;
}

function basename(path: string): string {
  // Handle branch diff cache keys like "branch:main:path/to/file.ts"
  const resolved = path.startsWith('branch:') ? path.substring(path.indexOf(':', 7) + 1) : path;
  const parts = resolved.split('/');
  return parts[parts.length - 1];
}

@customElement('tab-bar')
export class TabBar extends LitElement {
  @property({ attribute: false }) tabs: TabInfo[] = [];
  @property() activeTab = '';

  static styles = css`
    :host {
      display: flex;
      align-items: stretch;
      height: 30px;
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      overflow-x: auto;
      overflow-y: hidden;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }

    :host::-webkit-scrollbar {
      height: 2px;
    }
    :host::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 1px;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      padding: 0 ${unsafeCSS(spacing.lg)};
      cursor: pointer;
      white-space: nowrap;
      color: ${unsafeCSS(colors.textSecondary)};
      border-bottom: 2px solid transparent;
      transition:
        color 0.1s,
        border-color 0.1s;
      flex-shrink: 0;
    }

    .tab:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      background: rgba(99, 102, 241, 0.05);
    }

    .tab.active {
      color: ${unsafeCSS(colors.textPrimary)};
      border-bottom-color: ${unsafeCSS(colors.accent)};
    }

    .tab.preview .tab-name {
      font-style: italic;
    }

    .diff-indicator {
      font-size: 9px;
      padding: 0 3px;
      border-radius: 3px;
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      font-weight: 700;
    }

    .close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: ${unsafeCSS(radii.sm)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      opacity: 0;
      transition:
        opacity 0.1s,
        background 0.1s;
    }

    .tab:hover .close {
      opacity: 1;
    }

    .close:hover {
      background: rgba(255, 68, 68, 0.2);
      color: ${unsafeCSS(colors.statusFail)};
    }
  `;

  private _select(path: string) {
    this.dispatchEvent(
      new CustomEvent('tab-select', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _pin(path: string) {
    this.dispatchEvent(
      new CustomEvent('tab-pin', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _close(path: string, e: Event) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('tab-close', {
        detail: { path },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      ${this.tabs.map(
        (tab) => html`
          <div
            class="tab ${this.activeTab === tab.path ? 'active' : ''} ${!tab.pinned
              ? 'preview'
              : ''}"
            @click=${() => this._select(tab.path)}
            @dblclick=${() => this._pin(tab.path)}
          >
            ${tab.type === 'diff' ? html`<span class="diff-indicator">D</span>` : nothing}
            <span class="tab-name">${basename(tab.path)}</span>
            <span class="close" @click=${(e: Event) => this._close(tab.path, e)}>x</span>
          </div>
        `,
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tab-bar': TabBar;
  }
}
