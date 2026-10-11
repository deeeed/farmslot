import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Methods,
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

import { gateway } from '../../gateway-client.js';
import {
  onVisibleModelsChange,
  rememberedReviewDispatchCatalog,
  rememberedVisibleModels,
  rememberRunnerVisibleState,
} from '../../utils/runner-visible-cache.js';

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
  @state() private modelCatalog?: RunnerModelCatalogResult;
  private unsubscribe?: () => void;
  private unsubscribeModel?: () => void;
  private unsubscribePreferences?: () => void;
  private catalogGeneration = 0;

  static styles = css`
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
      align-items: end;
      gap: 10px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
    }
    .model-effort {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 10px;
    }
    select,
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
    button:disabled,
    select:disabled {
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
        return html`<div class="row" data-testid="review-dispatch-row">
          ${vm.context.allowSequence ? html`<span class="index">${index + 1}</span>` : nothing}
          <label
            >RUNNER<select
              data-testid="review-dispatch-runner"
              .value=${selected.runner}
              ?disabled=${this.disabled}
              @change=${(event: Event) =>
                this.change(() => vm.setRunner(row.id, (event.target as HTMLSelectElement).value))}
            >
              ${vm.catalog.runners.map(
                (option) =>
                  html`<option value=${option.id} ?selected=${selected.runner === option.id}>
                    ${option.label ?? option.id}
                  </option>`,
              )}
            </select></label
          >
          <div class="model-effort">
            <label
              >MODEL<select
                data-testid="review-dispatch-model"
                .value=${selected.model ?? ''}
                ?disabled=${this.disabled}
                @change=${(event: Event) =>
                  this.change(() =>
                    vm.setModel(row.id, (event.target as HTMLSelectElement).value || null),
                  )}
              >
                <option value="" ?selected=${selected.model === null}>
                  Default${runner?.defaultModel ? ` · ${runner.defaultModel}` : ''}
                </option>
                ${vm
                  .modelChoices(row.id)
                  .map(
                    (option) =>
                      html`<option value=${option.id} ?selected=${selected.model === option.id}>
                        ${option.label ?? option.id}
                      </option>`,
                  )}
              </select></label
            >
            <label
              >EFFORT<select
                data-testid="review-dispatch-effort"
                .value=${selected.effort ?? ''}
                ?disabled=${this.disabled ||
                efforts.filter((effort) => effort.value !== null).length === 0}
                @change=${(event: Event) =>
                  this.change(() =>
                    vm.setEffort(row.id, (event.target as HTMLSelectElement).value || null),
                  )}
              >
                ${efforts.map(
                  (effort) =>
                    html`<option
                      value=${effort.value ?? ''}
                      ?selected=${selected.effort === effort.value}
                    >
                      ${effort.value === null
                        ? `Supported default${runner?.defaultEffort ? ` · ${runner.defaultEffort}` : ''}`
                        : effort.label}
                    </option>`,
                )}
              </select></label
            >
          </div>
          ${runner?.allowCustomModels !== false
            ? html`<label
                >Custom model<input
                  data-testid="review-dispatch-custom-model"
                  .value=${selected.model ?? ''}
                  placeholder="Model ID"
                  ?disabled=${this.disabled}
                  @change=${(event: Event) =>
                    this.change(() =>
                      vm.setModel(row.id, (event.target as HTMLInputElement).value || null),
                    )}
              /></label>`
            : nothing}
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
            ? html`<label
                >MODE<select
                  data-testid="review-dispatch-mode"
                  .value=${selected.mode}
                  ?disabled=${this.disabled}
                  @change=${(event: Event) =>
                    this.change(() =>
                      vm.setMode(
                        row.id,
                        (event.target as HTMLSelectElement).value as ReviewSelection['mode'],
                      ),
                    )}
                >
                  <option value="cold" ?selected=${selected.mode === 'cold'}>
                    COLD · fresh session, whole PR
                  </option>
                  <option value="warm" ?selected=${selected.mode === 'warm'}>
                    WARM · retained session, changes since review
                  </option>
                </select></label
              >`
            : nothing}
          ${this.review && selected.mode === 'warm'
            ? html`<label
                >Retained review<select
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
                          (context) =>
                            context?.reviewId === (event.target as HTMLSelectElement).value,
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
                </select></label
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
