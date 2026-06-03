import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { Diagnostic } from '@farmslot/protocol';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('problems-panel')
export class ProblemsPanel extends LitElement {
  @property({ type: Array }) diagnostics: Diagnostic[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) truncated = false;

  @state() private _sourceFilter: string | null = null; // null = all

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .counts {
      display: flex;
      gap: 8px;
      font-size: 10px;
    }

    .error-count {
      color: ${unsafeCSS(colors.statusFail)};
    }

    .warn-count {
      color: ${unsafeCSS(colors.statusWarn)};
    }

    .refresh-btn {
      margin-left: auto;
      background: none;
      border: none;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font-size: 12px;
      padding: 2px 4px;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .refresh-btn:hover {
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .refresh-btn:disabled {
      opacity: 0.4;
      cursor: wait;
    }

    .filter-bar {
      display: flex;
      gap: 4px;
      padding: 3px 8px;
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .filter-pill {
      background: none;
      border: 1px solid #2a2a44;
      border-radius: 9px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      font-family: ${unsafeCSS(fonts.mono)};
      padding: 1px 8px;
      cursor: pointer;
    }
    .filter-pill:hover {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .filter-pill.active {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }

    .content {
      flex: 1;
      overflow-y: auto;
    }
    .content::-webkit-scrollbar {
      width: 6px;
    }
    .content::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 3px;
    }

    .empty {
      padding: ${unsafeCSS(spacing.lg)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .loading {
      padding: ${unsafeCSS(spacing.lg)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .diag-row {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 8px;
      cursor: pointer;
      line-height: 1.5;
    }
    .diag-row:hover {
      background: rgba(99, 102, 241, 0.06);
    }

    .severity {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 5px;
    }
    .severity.error {
      background: ${unsafeCSS(colors.statusFail)};
    }
    .severity.warning {
      background: ${unsafeCSS(colors.statusWarn)};
    }

    .file-loc {
      color: ${unsafeCSS(colors.textSecondary)};
      white-space: nowrap;
      flex-shrink: 0;
    }

    .message {
      color: ${unsafeCSS(colors.textPrimary)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .code {
      color: ${unsafeCSS(colors.textMuted)};
      flex-shrink: 0;
    }

    .source-badge {
      font-size: 9px;
      padding: 0 4px;
      border-radius: 3px;
      background: ${unsafeCSS(colors.accent)}15;
      color: ${unsafeCSS(colors.textMuted)};
      flex-shrink: 0;
    }

    .truncated {
      padding: 4px 8px;
      color: ${unsafeCSS(colors.statusWarn)};
      font-size: 10px;
    }
  `;

  private _handleClick(d: Diagnostic) {
    this.dispatchEvent(
      new CustomEvent('diagnostic-navigate', {
        detail: { path: d.file, line: d.line },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleRefresh() {
    this.dispatchEvent(
      new CustomEvent('diagnostics-refresh', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private get _sources(): string[] {
    const set = new Set<string>();
    for (const d of this.diagnostics) {
      if (d.source) set.add(d.source);
    }
    return [...set].sort();
  }

  private get _filtered(): Diagnostic[] {
    if (!this._sourceFilter) return this.diagnostics;
    return this.diagnostics.filter((d) => d.source === this._sourceFilter);
  }

  render() {
    const filtered = this._filtered;
    const errors = filtered.filter((d) => d.severity === 'error').length;
    const warnings = filtered.filter((d) => d.severity === 'warning').length;
    const sources = this._sources;
    const showFilters = sources.length > 1;

    return html`
      <div class="header">
        <div class="counts">
          <span class="error-count">${errors} error${errors !== 1 ? 's' : ''}</span>
          <span class="warn-count">${warnings} warning${warnings !== 1 ? 's' : ''}</span>
        </div>
        <button class="refresh-btn" ?disabled=${this.loading} @click=${this._handleRefresh}>
          ${this.loading ? 'Checking...' : '\u21BB Run'}
        </button>
      </div>
      ${showFilters
        ? html`
            <div class="filter-bar">
              <button
                class="filter-pill ${this._sourceFilter === null ? 'active' : ''}"
                @click=${() => {
                  this._sourceFilter = null;
                }}
              >
                All
              </button>
              ${sources.map(
                (s) => html`
                  <button
                    class="filter-pill ${this._sourceFilter === s ? 'active' : ''}"
                    @click=${() => {
                      this._sourceFilter = s;
                    }}
                  >
                    ${s}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
      <div class="content">
        ${this.loading ? html`<div class="loading">Running diagnostics...</div>` : ''}
        ${!this.loading && filtered.length === 0
          ? html` <div class="empty">No problems found. Click ↻ to run diagnostics.</div> `
          : ''}
        ${filtered.map(
          (d) => html`
            <div class="diag-row" @click=${() => this._handleClick(d)}>
              <span class="severity ${d.severity}"></span>
              <span class="file-loc">${this._shortPath(d.file)}:${d.line}</span>
              <span class="message">${d.message}</span>
              ${d.source && showFilters
                ? html`<span class="source-badge">${d.source}</span>`
                : nothing}
              <span class="code">${d.code || ''}</span>
            </div>
          `,
        )}
        ${this.truncated
          ? html`<div class="truncated">Output truncated (500+ diagnostics)</div>`
          : ''}
      </div>
    `;
  }

  private _shortPath(filePath: string): string {
    // Show last 2 path segments for brevity
    const parts = filePath.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'problems-panel': ProblemsPanel;
  }
}
