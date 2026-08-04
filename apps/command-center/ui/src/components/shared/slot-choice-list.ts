import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { DEFAULT_BRANCH, type SlotStatus } from '@farmslot/protocol';

import './slot-choice-row.js';

import { colors, fonts } from '../../styles/theme-tokens.js';

export interface SlotChoiceChangeDetail {
  allowedSlots: string[] | null;
}

export type SlotChoiceTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent';

export interface SlotChoiceBadge {
  label: string;
  title?: string;
  tone?: SlotChoiceTone;
}

export interface SlotChoiceAction extends SlotChoiceBadge {
  id: string;
  active?: boolean;
  disabled?: boolean;
}

export interface SlotChoiceOption {
  slotId: string;
  branch: string;
  task?: string;
  lifecycle: string;
  state?: string;
  stateSortValue?: string | number;
  rank?: string;
  group?: string;
  disabled?: boolean;
  stale?: boolean;
  warning?: boolean;
  title?: string;
  badges?: readonly SlotChoiceBadge[];
  details?: readonly SlotChoiceBadge[];
  actions?: readonly SlotChoiceAction[];
}

export interface SlotChoiceActionDetail {
  slotId: string;
  actionId: string;
}

type SlotChoiceSortKey = 'rank' | 'slot' | 'branch' | 'lifecycle' | 'state';
type SlotChoiceSortDirection = 'asc' | 'desc';

