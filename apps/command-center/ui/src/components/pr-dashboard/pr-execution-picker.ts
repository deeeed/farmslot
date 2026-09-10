import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  type PRExecutionProfile,
  type SlotStatus,
} from '@farmslot/protocol';

import '../shared/runner-model-effort-picker.js';

import type { EffortLevel } from '../../utils/runner-options.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';

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
      <div class="slots">
        ${slots.map(
          (slot) =>
            html`<label class="check"
              ><input
                data-slot-id=${slot.slot}
                type="checkbox"
                .checked=${selected.includes(slot.slot)}
                @change=${(event: Event) =>
                  this.toggleSlot(slot.slot, (event.target as HTMLInputElement).checked)}
              />${slot.slot}${!slot.enabled ? ' (disabled)' : ''}</label
            >`,
        )}
      </div>
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
            <label
              >Limit this model to slots, optional<input
                .value=${model.allowedSlots?.join(', ') ?? ''}
                placeholder="slot-a, slot-b"
                @change=${(event: Event) => {
                  const ids = (event.target as HTMLInputElement).value
                    .split(',')
                    .map((id) => id.trim())
                    .filter(Boolean);
                  this.change({
                    ...this.value,
                    models: this.value.models.map((entry, i) =>
                      i === index
                        ? { ...entry, allowedSlots: ids.length ? ids : undefined }
                        : entry,
                    ),
                  });
                }}
            /></label>
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
    </fieldset>`;
  }
}
