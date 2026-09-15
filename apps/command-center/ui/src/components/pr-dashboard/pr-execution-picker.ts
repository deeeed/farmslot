import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  isPRWorkspaceExecutionProfile,
  type PoolConfig,
  type PRExecutionProfile,
  type PRSlotExecutionProfile,
  type PRWorkspaceExecutionProfile,
  type SlotStatus,
} from '@farmslot/protocol';

import '../shared/runner-model-effort-picker.js';
import '../shared/slot-selector-modal.js';

import type { EffortLevel } from '../../utils/runner-options.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';
import type { SlotSelectorChangeDetail } from '../shared/slot-selector-modal.js';

import { prAutomationStyles } from './pr-automation-styles.js';

export function newPRExecution(): PRSlotExecutionProfile {
  return {
    slotPolicy: { kind: 'pool', allowedSlots: [] },
    models: [{ runner: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT }],
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
      const selected = policy.kind === 'exact' ? [policy.machine] : policy.allowedMachines;
      const pools = this.pools.filter(
        (pool) =>
          pool.reviewWorkspaces &&
          (this.allProjects ||
            pool.project === this.project ||
            pool.slots.some((slot) => slot.project === this.project)),
      );
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
        ${this.value.models.map(
          (model, index) =>
            html`<runner-model-effort-picker
              .runner=${model.runner}
              .model=${model.model}
              .effort=${(model.effort ?? '') as EffortLevel}
              .disabled=${this.disabled}
              @runner-model-effort-change=${(event: CustomEvent<RunnerModelEffortChangeDetail>) =>
                this.change({
                  ...this.value,
                  models: this.value.models.map((entry, i) =>
                    i === index
                      ? {
                          ...entry,
                          runner: event.detail.runner,
                          model: event.detail.model,
                          effort: event.detail.effort || undefined,
                        }
                      : entry,
                  ),
                })}
            ></runner-model-effort-picker>`,
        )}
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
      ${this.value.models.map(
        (model, index) =>
          html` <div class="card">
            <p class="muted">${index === 0 ? 'Preferred model' : `Alternative ${index}`}</p>
            <runner-model-effort-picker
              .runner=${model.runner}
              .model=${model.model}
              .effort=${(model.effort ?? '') as EffortLevel}
              .disabled=${this.disabled}
              @runner-model-effort-change=${(event: CustomEvent<RunnerModelEffortChangeDetail>) =>
                this.change({
                  ...this.value,
                  models: this.value.models.map((entry, i) =>
                    i === index
                      ? {
                          ...entry,
                          runner: event.detail.runner,
                          model: event.detail.model,
                          effort: event.detail.effort || undefined,
                        }
                      : entry,
                  ),
                })}
            ></runner-model-effort-picker>
            <details>
              <summary data-testid=${`pr-model-restrictions-${index}`}>
                Slot restrictions ·
                ${model.allowedSlots?.length
                  ? `${model.allowedSlots.length} slots`
                  : 'all allowed slots'}
              </summary>
              <p class="muted">
                ${model.allowedSlots?.length
                  ? `${model.allowedSlots.length} restricted slots`
                  : 'Uses the allowed slots selected above.'}
              </p>
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
            </details>
            ${this.value.models.length > 1
              ? html`<button
                  type="button"
                  @click=${() =>
                    this.change({
                      ...this.value,
                      models: this.value.models.filter((_, i) => i !== index),
                    })}
                >
                  Remove alternative
                </button>`
              : nothing}
          </div>`,
      )}
      <button
        type="button"
        @click=${() =>
          this.change({
            ...this.value,
            models: [...this.value.models, { ...newPRExecution().models[0] }],
          })}
      >
        Add model alternative
      </button>
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
