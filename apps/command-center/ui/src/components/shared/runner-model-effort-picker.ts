import { css, html, LitElement, nothing, type PropertyValues, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
  type NativeRunnerOption,
  type RunnerCatalogModel,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelsGetResult,
  type RunnerVisibleModelsSetResult,
  type RunnerVisibleModelState,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
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
import { rememberVisibleModels } from '../../utils/runner-visible-cache.js';

const CATALOG_LOADING = 'Loading model catalog.';

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
  /** Ask the gateway for visible defaults and, on request, the runner catalog. */
  @property({ type: Boolean }) discover = true;

  @state() private visibleState: RunnerVisibleModelState | null = null;
  @state() private loadedCatalog: RunnerModelCatalogResult | null = null;
  @state() private catalogOpen = false;
  @state() private catalogChecks: string[] = [];
  @state() private catalogStatus = '';
  @state() private modelsReady = false;
  /** Latest request ids. An older answer arriving later is dropped. */
  private visibleRequest = 0;
  private catalogRequest = 0;

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

    .catalog {
      display: grid;
      gap: 6px;
      margin-top: 8px;
    }

    .catalog-row {
      display: flex;
      gap: 8px;
      align-items: baseline;
    }

    .link {
      border: 0;
      background: transparent;
      color: ${unsafeCSS(colors.accent)};
      cursor: pointer;
      font: inherit;
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 0;
    }
  `;

  private runnerOptions(): string[] {
    const runners = this.catalog?.map((option) => option.runner) ?? RUNNER_OPTIONS;
    return this.allowDefault ? ['', ...runners] : [...runners];
  }

  override updated(changed: PropertyValues): void {
    if (this.catalog || !this.discover) {
      this.modelsReady = true;
      return;
    }
    if (changed.has('runner')) {
      this.catalogOpen = false;
      this.catalogRequest++;
      this.loadedCatalog = null;
      this.catalogStatus = '';
      this.modelsReady = false;
    }
    if (changed.has('runner') || changed.has('model')) void this.loadVisible();
  }

  private modelOptions(): string[] {
    if (this.catalog)
      return this.catalog.find((option) => option.runner === this.runner)?.models ?? [];
    if (!this.runner) return this.model ? [this.model] : [];
    if (this.visibleState?.runner === this.runner) return [...this.visibleState.pickerModels];
    return [...new Set([...(MODELS_BY_RUNNER[this.runner] ?? []), this.model].filter(Boolean))];
  }

  /** Accepted efforts for a model, narrowed by the loaded catalog's modes for it. */
  private effortsForModel(model: string): EffortLevel[] {
    const catalogModes =
      this.loadedCatalog?.runner === this.runner
        ? this.loadedCatalog.models.find((entry) => entry.id === model)?.reasoningModes
        : undefined;
    return effortsForRunner(this.runner, model, catalogModes);
  }

  private effortOptions(): EffortLevel[] {
    const options = this.effortsForModel(this.model);
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
    const efforts = this.effortsForModel(model);
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

  private async loadVisible() {
    if (!this.runner || this.catalog || !this.discover) {
      this.modelsReady = true;
      return;
    }
    const runner = this.runner;
    const request = ++this.visibleRequest;
    try {
      const result = await gateway.request<RunnerVisibleModelsGetResult>(
        Methods.RUNNER_VISIBLE_MODELS_GET,
        { runner, ...(this.model ? { selectedModel: this.model } : {}) },
      );
      if (request !== this.visibleRequest || this.runner !== runner) return;
      const next = result.runners[0] ?? null;
      if (next) rememberVisibleModels(runner, next.models);
      if (JSON.stringify(next) !== JSON.stringify(this.visibleState)) this.visibleState = next;
    } catch (err) {
      if (request !== this.visibleRequest) return;
      // The dev harness renders this picker with no gateway socket. Leave the
      // built-in seed in place. Any other failure is shown on the catalog status.
      if (!(err instanceof Error && err.message === 'Not connected')) {
        this.catalogStatus =
          err instanceof Error ? err.message : 'Visible models could not be loaded.';
      }
    } finally {
      if (request === this.visibleRequest && this.runner === runner) this.modelsReady = true;
    }
  }

  private async toggleCatalog() {
    this.catalogOpen = !this.catalogOpen;
    // Closing, reopening or switching runner makes any pending catalog answer stale.
    const request = ++this.catalogRequest;
    if (!this.catalogOpen) return;
    const runner = this.runner;
    this.catalogStatus = CATALOG_LOADING;
    let result: RunnerModelCatalogResult;
    try {
      result = await gateway.request<RunnerModelCatalogResult>(Methods.RUNNER_MODEL_CATALOG, {
        runner,
      });
    } catch (err) {
      result = {
        runner,
        status: 'unavailable',
        source: 'structured-file',
        detail: err instanceof Error ? err.message : 'Model catalog request failed.',
        models: [],
      };
    }
    // The checks start from the saved set. If it has not loaded yet, prefilling
    // from the built-in list would let a save overwrite the operator's set.
    if (this.visibleState?.runner !== runner) await this.loadVisible();
    // The operator switched runners, or closed or reopened the catalog, while a
    // request was in flight. Its models must not replace the current checks.
    if (request !== this.catalogRequest || this.runner !== runner || !this.catalogOpen) return;
    if (this.visibleState?.runner !== runner) {
      // loadVisible reports a gateway error itself; a missing socket leaves this.
      if (this.catalogStatus === CATALOG_LOADING)
        this.catalogStatus = 'Visible models could not be loaded.';
      return;
    }
    this.loadedCatalog = result;
    this.catalogChecks = [...this.visibleState.models];
    this.catalogStatus = result.detail ?? '';
  }

  private async saveVisible() {
    const runner = this.runner;
    const models = [...this.catalogChecks];
    await gateway.request<RunnerVisibleModelsSetResult>(Methods.RUNNER_VISIBLE_MODELS_SET, {
      runner,
      models,
    });
    if (this.runner !== runner) return;
    this.catalogStatus = 'Visible models saved.';
    await this.loadVisible();
  }

  private renderCatalog() {
    const rows = this.loadedCatalog?.status === 'ready' ? this.catalogRows() : [];
    return html`<div class="catalog">
      ${rows.map(
        (model) =>
          html`<label class="catalog-row">
            <input
              type="checkbox"
              data-testid=${`runner-catalog-default-${model.id}`}
              .checked=${this.catalogChecks.includes(model.id)}
              ?disabled=${this.disabled}
              @change=${(event: Event) => {
                const checked = (event.target as HTMLInputElement).checked;
                this.catalogChecks = checked
                  ? [...new Set([...this.catalogChecks, model.id])]
                  : this.catalogChecks.filter((id) => id !== model.id);
              }}
            />
            <span>${model.id}</span>
            ${model.reasoningModes.length
              ? html`<span class="hint">${model.reasoningModes.join(', ')}</span>`
              : nothing}
          </label>`,
      )}
      ${this.loadedCatalog?.status === 'ready'
        ? html`<button
            class="link"
            type="button"
            data-testid="runner-visible-models-save"
            ?disabled=${this.disabled}
            @click=${() => void this.saveVisible()}
          >
            Save visible models
          </button>`
        : nothing}
      <div class="hint" data-testid="runner-model-catalog-status">${this.catalogStatus}</div>
    </div>`;
  }

  private catalogRows(): RunnerCatalogModel[] {
    const reported = this.loadedCatalog?.models ?? [];
    const extras = (this.visibleState?.models ?? []).filter(
      (id) => !reported.some((model) => model.id === id),
    );
    return [...reported, ...extras.map((id) => ({ id, reasoningModes: [], listed: true }))];
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
                      data-testid=${`runner-option-${runner || 'default'}`}
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
            ? html`<div
                class="pill-row"
                data-testid=${this.modelsReady || this.catalog ? 'runner-models-ready' : nothing}
              >
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
                      data-testid=${`runner-model-${model}`}
                      ?data-retained=${this.visibleState?.retainedModel === model}
                      ?disabled=${this.disabled}
                      @click=${() => this.selectModel(model)}
                    >
                      ${model}
                    </button>`,
                )}
              </div>`
            : html`<div class="hint">Choose a runner to set a model.</div>`}
          ${this.discover && !this.catalog && this.runner
            ? html`<button
                class="link"
                type="button"
                data-testid="runner-model-catalog-toggle"
                ?disabled=${this.disabled}
                @click=${() => void this.toggleCatalog()}
              >
                ${this.catalogOpen ? 'Hide catalog' : 'Show catalog'}
              </button>`
            : nothing}
          ${this.catalogOpen ? this.renderCatalog() : nothing}
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
                      data-testid=${`runner-effort-${effort || 'default'}`}
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
