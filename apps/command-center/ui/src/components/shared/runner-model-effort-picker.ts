import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  DEFAULT_MODEL,
  EFFORT_BY_RUNNER,
  type EffortLevel,
  MODELS_BY_RUNNER,
  RUNNER_OPTIONS,
} from '../../utils/runner-options.js';

export interface RunnerModelEffortChangeDetail {
  runner: string;
  model: string;
  effort: EffortLevel;
}

@customElement('runner-model-effort-picker')
export class RunnerModelEffortPicker extends LitElement {
  @property({ type: String }) runner = '';
  @property({ type: String }) model = '';
  @property({ type: String }) effort: EffortLevel = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) allowDefault = false;

  static styles = css`
    :host {
      display: block;
    }

    .config-row {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.md)};
      align-items: flex-start;
    }

    .config-group {
      display: grid;
      gap: 6px;
      min-width: min(100%, 180px);
    }

    .section-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .pill {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.lg)};
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font: inherit;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.4;
      padding: 3px 9px;
    }

    .pill:hover {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.textSecondary)};
    }

    .pill.selected {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }

    .pill:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .hint {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.4;
      max-width: 360px;
    }

    .warning {
      color: ${unsafeCSS(colors.statusWarn)};
    }
  `;

  private runnerOptions(): string[] {
    return this.allowDefault ? ['', ...RUNNER_OPTIONS] : [...RUNNER_OPTIONS];
  }

  private modelOptions(): string[] {
    if (!this.runner) return this.model ? [this.model] : [];
    return [...new Set([...(MODELS_BY_RUNNER[this.runner] ?? []), this.model].filter(Boolean))];
  }

  private effortOptions(): EffortLevel[] {
    const options = this.runner ? (EFFORT_BY_RUNNER[this.runner] ?? []) : [];
    return [
      ...new Set(
        ['' as EffortLevel, ...options, this.effort].filter((effort) => effort !== undefined),
      ),
    ];
  }

  private emitChange(detail: RunnerModelEffortChangeDetail) {
    this.dispatchEvent(
      new CustomEvent<RunnerModelEffortChangeDetail>('runner-model-effort-change', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private selectRunner(runner: string) {
    if (!runner) {
      this.emitChange({ runner: '', model: '', effort: '' });
      return;
    }
    const models = MODELS_BY_RUNNER[runner] ?? [];
    this.emitChange({
      runner,
      model: models.includes(this.model) ? this.model : (DEFAULT_MODEL[runner] ?? models[0] ?? ''),
      effort: '',
    });
  }

  private selectModel(model: string) {
    this.emitChange({ runner: this.runner, model, effort: this.effort });
  }

  private selectEffort(effort: EffortLevel) {
    this.emitChange({ runner: this.runner, model: this.model, effort });
  }

  render() {
    const models = this.modelOptions();
    const efforts = this.effortOptions();
    return html`
      <div class="config-row">
        <div class="config-group">
          <div class="section-label">Runner</div>
          <div class="pill-row">
            ${this.runnerOptions().map(
              (runner) =>
                html`<button
                  class="pill ${this.runner === runner ? 'selected' : ''}"
                  type="button"
                  ?disabled=${this.disabled}
                  @click=${() => this.selectRunner(runner)}
                >
                  ${runner || 'default'}
                </button>`,
            )}
          </div>
        </div>

        <div class="config-group">
          <div class="section-label">Model</div>
          ${models.length
            ? html`<div class="pill-row">
                ${this.allowDefault
                  ? html`<button
                      class="pill ${this.model === '' ? 'selected' : ''}"
                      type="button"
                      ?disabled=${this.disabled}
                      @click=${() => this.selectModel('')}
                    >
                      default
                    </button>`
                  : nothing}
                ${models.map(
                  (model) =>
                    html`<button
                      class="pill ${this.model === model ? 'selected' : ''}"
                      type="button"
                      ?disabled=${this.disabled}
                      @click=${() => this.selectModel(model)}
                    >
                      ${model}
                    </button>`,
                )}
              </div>`
            : html`<div class="hint">Choose a runner to set a model.</div>`}
          ${this.runner === 'cursor'
            ? html`<div class="hint">
                Curated Cursor models (Composer + Grok-on-Cursor). Custom or gateway/admin dispatch
                may pass any account-available model.
              </div>`
            : this.runner === 'claude' && this.model === 'fable'
              ? html`<div class="hint warning">
                  Fable is a heavyweight Claude model; select it only for very complex tasks.
                </div>`
              : nothing}
        </div>

        ${this.runner && efforts.length
          ? html`<div class="config-group">
              <div class="section-label">Effort</div>
              <div class="pill-row">
                ${efforts.map(
                  (effort) =>
                    html`<button
                      class="pill ${this.effort === effort ? 'selected' : ''}"
                      type="button"
                      ?disabled=${this.disabled}
                      @click=${() => this.selectEffort(effort)}
                    >
                      ${effort || 'default'}
                    </button>`,
                )}
              </div>
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'runner-model-effort-picker': RunnerModelEffortPicker;
  }
}
