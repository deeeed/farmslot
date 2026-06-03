import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export type SemanticValue = 'good' | 'ok' | 'bad' | '';

export function isSemanticChoice(v: SemanticValue): v is Exclude<SemanticValue, ''> {
  return v === 'good' || v === 'ok' || v === 'bad';
}

export interface SemanticPickerDetail {
  value: SemanticValue;
  reasoning: string;
}

@customElement('grade-semantic-picker')
export class GradeSemanticPicker extends LitElement {
  @property() value: SemanticValue = '';
  @property() reasoning = '';
  @property({ type: Boolean }) disabled = false;
  @property() reasoningPlaceholder = 'Reasoning…';
  @property({ type: Array }) hints: string[] = [];
  @property({ type: Boolean, attribute: 'show-reasoning' }) showReasoning = true;

  static styles = css`
    :host {
      display: block;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .semantic-row {
      display: flex;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .semantic-btn {
      flex: 1;
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)};
      border-radius: ${unsafeCSS(radii.sm)};
      border: 2px solid transparent;
      background: ${unsafeCSS(colors.bgSurface)};
      color: ${unsafeCSS(colors.textMuted)};
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition:
        border-color 0.15s,
        background 0.15s,
        color 0.15s;
      text-align: center;
    }
    .semantic-btn:hover {
      opacity: 0.85;
    }
    .semantic-btn[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .semantic-btn.good {
      border-color: ${unsafeCSS(colors.statusOk)}44;
    }
    .semantic-btn.good:hover,
    .semantic-btn.good.selected {
      border-color: ${unsafeCSS(colors.statusOk)};
      background: ${unsafeCSS(colors.statusOk)}18;
      color: ${unsafeCSS(colors.statusOk)};
    }
    .semantic-btn.ok {
      border-color: ${unsafeCSS(colors.statusWarn)}44;
    }
    .semantic-btn.ok:hover,
    .semantic-btn.ok.selected {
      border-color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}18;
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .semantic-btn.bad {
      border-color: ${unsafeCSS(colors.statusFail)}44;
    }
    .semantic-btn.bad:hover,
    .semantic-btn.bad.selected {
      border-color: ${unsafeCSS(colors.statusFail)};
      background: ${unsafeCSS(colors.statusFail)}18;
      color: ${unsafeCSS(colors.statusFail)};
    }
    textarea {
      width: 100%;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgInput)};
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
      padding: ${unsafeCSS(spacing.md)};
      resize: vertical;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.15s;
    }
    textarea:focus {
      border-color: ${unsafeCSS(colors.accent)}88;
    }
    .hints {
      margin-top: ${unsafeCSS(spacing.sm)};
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .hint {
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .hint::before {
      content: '- ';
    }
  `;

  private _emit(value: SemanticValue, reasoning: string) {
    this.dispatchEvent(
      new CustomEvent<SemanticPickerDetail>('picker-change', {
        detail: { value, reasoning },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _select(next: Exclude<SemanticValue, ''>) {
    if (this.disabled) return;
    this.value = next;
    this._emit(next, this.reasoning);
  }

  private _onReasoningInput(event: InputEvent) {
    const text = (event.target as HTMLTextAreaElement).value;
    this.reasoning = text;
    this._emit(this.value, text);
  }

  render() {
    return html`
      <div class="semantic-row">
        ${(['good', 'ok', 'bad'] as const).map(
          (s) => html`
            <button
              type="button"
              class="semantic-btn ${s} ${this.value === s ? 'selected' : ''}"
              aria-pressed=${this.value === s}
              ?disabled=${this.disabled}
              @click=${() => this._select(s)}
            >
              ${s}
            </button>
          `,
        )}
      </div>
      ${this.showReasoning
        ? html`
            <textarea
              rows="3"
              placeholder=${this.reasoningPlaceholder}
              ?disabled=${this.disabled}
              .value=${this.reasoning}
              @input=${this._onReasoningInput}
            ></textarea>
            ${this.hints.length
              ? html`
                  <div class="hints">
                    ${this.hints.map((hint) => html`<span class="hint">${hint}</span>`)}
                  </div>
                `
              : null}
          `
        : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'grade-semantic-picker': GradeSemanticPicker;
  }
}
