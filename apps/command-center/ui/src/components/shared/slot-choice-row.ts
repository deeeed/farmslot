import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, lifecycleColor } from '../../styles/theme-tokens.js';

function agentStateColor(state: string): string {
  if (state === 'working') return colors.lifecycleBusy;
  if (state === 'idle') return colors.statusOk;
  if (state === 'no-tmux') return colors.statusFail;
  return colors.statusUnknown;
}

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
      display: grid;
      align-items: center;
      gap: 10px;
      grid-template-columns: 44px 132px minmax(0, 1fr) var(--slot-choice-meta-width, 200px);
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
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
    }

    .candidate-row.selected .cand-rank {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 600;
    }

    .cand-id {
      align-items: flex-start;
      color: ${unsafeCSS(colors.textPrimary)};
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
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
      display: grid;
      flex: 0 0 auto;
      align-self: flex-start;
      align-items: center;
      gap: 8px;
      grid-template-columns: minmax(66px, auto) minmax(46px, auto) minmax(0, 1fr);
      justify-self: end;
      width: 100%;
      padding-top: 1px;
    }

    .cand-lifecycle {
      color: var(--pill-color, ${unsafeCSS(colors.textMuted)});
      font-size: 10px;
    }

    .cand-score {
      color: var(--pill-color, ${unsafeCSS(colors.textMuted)});
      font-size: 10px;
      text-align: right;
    }

    .state-pill {
      background: color-mix(in srgb, var(--pill-color) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--pill-color) 45%, transparent);
      border-radius: 999px;
      line-height: 1.2;
      padding: 2px 6px;
      white-space: nowrap;
    }
  `;

  render() {
    const lifecycle = lifecycleColor(this.lifecycle);
    const agent = agentStateColor(this.score);
    return html`
      <button
        class="candidate-row ${this.selected ? 'selected' : ''} ${this.warning ? 'warning' : ''}"
        type="button"
        ?disabled=${this.disabled}
        part="button"
      >
        <span class="cand-rank">${this.rank}</span>
        <span class="cand-id">
          <span>${this.slotId}</span>
          <span class="badges"><slot name="badges"></slot></span>
        </span>
        <span class="cand-summary">
          <span class="cand-branch ${this.stale ? 'stale' : ''}">${this.branch}</span>
          ${this.task ? html`<span class="cand-task">${this.task}</span>` : nothing}
          <span class="summary-extra"><slot name="summary-extra"></slot></span>
        </span>
        <span class="cand-meta">
          <span class="cand-lifecycle state-pill" style=${`--pill-color:${lifecycle}`}
            >${this.lifecycle}</span
          >
          ${this.score
            ? html`<span class="cand-score state-pill" style=${`--pill-color:${agent}`}
                >${this.score}</span
              >`
            : nothing}
          <slot name="actions"></slot>
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
