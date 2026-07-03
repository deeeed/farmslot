import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { DEFAULT_BRANCH, type SlotStatus } from '@farmslot/protocol';

import './slot-choice-row.js';

import { colors, fonts } from '../../styles/theme-tokens.js';

export interface SlotChoiceChangeDetail {
  allowedSlots: string[] | null;
}

@customElement('slot-choice-list')
export class SlotChoiceList extends LitElement {
  @property({ attribute: false }) slots: readonly SlotStatus[] = [];
  @property({ attribute: false }) selectedSlots: readonly string[] = [];
  @property({ type: String }) project = '';
  @property({ type: Boolean }) disabled = false;

  static styles = css`
    :host {
      display: block;
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }

    .candidate-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
    }
  `;

  private emitAllowedSlots(allowedSlots: string[] | null) {
    this.dispatchEvent(
      new CustomEvent<SlotChoiceChangeDetail>('slot-choice-change', {
        detail: { allowedSlots },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private selectedSet(): Set<string> {
    return new Set(this.selectedSlots);
  }

  private toggleSlot(slotId: string) {
    const selected = this.selectedSet();
    if (selected.has(slotId)) selected.delete(slotId);
    else selected.add(slotId);
    this.emitAllowedSlots(selected.size ? [...selected] : null);
  }

  private renderAnyEligible() {
    const selected = this.selectedSlots.length === 0;
    return html`
      <slot-choice-row
        .rank=${selected ? '#1' : '--'}
        .slotId=${'Any eligible'}
        .branch=${this.project || 'selected project'}
        .task=${'Let the scheduler pick from visible eligible slots.'}
        .lifecycle=${'auto'}
        .score=${'0'}
        ?selected=${selected}
        ?disabled=${this.disabled}
        @click=${() => this.emitAllowedSlots(null)}
      ></slot-choice-row>
    `;
  }

  private renderSlot(slot: SlotStatus, index: number) {
    const slotId = slot.slot;
    const selected = this.selectedSet().has(slotId);
    const runner = slot.runner ? `${slot.runner}/${slot.model ?? 'default'}` : 'default runner';
    const branch = slot.branch || DEFAULT_BRANCH;
    return html`
      <slot-choice-row
        .rank=${selected ? '#1' : `#${index + 1}`}
        .slotId=${slotId}
        .branch=${branch}
        .task=${`${slot.machine} · ${runner}`}
        .lifecycle=${slot.lifecycle}
        .score=${slot.agent ?? 'idle'}
        ?selected=${selected}
        ?disabled=${this.disabled}
        title=${selected ? `Remove ${slotId} from allowed slots` : `Allow ${slotId}`}
        @click=${() => this.toggleSlot(slotId)}
      ></slot-choice-row>
    `;
  }

  render() {
    return html`
      <div class="candidate-list">
        ${this.renderAnyEligible()}
        ${this.slots.length
          ? this.slots.map((slot, index) => this.renderSlot(slot, index))
          : html`<span class="empty">No visible slots for ${this.project}.</span>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-choice-list': SlotChoiceList;
  }
}
