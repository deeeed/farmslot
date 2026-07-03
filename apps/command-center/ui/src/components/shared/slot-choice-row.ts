import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts } from '../../styles/theme-tokens.js';

@customElement('slot-choice-row')
export class SlotChoiceRow extends LitElement {
  @property({ type: String }) rank = '';
  @property({ type: String }) slotId = '';
  @property({ type: String }) branch = '';
  @property({ type: String }) task = '';
  @property({ type: String }) lifecycle = '';
  @property({ type: String }) score = '';
  @property({ type: Boolean }) selected = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) stale = false;
  @property({ type: Boolean }) warning = false;

  static styles = css`
    :host {
      display: block;
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .candidate-row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #2a2a44;
      border-radius: 3px;
      color: ${unsafeCSS(colors.textSecondary)};
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      text-align: left;
      transition:
        border-color 0.12s,
        background 0.12s;
    }

    .candidate-row:hover {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .candidate-row:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .candidate-row:disabled:hover {
      border-color: #2a2a44;
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .candidate-row.selected {
      border-color: ${unsafeCSS(colors.accent)};
      background: ${unsafeCSS(colors.accent)}10;
    }

    .candidate-row.warning {
      border-color: ${unsafeCSS(colors.statusWarn)}55;
      background: ${unsafeCSS(colors.statusWarn)}0a;
    }

    .candidate-row.warning.selected {
      border-color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}1a;
    }

    .cand-rank {
      width: 28px;
      color: ${unsafeCSS(colors.textMuted)};
      flex: 0 0 auto;
      font-size: 10px;
    }

    .candidate-row.selected .cand-rank {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 600;
    }

    .cand-id {
      width: 132px;
      color: ${unsafeCSS(colors.textPrimary)};
      flex: 0 0 auto;
      overflow-wrap: anywhere;
    }

    .badges {
      display: contents;
    }

    .cand-summary {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
      gap: 2px;
      align-items: flex-start;
    }

    .cand-branch {
      width: 100%;
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: normal;
      word-break: break-word;
    }

    .cand-branch.stale {
      color: ${unsafeCSS(colors.statusWarn)};
    }

    .cand-task {
      width: 100%;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      line-height: 1.3;
      overflow-wrap: anywhere;
      white-space: normal;
      word-break: break-word;
    }

    .summary-extra {
      display: block;
      width: 100%;
    }

    .cand-meta {
      display: flex;
      flex: 0 0 auto;
      align-self: flex-start;
      align-items: center;
      gap: 8px;
      padding-top: 1px;
    }

    .cand-lifecycle {
      width: 68px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }

    .cand-score {
      width: 22px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      text-align: right;
    }
  `;

  render() {
    return html`
      <button
        class="candidate-row ${this.selected ? 'selected' : ''} ${this.warning ? 'warning' : ''}"
        type="button"
        ?disabled=${this.disabled}
        part="button"
      >
        <span class="cand-rank">${this.rank}</span>
        <span class="cand-id">${this.slotId}</span>
        <span class="badges"><slot name="badges"></slot></span>
        <span class="cand-summary">
          <span class="cand-branch ${this.stale ? 'stale' : ''}">${this.branch}</span>
          ${this.task ? html`<span class="cand-task">${this.task}</span>` : nothing}
          <span class="summary-extra"><slot name="summary-extra"></slot></span>
        </span>
        <span class="cand-meta">
          <slot name="meta">
            <span class="cand-lifecycle">${this.lifecycle}</span>
            <span class="cand-score">${this.score}</span>
          </slot>
        </span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-choice-row': SlotChoiceRow;
  }
}
