import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  isPRWorkspaceExecutionProfile,
  type PoolConfig,
  type PRExecutionModel,
  type PRExecutionProfile,
  type PRReviewOptions,
  type PRSlotExecutionProfile,
  type PRWorkspaceExecutionProfile,
  type ReviewContinuationContext,
  type ReviewMode,
  type ReviewRequestContext,
  type SlotStatus,
  workspacePolicyMachines,
} from '@farmslot/protocol';
import {
  defaultReviewDispatchExecutionModels,
  ReviewDispatchViewModel,
  reviewSequenceForExecution,
} from '@farmslot/review-dispatch';

import '../shared/review-dispatch-picker.js';
import '../shared/slot-selector-modal.js';

import { visibleReviewDispatchCatalog } from '../../utils/runner-visible-models.js';
import type { ReviewDispatchChangeDetail } from '../shared/review-dispatch-picker.js';
import type { SlotSelectorChangeDetail } from '../shared/slot-selector-modal.js';

import { prAutomationStyles } from './pr-automation-styles.js';

export interface PRReviewExecutionChangeDetail {
  execution: PRExecutionProfile;
  review: Pick<PRReviewOptions, 'mode' | 'reviewContext'>;
}

export function newPRExecution(): PRSlotExecutionProfile {
  return {
    slotPolicy: { kind: 'pool', allowedSlots: [] },
    models: defaultReviewDispatchExecutionModels(visibleReviewDispatchCatalog()),
  };
}

export function newPRWorkspaceExecution(): PRWorkspaceExecutionProfile {
  return {
    workspacePolicy: { kind: 'pool', allowedMachines: [] },
    transport: 'native',
    models: newPRExecution().models,
  };
}

