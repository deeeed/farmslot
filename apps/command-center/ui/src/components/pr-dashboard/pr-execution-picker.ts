import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  type PRExecutionProfile,
  type SlotStatus,
} from '@farmslot/protocol';

import '../shared/runner-model-effort-picker.js';
import '../shared/slot-selector-modal.js';

import type { EffortLevel } from '../../utils/runner-options.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';
import type { SlotSelectorChangeDetail } from '../shared/slot-selector-modal.js';

import { prAutomationStyles } from './pr-automation-styles.js';

export function newPRExecution(): PRExecutionProfile {
  return {
    slotPolicy: { kind: 'pool', allowedSlots: [] },
    models: [{ runner: 'codex', model: DEFAULT_CODEX_MODEL, effort: DEFAULT_CODEX_EFFORT }],
  };
}

@customElement('pr-execution-picker')
export class PRExecutionPicker extends LitElement {
  @property({ attribute: false }) value: PRExecutionProfile = newPRExecution();
  @property({ attribute: false }) slots: SlotStatus[] = [];
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
    if (this.disabled) return;
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
          ? html`<span class="attention">Choose at least one slot before starting reviews.</span>`
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
      <p class="muted">
        One slot runs each review. Slots remain available for other PRs between rounds.
      </p>
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
            description="Search or filter existing farm slots. One slot runs each review."
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