@customElement('slot-choice-list')
export class SlotChoiceList extends LitElement {
  @property({ attribute: false }) slots: readonly SlotStatus[] = [];
  @property({ attribute: false }) options: readonly SlotChoiceOption[] = [];
  @property({ attribute: false }) selectedSlots: readonly string[] = [];
  @property({ type: String }) project = '';
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) showAnyEligible = true;
  @property({ type: Boolean }) grouped = false;
  @property({ type: String }) selectionMode: 'single' | 'multiple' = 'multiple';
  @property({ type: String }) secondaryLabel = 'Worker';
  @state() private sortKey: SlotChoiceSortKey = 'rank';
  @state() private sortDirection: SlotChoiceSortDirection = 'asc';

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
      max-height: var(--slot-choice-list-max-height, min(420px, 46vh));
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-right: 4px;
      scrollbar-gutter: stable;
    }

    .choice-header {
      align-items: center;
      border-bottom: 1px solid #2a2a44;
      color: ${unsafeCSS(colors.textMuted)};
      display: grid;
      font-size: 9px;
      gap: 10px;
      grid-template-columns: 44px 132px minmax(0, 1fr) var(--slot-choice-meta-width, 200px);
      letter-spacing: 0.05em;
      padding: 4px 14px 5px 10px;
      text-transform: uppercase;
    }

    .choice-header-meta {
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(66px, auto) minmax(46px, auto) minmax(0, 1fr);
    }

    .sort-button {
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      padding: 0;
      text-align: left;
      text-transform: inherit;
      white-space: nowrap;
    }

    .sort-button:hover,
    .sort-button.active {
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .sort-button.active::after {
      content: var(--sort-arrow);
      margin-left: 4px;
    }

    .choice-group {
      display: grid;
      gap: 2px;
    }

    .choice-group + .choice-group {
      margin-top: 6px;
    }

    .choice-group-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      letter-spacing: 0.05em;
      padding: 5px 4px 2px;
      text-transform: uppercase;
    }

    .choice-badge,
    .choice-detail {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a44;
      border-radius: 3px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 9px;
      padding: 1px 5px;
      white-space: nowrap;
    }

    .choice-badge.positive,
    .choice-detail.positive {
      border-color: ${unsafeCSS(colors.statusOk)}66;
      color: ${unsafeCSS(colors.statusOk)};
    }

    .choice-badge.warning,
    .choice-detail.warning {
      border-color: ${unsafeCSS(colors.statusWarn)}88;
      color: ${unsafeCSS(colors.statusWarn)};
    }

    .choice-badge.danger,
    .choice-detail.danger {
      border-color: ${unsafeCSS(colors.statusFail)}88;
      color: ${unsafeCSS(colors.statusFail)};
    }

    .choice-badge.accent,
    .choice-detail.accent {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.accent)};
    }

    .choice-details,
    .choice-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .choice-details {
      margin-top: 2px;
    }

    .choice-action {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a44;
      border-radius: 3px;
      color: ${unsafeCSS(colors.textSecondary)};
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      padding: 2px 8px;
    }

    .choice-action:hover:not(:disabled),
    .choice-action.active {
      border-color: ${unsafeCSS(colors.accent)};
      color: ${unsafeCSS(colors.accent)};
    }

    .choice-action.active {
      background: ${unsafeCSS(colors.accent)}22;
    }

    .choice-action:disabled {
      cursor: not-allowed;
      opacity: 0.45;
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

  private setSort(key: SlotChoiceSortKey) {
    if (this.sortKey === key) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }
    this.sortKey = key;
    this.sortDirection = 'asc';
  }

  private renderSortButton(key: SlotChoiceSortKey, label: string) {
    const active = this.sortKey === key;
    const arrow = this.sortDirection === 'asc' ? '"▲"' : '"▼"';
    return html`<button
      type="button"
      class="sort-button ${active ? 'active' : ''}"
      style=${active ? `--sort-arrow:${arrow}` : ''}
      aria-label=${`Sort by ${label}`}
      @click=${() => this.setSort(key)}
    >
      ${label}
    </button>`;
  }

  private renderHeader() {
    return html`<div class="choice-header" role="row">
      ${this.renderSortButton('rank', 'Rank')} ${this.renderSortButton('slot', 'Slot')}
      ${this.renderSortButton('branch', 'Branch / task')}
      <span class="choice-header-meta">
        ${this.renderSortButton('lifecycle', 'Lifecycle')}
        ${this.renderSortButton('state', this.secondaryLabel)}
      </span>
    </div>`;
  }

  private toggleSlot(slotId: string) {
    if (this.selectionMode === 'single') {
      this.emitAllowedSlots([slotId]);
      return;
    }
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
        .score=${''}
        ?selected=${selected}
        ?disabled=${this.disabled}
        @click=${() => this.emitAllowedSlots(null)}
      ></slot-choice-row>
    `;
  }

  private slotOptions(): SlotChoiceOption[] {
    if (this.options.length > 0) return [...this.options];
    return this.slots.map((slot) => ({
      slotId: slot.slot,
      branch: slot.branch || DEFAULT_BRANCH,
      task: `${slot.machine} · ${slot.runner ? `${slot.runner}/${slot.model ?? 'default'}` : 'default runner'}`,
      lifecycle: slot.lifecycle,
      state: slot.agent ?? 'idle',
      group: this.grouped ? `${slot.machine} / ${slot.project}` : undefined,
    }));
  }

  private sortedOptions(options: readonly SlotChoiceOption[]): SlotChoiceOption[] {
    if (this.sortKey === 'rank') {
      return this.sortDirection === 'asc' ? [...options] : [...options].reverse();
    }
    const value = (option: SlotChoiceOption): string | number => {
      if (this.sortKey === 'slot') return option.slotId;
      if (this.sortKey === 'branch') return `${option.branch} ${option.task ?? ''}`;
      if (this.sortKey === 'lifecycle') return option.lifecycle;
      return option.stateSortValue ?? option.state ?? '';
    };
    const direction = this.sortDirection === 'asc' ? 1 : -1;
    return [...options].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      const comparison =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
      return comparison * direction;
    });
  }

  private renderBadge(badge: SlotChoiceBadge, className: 'choice-badge' | 'choice-detail') {
    return html`<span class="${className} ${badge.tone ?? 'neutral'}" title=${badge.title ?? ''}
      >${badge.label}</span
    >`;
  }

  private emitAction(event: Event, slotId: string, actionId: string) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<SlotChoiceActionDetail>('slot-choice-action', {
        detail: { slotId, actionId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderOption(option: SlotChoiceOption, index: number) {
    const slotId = option.slotId;
    const selected = this.selectedSet().has(slotId);
    return html`
      <slot-choice-row
        .rank=${option.rank ?? (selected ? '#1' : `#${index + 1}`)}
        .slotId=${slotId}
        .branch=${option.branch || DEFAULT_BRANCH}
        .task=${option.task ?? ''}
        .lifecycle=${option.lifecycle}
        .score=${option.state ?? ''}
        ?selected=${selected}
        ?disabled=${this.disabled || option.disabled}
        ?stale=${option.stale}
        ?warning=${option.warning}
        title=${option.title ??
        (selected ? `Remove ${slotId} from allowed slots` : `Allow ${slotId}`)}
        @click=${() => this.toggleSlot(slotId)}
      >
        ${(option.badges ?? []).map(
          (badge) => html`<span slot="badges">${this.renderBadge(badge, 'choice-badge')}</span>`,
        )}
        ${option.details?.length
          ? html`<span slot="summary-extra" class="choice-details"
              >${option.details.map((detail) => this.renderBadge(detail, 'choice-detail'))}</span
            >`
          : nothing}
        ${option.actions?.length
          ? html`<span slot="actions" class="choice-actions">
              ${option.actions.map(
                (action) =>
                  html`<button
                    type="button"
                    class="choice-action ${action.active ? 'active' : ''}"
                    title=${action.title ?? ''}
                    ?disabled=${action.disabled}
                    @click=${(event: Event) => this.emitAction(event, slotId, action.id)}
                  >
                    ${action.label}
                  </button>`,
              )}
            </span>`
          : nothing}
      </slot-choice-row>
    `;
  }

  private renderChoiceOptions(options: readonly SlotChoiceOption[]) {
    if (!this.grouped) return options.map((option, index) => this.renderOption(option, index));
    const groups = new Map<string, SlotChoiceOption[]>();
    for (const option of options) {
      const group = option.group ?? 'Slots';
      groups.set(group, [...(groups.get(group) ?? []), option]);
    }
    let index = 0;
    return [...groups.entries()].map(
      ([group, groupOptions]) =>
        html`<section class="choice-group">
          <div class="choice-group-label">${group}</div>
          ${groupOptions.map((option) => this.renderOption(option, index++))}
        </section>`,
    );
  }

  render() {
    const options = this.sortedOptions(this.slotOptions());
    return html`
      ${this.renderHeader()}
      <div class="candidate-list">
        ${this.showAnyEligible ? this.renderAnyEligible() : nothing}
        ${options.length
          ? this.renderChoiceOptions(options)
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