@customElement('pr-execution-picker')
export class PRExecutionPicker extends LitElement {
  @property({ attribute: false }) value: PRExecutionProfile = newPRExecution();
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ attribute: false }) pools: PoolConfig[] = [];
  @property() resource: 'workspace' | 'slot' = 'slot';
  @property() project = '';
  @property({ type: Boolean }) allProjects = false;
  @property({ type: Boolean }) disabled = false;
  @property() reviewMode: ReviewMode = 'cold';
  @property({ attribute: false }) reviewLineages: readonly ReviewContinuationContext[] = [];
  @property({ attribute: false }) reviewContext?: ReviewRequestContext;
  @property({ type: Boolean }) review = false;
  private viewModel = new ReviewDispatchViewModel({
    context: {
      allowedActions: ['configure'],
      allowSequence: true,
      sequenceRole: 'execution-alternatives',
    },
  });
  private resources = new Map<number, Pick<PRExecutionModel, 'allowedSlots' | 'allowedMachines'>>();

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has('value') ||
      changed.has('reviewMode') ||
      changed.has('reviewContext') ||
      changed.has('reviewLineages')
    ) {
      this.viewModel.setContext({
        ...this.viewModel.context,
        reviewContext: this.reviewContext,
        reviewLineages: this.reviewLineages,
      });
      this.viewModel.setSequence(reviewSequenceForExecution(this.value.models, this.reviewMode));
      this.resources = new Map(
        this.viewModel.rows.map((row, index) => [
          row.id,
          {
            allowedSlots: this.value.models[index]?.allowedSlots,
            allowedMachines: this.value.models[index]?.allowedMachines,
          },
        ]),
      );
    }
  }

  get validationErrors(): readonly string[] {
    return this.viewModel.errors;
  }

  private renderModels(renderResources?: (index: number) => unknown) {
    return html`<review-dispatch-picker
      .viewModel=${this.viewModel}
      .review=${this.review}
      .disabled=${this.disabled}
      .renderRowResources=${(_row: unknown, index: number) => renderResources?.(index) ?? nothing}
      @review-dispatch-change=${(event: CustomEvent<ReviewDispatchChangeDetail>) => {
        const execution = {
          ...this.value,
          models: this.viewModel.toExecutionModels(this.resources),
        };
        if (this.review)
          this.dispatchEvent(
            new CustomEvent<PRReviewExecutionChangeDetail>('review-execution-change', {
              detail: {
                execution,
                review: {
                  mode: event.detail.selection!.mode,
                  reviewContext: this.viewModel.toReviewContext(),
                },
              },
              bubbles: true,
              composed: true,
            }),
          );
        else this.change(execution);
      }}
      @review-dispatch-status-change=${() => this.requestUpdate()}
    ></review-dispatch-picker>`;
  }
  @state() private picker: 'allowed' | number | undefined;
  static styles = prAutomationStyles;

  private change(value: PRExecutionProfile) {
    this.dispatchEvent(
      new CustomEvent('execution-change', { detail: value, bubbles: true, composed: true }),
    );
  }
  private toggleSlot(slotId: string, selected: boolean) {
    if (isPRWorkspaceExecutionProfile(this.value)) return;
    const slots =
      this.value.slotPolicy.kind === 'exact'
        ? [this.value.slotPolicy.slotId]
        : this.value.slotPolicy.allowedSlots;
    const next = selected ? [...new Set([...slots, slotId])] : slots.filter((id) => id !== slotId);
    this.change({
      ...this.value,
      slotPolicy:
        next.length === 1
          ? { kind: 'exact', slotId: next[0] }
          : { kind: 'pool', allowedSlots: next },
    });
  }
  private applySelection(selected: string[]) {
    if (this.disabled || isPRWorkspaceExecutionProfile(this.value)) return;
    if (this.picker === 'allowed')
      this.change({
        ...this.value,
        slotPolicy:
          selected.length === 1
            ? { kind: 'exact', slotId: selected[0] }
            : { kind: 'pool', allowedSlots: selected },
      });
    else
      this.change({
        ...this.value,
        models: this.value.models.map((model, index) =>
          index === this.picker
            ? { ...model, allowedSlots: selected.length ? selected : undefined }
            : model,
        ),
      });
  }
  private slotSummary(selected: readonly string[]) {
    return html`<div class="row">
      ${selected.slice(0, 4).map((id) => html`<code>${id}</code>`)}${selected.length > 4
        ? html`<span class="muted">+${selected.length - 4} more</span>`
        : nothing}
    </div>`;
  }
  render() {
    if (this.resource === 'slot' && isPRWorkspaceExecutionProfile(this.value)) {
      return html`<fieldset ?disabled=${this.disabled}>
        <p class="attention">
          On-device review needs runtime slots. This policy currently selects review machines.
        </p>
        <button
          type="button"
          data-testid="pr-execution-use-slots"
          @click=${() =>
            this.change({
              ...newPRExecution(),
              models: this.value.models.map(({ allowedMachines: _machines, ...model }) => model),
            })}
        >
          Choose runtime slots
        </button>
      </fieldset>`;
    }
    if (this.resource === 'workspace' && !isPRWorkspaceExecutionProfile(this.value)) {
      return html`<fieldset ?disabled=${this.disabled}>
        <p class="attention">
          This saved policy selects device slots. Static Review needs an explicit machine selection.
        </p>
        <button
          type="button"
          data-testid="pr-execution-use-workspace"
          @click=${() =>
            this.change({
              ...newPRWorkspaceExecution(),
              models: this.value.models.map(({ allowedSlots: _slots, ...model }) => model),
            })}
        >
          Choose review machines
        </button>
      </fieldset>`;
    }
    if (isPRWorkspaceExecutionProfile(this.value)) {
      const policy = this.value.workspacePolicy;
      const value = this.value;

      const pools = this.pools.filter(
        (pool) =>
          pool.reviewWorkspaces &&
          (this.allProjects ||
            pool.project === this.project ||
            pool.slots.some((slot) => slot.project === this.project)),
      );
      const selected = workspacePolicyMachines(policy) ?? pools.map((pool) => pool.machine);
      const toggle = (machine: string, checked: boolean) => {
        const machines = checked
          ? [...new Set([...selected, machine])]
          : selected.filter((entry) => entry !== machine);
        this.change({
          ...value,
          workspacePolicy:
            machines.length === 1
              ? { kind: 'exact', machine: machines[0] }
              : { kind: 'pool', allowedMachines: machines },
        });
      };
      return html`<fieldset ?disabled=${this.disabled}>
        <legend>Review machines</legend>
        ${pools.map(
          (pool) =>
            html`<label class="check"
              ><input
                type="checkbox"
                data-testid=${`pr-review-machine-${pool.machine}`}
                .checked=${selected.includes(pool.machine)}
                @change=${(event: Event) =>
                  toggle(pool.machine, (event.target as HTMLInputElement).checked)}
              />${pool.machine} · up to ${pool.reviewWorkspaces!.maxConcurrent} reviews</label
            >`,
        )}
        ${selected
          .filter((machine) => !pools.some((pool) => pool.machine === machine))
          .map(
            (machine) =>
              html`<p class="attention">
                ${machine} is unavailable for this farm.
                <button type="button" @click=${() => toggle(machine, false)}>Remove</button>
              </p>`,
          )}
        ${!selected.length
          ? html`<p class="attention">Select a configured review machine.</p>`
          : nothing}
        ${!pools.length
          ? html`<p class="muted">
              Enable workspace review capacity on a machine assigned to this farm.
            </p>`
          : nothing}
        <p class="muted">
          Static review runs in an isolated workspace. Device slots remain available.
        </p>
        ${this.renderModels()}
      </fieldset>`;
    }
    const selected =
      this.value.slotPolicy.kind === 'exact'
        ? [this.value.slotPolicy.slotId]
        : this.value.slotPolicy.allowedSlots;
    const slots = this.slots.filter(
      (slot) => (this.allProjects || slot.project === this.project) && !slot.missingFromPool,
    );
    return html` <fieldset ?disabled=${this.disabled}>
      <legend>Allowed slots</legend>
      ${!this.project && !this.allProjects
        ? html`<p class="muted">Choose a project to select its slots.</p>`
        : nothing}
      <div class="row">
        <button
          type="button"
          data-testid="pr-execution-choose-slots"
          ?disabled=${this.disabled || (!this.project && !this.allProjects)}
          @click=${() => {
            this.picker = 'allowed';
          }}
        >
          Choose slots${selected.length ? ` · ${selected.length} selected` : ''}
        </button>
        ${!selected.length
          ? html`<span class="attention">Choose at least one runtime slot.</span>`
          : nothing}
      </div>
      ${this.slotSummary(selected)}
      ${selected
        .filter((id) => !slots.some((slot) => slot.slot === id))
        .map(
          (id) =>
            html`<p class="attention">
              ${id} is unavailable in this project.
              <button type="button" @click=${() => this.toggleSlot(id, false)}>Remove</button>
            </p>`,
        )}
      <p class="muted">Each runtime run uses one configured slot.</p>
      ${this.renderModels((index) => {
        const model = this.value.models[index];
        if (!model) return nothing;
        return html`<details>
          <summary data-testid=${`pr-model-restrictions-${index}`}>
            Slot restrictions ·
            ${model.allowedSlots?.length
              ? `${model.allowedSlots.length} slots`
              : 'all allowed slots'}
          </summary>
          ${this.slotSummary(model.allowedSlots ?? [])}
          <button
            type="button"
            data-testid=${`pr-execution-model-slots-${index}`}
            ?disabled=${this.disabled || !selected.length}
            @click=${() => {
              this.picker = index;
            }}
          >
            Choose a subset
          </button>
        </details>`;
      })}
      ${this.picker !== undefined
        ? html`<slot-selector-modal
            .open=${true}
            .filterable=${true}
            .disabled=${this.disabled}
            .project=${new Set(slots.map((slot) => slot.project)).size === 1
              ? (slots[0]?.project ?? '')
              : ''}
            .slots=${this.picker === 'allowed'
              ? slots
              : slots.filter((slot) => selected.includes(slot.slot))}
            .selected=${this.picker === 'allowed'
              ? selected
              : (this.value.models[this.picker]?.allowedSlots ?? selected)}
            heading=${this.picker === 'allowed' ? 'Allowed review slots' : 'Slots for this model'}
            description="Search or filter runtime slots for this farm."
            clearLabel=${this.picker === 'allowed' ? 'Clear selection' : 'Use all allowed slots'}
            @slot-selector-change=${(event: CustomEvent<SlotSelectorChangeDetail>) => {
              event.stopPropagation();
              this.applySelection(event.detail.selected);
            }}
            @slot-selector-close=${() => {
              this.picker = undefined;
            }}
          ></slot-selector-modal>`
        : nothing}
    </fieldset>`;
  }
}
