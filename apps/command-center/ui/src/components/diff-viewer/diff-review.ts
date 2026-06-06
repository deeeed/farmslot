import { html as diff2html } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib-esm/types';
import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import 'diff2html/bundles/css/diff2html.min.css';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { adoptDocumentCss } from '../../utils/shadow-css.js';

type ViewMode = 'side-by-side' | 'line-by-line';

@customElement('diff-review')
export class DiffReview extends LitElement {
  @property() diff = '';
  @property() filename = '';
  @state() private _viewMode: ViewMode = 'side-by-side';

  protected override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    adoptDocumentCss(
      this,
      (href, text) => href.includes('diff2html') || text.includes('.d2h-'),
      'diff2html',
    );
  }

  private _renderDiff(): string {
    if (!this.diff) return '<div class="dr-empty">No diff to display</div>';
    return diff2html(this.diff, {
      outputFormat: this._viewMode === 'side-by-side' ? 'side-by-side' : 'line-by-line',
      drawFileList: false,
      matching: 'lines',
      colorScheme: ColorSchemeType.DARK,
    });
  }

  override render() {
    const diffHtml = this._renderDiff();
    return html`
      <style>
        diff-review {
          display: flex;
          flex-direction: column;
          height: 100%;
          font-family: ${fonts.mono};
        }
        .dr-header {
          display: flex;
          align-items: center;
          gap: ${spacing.md};
          padding: ${spacing.sm} ${spacing.md};
          background: ${colors.bgCard};
          border-radius: ${radii.md} ${radii.md} 0 0;
          min-height: 32px;
          box-sizing: border-box;
          flex-shrink: 0;
        }
        .dr-filename {
          color: ${colors.textPrimary};
          font-size: ${fonts.sizeSm};
          font-weight: 600;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dr-toggle {
          display: flex;
          gap: 1px;
        }
        .dr-toggle-btn {
          padding: 3px 10px;
          border: 1px solid ${colors.textMuted};
          background: transparent;
          color: ${colors.textSecondary};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          cursor: pointer;
        }
        .dr-toggle-btn:first-child {
          border-radius: ${radii.sm} 0 0 ${radii.sm};
        }
        .dr-toggle-btn:last-child {
          border-radius: 0 ${radii.sm} ${radii.sm} 0;
        }
        .dr-toggle-btn.active {
          background: ${colors.accent};
          color: #fff;
          border-color: ${colors.accent};
        }
        .dr-body {
          flex: 1;
          overflow: auto;
          border-radius: 0 0 ${radii.md} ${radii.md};
          background: ${colors.bgSurface};
          min-width: 0;
          position: relative;
          contain: layout paint;
        }
        .dr-body::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .dr-body::-webkit-scrollbar-thumb {
          background: ${colors.textMuted};
          border-radius: 3px;
        }
        .dr-empty {
          padding: ${spacing.xl};
          color: ${colors.textMuted};
          text-align: center;
          font-size: ${fonts.sizeSm};
        }

        /* === diff2html dark theme — minimal overrides === */

        /* Hide diff2html's own file header (we have dr-header) */
        .d2h-file-header {
          display: none !important;
        }

        /* Container */
        .d2h-wrapper {
          font-family: ${fonts.mono} !important;
        }
        .d2h-file-wrapper {
          border: none !important;
          margin: 0 !important;
        }

        /* Dark backgrounds */
        .d2h-file-diff,
        .d2h-code-wrapper,
        .d2h-file-side-diff {
          background: ${colors.bgSurface} !important;
        }

        /* Code text */
        .d2h-code-line,
        .d2h-code-side-line,
        .d2h-code-line-ctn {
          font-family: ${fonts.mono} !important;
          font-size: 12px !important;
          color: ${colors.textPrimary} !important;
        }

        /* Line numbers */
        .d2h-code-linenumber,
        .d2h-code-side-linenumber {
          background: ${colors.bgCard} !important;
          color: ${colors.textMuted} !important;
          border-color: #1e1e36 !important;
          box-sizing: border-box !important;
          display: table-cell !important;
          min-width: 54px !important;
          overflow: visible !important;
          position: static !important;
          text-align: right !important;
          vertical-align: top !important;
          width: auto !important;
          white-space: nowrap !important;
        }
        .d2h-code-line,
        .d2h-code-side-line {
          box-sizing: border-box !important;
          padding-left: 8px !important;
        }
        .d2h-code-line-ctn {
          white-space: pre !important;
        }
        .d2h-diff-table {
          table-layout: auto !important;
        }

        /* Deletions */
        .d2h-del {
          background: rgba(248, 81, 73, 0.1) !important;
          border-color: rgba(248, 81, 73, 0.2) !important;
        }
        .d2h-del .d2h-code-line-ctn {
          color: #ffa0a0 !important;
        }

        /* Insertions */
        .d2h-ins {
          background: rgba(63, 185, 80, 0.1) !important;
          border-color: rgba(63, 185, 80, 0.2) !important;
        }
        .d2h-ins .d2h-code-line-ctn {
          color: #7ee787 !important;
        }

        /* Word-level highlights */
        del.d2h-change {
          background: rgba(248, 81, 73, 0.3) !important;
          color: #ffd7d5 !important;
          text-decoration: none !important;
        }
        ins.d2h-change {
          background: rgba(63, 185, 80, 0.3) !important;
          color: #aff5b4 !important;
          text-decoration: none !important;
        }

        /* Chunk headers (@@ ... @@) */
        .d2h-info {
          background: ${colors.bgCard} !important;
          color: ${colors.accent} !important;
          border-color: #1e1e36 !important;
        }

        /* Empty placeholders (side-by-side) */
        .d2h-code-side-emptyplaceholder,
        .d2h-emptyplaceholder {
          background: ${colors.bgBase} !important;
          border-color: #1e1e36 !important;
        }

        /* Table cell borders */
        .d2h-diff-tbody tr td {
          border-color: #1e1e36 !important;
        }
      </style>
      <div class="dr-header">
        <span class="dr-filename">${this.filename || 'diff'}</span>
        <div class="dr-toggle">
          <button
            class="dr-toggle-btn ${this._viewMode === 'side-by-side' ? 'active' : ''}"
            @click=${() => {
              this._viewMode = 'side-by-side';
            }}
          >
            Split
          </button>
          <button
            class="dr-toggle-btn ${this._viewMode === 'line-by-line' ? 'active' : ''}"
            @click=${() => {
              this._viewMode = 'line-by-line';
            }}
          >
            Unified
          </button>
        </div>
      </div>
      <div class="dr-body">${unsafeHTML(diffHtml)}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'diff-review': DiffReview;
  }
}
