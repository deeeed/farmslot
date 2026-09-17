import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { NativeRunnerOption } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type EffortLevel,
  effortsForRunner,
  MODELS_BY_RUNNER,
  PI_COMPAT_MODEL_HINT,
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
  @property({ type: Boolean }) showEffort = true;
  @property({ type: Boolean }) showRunner = true;
  @property({ type: Boolean }) showDefaultEffort = true;
  @property({ attribute: false }) catalog?: NativeRunnerOption[];

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

    input {
      box-sizing: border-box;
      width: 100%;
      margin-top: 6px;
      padding: 6px 8px;
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: ${unsafeCSS(radii.lg)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font: inherit;
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
    const runners = this.catalog?.map((option) => option.runner) ?? RUNNER_OPTIONS;
    return this.allowDefault ? ['', ...runners] : [...runners];
  }

  private modelOptions(): string[] {
    if (this.catalog)
      return this.catalog.find((option) => option.runner === this.runner)?.models ?? [];
    if (!this.runner) return this.model ? [this.model] : [];
    return [...new Set([...(MODELS_BY_RUNNER[this.runner] ?? []), this.model].filter(Boolean))];
  }

  private effortOptions(): EffortLevel[] {
    const options = effortsForRunner(this.runner, this.model);
    const values: EffortLevel[] = this.showDefaultEffort ? ['' as EffortLevel] : [];
    values.push(...options);
    if (this.effort && !values.includes(this.effort)) values.push(this.effort);
    return [...new Set(values)];
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
    const option = this.catalog?.find((entry) => entry.runner === runner);
    const models = option?.models ?? MODELS_BY_RUNNER[runner] ?? [];
    this.emitChange({
      runner,
      model: models.includes(this.model)
        ? this.model
        : (option?.defaultModel ?? DEFAULT_MODEL[runner] ?? models[0] ?? ''),
      effort: '',
    });
  }

  private selectModel(model: string) {
    const efforts = effortsForRunner(this.runner, model);
    const preferred = DEFAULT_EFFORT[this.runner] ?? '';
    const fallback = this.showDefaultEffort
      ? ''
      : efforts.includes(preferred)
        ? preferred
        : (efforts[0] ?? '');
    this.emitChange({
      runner: this.runner,
      model,
      effort: efforts.includes(this.effort) ? this.effort : fallback,
    });
  }

  private selectEffort(effort: EffortLevel) {
    this.emitChange({ runner: this.runner, model: this.model, effort });
  }

  render() {
    const models = this.modelOptions();
    const efforts = this.effortOptions();
    return html`
      <div class="config-row">
        ${this.showRunner
          ? html`<div class="config-group">
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
            </div>`
          : nothing}

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
          ${this.runner === 'pi' ? html`<div class="hint">${PI_COMPAT_MODEL_HINT}</div>` : nothing}
          ${!this.catalog && this.runner
            ? html`<details>
                <summary class="hint">Other model</summary>
                <input
                  aria-label="Custom model"
                  data-testid="runner-custom-model"
                  .value=${this.model}
                  ?disabled=${this.disabled}
                  @change=${(event: Event) => {
                    const model = (event.target as HTMLInputElement).value.trim();
                    if (model) this.selectModel(model);
                  }}
                />
              </details>`
            : nothing}
        </div>

        ${this.showEffort && this.runner && efforts.length
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
