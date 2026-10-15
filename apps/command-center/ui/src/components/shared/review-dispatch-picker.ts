import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
  REVIEW_MODES,
  type ReviewSelection,
  type ReviewSequence,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelsGetResult,
  type RunnerVisibleModelsSetResult,
} from '@farmslot/protocol';
import {
  catalogWithRunnerModels,
  createReviewDispatchCatalog,
  type ReviewDispatchRow,
  ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import './choice-picker.js';

import { gateway } from '../../gateway-client.js';
import {
  onVisibleModelsChange,
  rememberedReviewDispatchCatalog,
  rememberedVisibleModels,
  rememberRunnerVisibleState,
} from '../../utils/runner-visible-cache.js';

import type { ChoicePicker } from './choice-picker.js';
import { planningChoiceStyles, renderChoiceButtons } from './planning-controls.js';

export interface ReviewDispatchChangeDetail {
  selection: ReviewSelection | undefined;
  sequence: ReviewSequence;
}

/** The shared model owns every choice, row operation and request payload. */
@customElement('review-dispatch-picker')
export class ReviewDispatchPicker extends LitElement {
  @property({ attribute: false }) viewModel!: ReviewDispatchViewModel;
  @property({ type: Boolean }) review = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) discover = true;
  @property({ attribute: false }) renderRowResources?: (
    row: ReviewDispatchRow,
    index: number,
  ) => unknown;
  @state() private error = '';
  @state() private modelFilters: Record<number, string> = {};
  @state() private otherModels: Record<number, boolean> = {};
  @state() private modelCatalog?: RunnerModelCatalogResult;
  private unsubscribe?: () => void;
  private unsubscribeModel?: () => void;
  private unsubscribePreferences?: () => void;
  private catalogGeneration = 0;

  static styles = css`
    ${planningChoiceStyles}
    :host {
      display: block;
      font: inherit;
      color: inherit;
    }
    .rows {
      display: grid;
      gap: 10px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: start;
      gap: 10px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      min-width: 0;
      flex: 1 1 150px;
    }
    .model-effort {
      display: flex;
      flex-wrap: wrap;
      align-items: start;
      gap: 10px;
      flex: 2 1 320px;
    }
    input,
    button {
      background: #12121a;
      color: inherit;
      border: 1px solid #343447;
      border-radius: 4px;
      padding: 5px 8px;
      font: inherit;
    }
    button {
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .error {
      color: #ff6666;
      font-size: 11px;
    }
    .index,
    .hint {
      font-size: 11px;
      color: #999;
    }
    .field {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .runner-field {
      flex: 1 1 100%;
    }
    .model-field {
      flex: 3 1 300px;
    }
    .effort-field {
      flex: 1 1 160px;
    }
    .field-title {
      font-size: 11px;
    }
    .choice-button {
      padding: 3px 9px;
    }
    .model-filter {
      max-width: 300px;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribeModel?.();
    this.unsubscribeModel = this.viewModel?.subscribe(() => this.requestUpdate());
    this.unsubscribePreferences = onVisibleModelsChange(() => {
      if (this.discover && this.viewModel)
        this.viewModel.setCatalog(rememberedReviewDispatchCatalog());
    });
    this.unsubscribe = gateway.onConnectionChange((state) => {
      if (state === 'connected' && this.discover) void this.loadCatalog();
      else this.catalogGeneration++;
    });
    if (gateway.connectionState === 'connected' && this.discover) void this.loadCatalog();
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribeModel?.();
    this.unsubscribePreferences?.();
    this.catalogGeneration++;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has('viewModel')) {
      this.modelFilters = {};
      this.otherModels = {};
      this.unsubscribeModel?.();
      this.unsubscribeModel = this.viewModel?.subscribe(() => this.requestUpdate());
    }
  }

  private async loadCatalog() {
    const generation = ++this.catalogGeneration;
    try {
      const result = await gateway.request<RunnerVisibleModelsGetResult>(
        Methods.RUNNER_VISIBLE_MODELS_GET,
        {},
      );
      if (generation !== this.catalogGeneration || !this.viewModel) return;
      result.runners.forEach(rememberRunnerVisibleState);
      this.viewModel.setCatalog(rememberedReviewDispatchCatalog());
      this.error = '';
      this.requestUpdate();
    } catch (error) {
      if (generation !== this.catalogGeneration) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async loadModels(runner: string) {
    try {
      const result = await gateway.request<RunnerModelCatalogResult>(Methods.RUNNER_MODEL_CATALOG, {
        runner,
      });
      this.modelCatalog = result;
      if (result.status === 'ready')
        this.viewModel.setCatalog(catalogWithRunnerModels(this.viewModel.catalog, result));
      this.error = result.status === 'ready' ? '' : (result.detail ?? 'Model catalog unavailable.');
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async setVisible(runner: string, model: string, visible: boolean) {
    const current =
      rememberedVisibleModels(runner) ??
      this.viewModel.catalog.runners
        .find((option) => option.id === runner)
        ?.models.map((option) => option.id) ??
      [];
    try {
      const result = await gateway.request<RunnerVisibleModelsSetResult>(
        Methods.RUNNER_VISIBLE_MODELS_SET,
        {
          runner,
          models: visible
            ? [...new Set([...current, model])]
            : current.filter((id) => id !== model),
        },
      );
      rememberRunnerVisibleState(result.runner);
      this.viewModel.setCatalog(rememberedReviewDispatchCatalog());
      this.error = '';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async saveDefault(row: ReviewDispatchRow, reset = false) {
    try {
      const result = await gateway.request<RunnerVisibleModelsSetResult>(
        Methods.RUNNER_VISIBLE_MODELS_SET,
        {
          runner: row.selection.runner,
          defaultModel: reset ? null : row.selection.model,
        },
      );
      rememberRunnerVisibleState(result.runner);
      this.viewModel.setCatalog(rememberedReviewDispatchCatalog());
      this.error = '';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private change(edit: () => void) {
    try {
      edit();
      this.error = '';
      this.dispatchEvent(
        new CustomEvent<ReviewDispatchChangeDetail>('review-dispatch-change', {
          detail: { selection: this.viewModel.selection, sequence: this.viewModel.toSequence() },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.dispatchEvent(
      new CustomEvent('review-dispatch-status-change', { bubbles: true, composed: true }),
    );
    this.requestUpdate();
  }

  render() {
    const vm = this.viewModel;
    if (!vm) return nothing;
    return html`<div class="rows">
      ${vm.rows.map((row, index) => {
        const selected = row.selection;
        const runner = vm.catalog.runners.find((option) => option.id === selected.runner);
        const efforts = vm.effortChoices(row.id);
        const models = vm.modelPickerState(row.id, this.modelFilters[row.id]);
        const showOtherModel = Boolean(this.otherModels[row.id] || models.customModel);
        return html`<div class="row" data-testid="review-dispatch-row">
          ${vm.context.allowSequence ? html`<span class="index">${index + 1}</span>` : nothing}
          <div class="field runner-field">
            <span class="field-title">RUNNER</span>
            ${renderChoiceButtons({
              options: vm.catalog.runners.map((option) => option.id),
              labels: Object.fromEntries(
                vm.catalog.runners.map((option) => [option.id, option.label ?? option.id]),
              ),
              value: selected.runner,
              testId: 'review-dispatch-runner',
              disabled: this.disabled,
              onSelect: (value) =>
                this.change(() => {
                  this.modelFilters = { ...this.modelFilters, [row.id]: '' };
                  this.otherModels = { ...this.otherModels, [row.id]: false };
                  vm.setRunner(row.id, value);
                }),
            })}
          </div>
          <div class="model-effort">
            <div class="field model-field">
              <span class="field-title">MODEL</span>
              ${models.searchable
                ? html`<input
                    class="model-filter"
                    aria-label="Filter models"
                    placeholder="Filter models…"
                    .value=${this.modelFilters[row.id] ?? ''}
                    ?disabled=${this.disabled}
                    @input=${(event: Event) => {
                      this.modelFilters = {
                        ...this.modelFilters,
                        [row.id]: (event.target as HTMLInputElement).value,
                      };
                    }}
                  />`
                : nothing}
              ${renderChoiceButtons({
                options: ['', ...models.choices.map((option) => option.id)],
                labels: {
                  '': `Default${runner?.defaultModel ? ` · ${runner.defaultModel}` : ''}`,
                  ...Object.fromEntries(
                    models.choices.map((option) => [option.id, option.label ?? option.id]),
                  ),
                },
                value: selected.model ?? '',
                testId: 'review-dispatch-model',
                disabled: this.disabled,
                onSelect: (value) =>
                  this.change(() => {
                    this.otherModels = { ...this.otherModels, [row.id]: false };
                    vm.setModel(row.id, value || null);
                  }),
              })}
              ${runner?.allowCustomModels !== false
                ? html`<div>
                    <button
                      type="button"
                      class="choice-button ${showOtherModel ? 'active' : ''}"
                      data-testid="review-dispatch-other-model"
                      aria-expanded=${String(showOtherModel)}
                      ?disabled=${this.disabled}
                      @click=${() => {
                        this.otherModels = {
                          ...this.otherModels,
                          [row.id]: !this.otherModels[row.id],
                        };
                      }}
                    >
                      Other model
                    </button>
                    ${showOtherModel
                      ? html`<label
                          >Custom model<input
                            data-testid="review-dispatch-custom-model"
                            .value=${selected.model ?? ''}
                            placeholder="Model ID"
                            ?disabled=${this.disabled}
                            @change=${(event: Event) =>
                              this.change(() =>
                                vm.setModel(
                                  row.id,
                                  (event.target as HTMLInputElement).value || null,
                                ),
                              )}
                        /></label>`
                      : nothing}
                  </div>`
                : nothing}
            </div>
            <div class="field effort-field">
              <span class="field-title">EFFORT</span>
              ${renderChoiceButtons({
                options: efforts.map((effort) => effort.value ?? ''),
                labels: Object.fromEntries(
                  efforts.map((effort) => [
                    effort.value ?? '',
                    effort.value === null
                      ? `Supported default${runner?.defaultEffort ? ` · ${runner.defaultEffort}` : ''}`
                      : effort.label,
                  ]),
                ),
                value: selected.effort ?? '',
                testId: 'review-dispatch-effort',
                disabled: this.disabled || efforts.every((effort) => effort.value === null),
                onSelect: (value) => this.change(() => vm.setEffort(row.id, value || null)),
              })}
            </div>
          </div>
          ${this.discover
            ? html`<details>
                <summary>Model preferences</summary>
                <button
                  type="button"
                  ?disabled=${this.disabled || selected.model === null}
                  @click=${() => void this.saveDefault(row)}
                >
                  Save model as default
                </button>
                <button
                  type="button"
                  ?disabled=${this.disabled}
                  @click=${() => void this.saveDefault(row, true)}
                >
                  Restore supported default
                </button>
                <button
                  type="button"
                  ?disabled=${this.disabled}
                  @click=${() => void this.loadModels(selected.runner)}
                >
                  Show model catalog
                </button>
                ${this.modelCatalog?.runner === selected.runner &&
                this.modelCatalog.status === 'ready'
                  ? createReviewDispatchCatalog({ runnerModels: [this.modelCatalog] })
                      .runners.find((option) => option.id === selected.runner)
                      ?.models.map(
                        (model) =>
                          html`<label>
                            <input
                              type="checkbox"
                              ?disabled=${this.disabled}
                              .checked=${(
                                rememberedVisibleModels(selected.runner) ??
                                runner?.models.map((option) => option.id) ??
                                []
                              ).includes(model.id)}
                              @change=${(event: Event) =>
                                void this.setVisible(
                                  selected.runner,
                                  model.id,
                                  (event.target as HTMLInputElement).checked,
                                )}
                            />
                            ${model.label ?? model.id}
                          </label>`,
                      )
                  : nothing}
              </details>`
            : nothing}
          ${this.review
            ? html`<div class="field">
                <span class="field-title">MODE</span>
                ${renderChoiceButtons({
                  options: REVIEW_MODES,
                  labels: { cold: 'COLD', warm: 'WARM' },
                  value: selected.mode,
                  testId: 'review-dispatch-mode',
                  disabled: this.disabled,
                  onSelect: (value) => this.change(() => vm.setMode(row.id, value)),
                })}
                <span class="hint"
                  >${selected.mode === 'cold'
                    ? 'Fresh session, whole PR'
                    : 'Retained session, changes since review'}</span
                >
              </div>`
            : nothing}
          ${this.review && selected.mode === 'warm'
            ? html`<label
                >Retained review<choice-picker
                  data-testid="review-dispatch-lineage"
                  .value=${row.context?.reviewId ?? ''}
                  ?disabled=${this.disabled}
                  @change=${(event: Event) =>
                    this.change(() =>
                      vm.setReviewContext(
                        row.id,
                        (
                          vm.context.reviewLineages ??
                          vm.context.reviewContext?.reviewLineages ??
                          []
                        ).find(
                          (context) => context?.reviewId === (event.target as ChoicePicker).value,
                        ) ?? null,
                      ),
                    )}
                >
                  <option value="">Choose retained review</option>
                  ${(
                    vm.context.reviewLineages ??
                    vm.context.reviewContext?.reviewLineages ??
                    []
                  ).map((context) =>
                    context
                      ? html`<option value=${context.reviewId}>
                          ${context.repository}#${context.prNumber} · ${context.reviewId}
                        </option>`
                      : nothing,
                  )}
                </choice-picker></label
              >`
            : nothing}
          ${vm.context.allowSequence
            ? html`<button
                  type="button"
                  ?disabled=${this.disabled || index === 0}
                  @click=${() => this.change(() => vm.moveRow(row.id, index - 1))}
                  aria-label=${vm.context.sequenceRole === 'execution-alternatives'
                    ? 'Move model earlier'
                    : 'Move review earlier'}
                >
                  ↑
                </button>
                <button
                  type="button"
                  ?disabled=${this.disabled || index === vm.rows.length - 1}
                  @click=${() => this.change(() => vm.moveRow(row.id, index + 1))}
                  aria-label=${vm.context.sequenceRole === 'execution-alternatives'
                    ? 'Move model later'
                    : 'Move review later'}
                >
                  ↓
                </button>
                <button
                  type="button"
                  ?disabled=${this.disabled || !vm.canRemoveRow}
                  @click=${() => this.change(() => vm.removeRow(row.id))}
                >
                  Remove
                </button>`
            : nothing}
          ${this.renderRowResources?.(row, index) ?? nothing}
        </div>`;
      })}
      ${vm.context.allowSequence
        ? html`<button
            type="button"
            data-testid="review-dispatch-add"
            ?disabled=${this.disabled || !vm.canAddRow}
            @click=${() =>
              this.change(() => {
                vm.addRow();
              })}
          >
            ${vm.context.sequenceRole === 'execution-alternatives'
              ? 'Add model alternative'
              : 'Add review'}
          </button>`
        : nothing}
      ${this.error || vm.errors.length
        ? html`<div class="error" role="alert">${this.error || vm.errors.join(' ')}</div>`
        : nothing}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'review-dispatch-picker': ReviewDispatchPicker;
  }
}
