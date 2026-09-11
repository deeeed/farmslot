import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { SlotStatus } from '@farmslot/protocol';

import './slot-choice-list.js';

import type { GlobalFilters } from '../../state.js';
import { colors, fonts, radii, shadows, spacing } from '../../styles/theme-tokens.js';

import { planningChoiceStyles, renderToggleChips } from './planning-controls.js';
import type { SlotChoiceChangeDetail } from './slot-choice-list.js';

export interface SlotSelectorChangeDetail {
  selected: string[];
}

function slotSearchText(slot: SlotStatus): string {
  return [
    slot.slot,
    slot.machine,
    slot.project,
    slot.platform,
    slot.lifecycle,
    slot.phase,
    slot.agent,
    slot.runner,
    slot.model,
    slot.branch,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function byMachineProjectSlot(a: SlotStatus, b: SlotStatus): number {
  return (
    a.machine.localeCompare(b.machine) ||
    a.project.localeCompare(b.project) ||
    a.slot.localeCompare(b.slot)
  );
}

@customElement('slot-selector-modal')
export class SlotSelectorModal extends LitElement {
  @property({ attribute: false }) slots: SlotStatus[] = [];
  @property({ attribute: false }) selected: string[] = [];
  @property({ attribute: false }) filters: GlobalFilters = { projects: [], machines: [] };
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Boolean }) multiple = true;
  @property() project = '';
  @property() heading = 'Select slots';
  @property() description = 'Choose the slots this work may use.';
  @property() clearLabel = 'Clear';
  @property({ type: Boolean }) filterable = false;
  @property({ type: Boolean }) disabled = false;
  @state() private localProjects: string[] = [];
  @state() private localMachines: string[] = [];
  @state() private _query = '';

  private _onKeydown = (event: KeyboardEvent) => {
    if (!this.open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this._setOpen(false);
  };

  static styles = [
    planningChoiceStyles,
    css`
      :host {
        color: ${unsafeCSS(colors.textPrimary)};
        font-family: ${unsafeCSS(fonts.mono)};
      }
      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.72);
        display: grid;
        place-items: center;
        padding: 16px;
        box-sizing: border-box;
      }
      .modal {
        width: min(960px, 100%);
        min-width: 0;
        box-sizing: border-box;
        max-height: 88vh;
        overflow: hidden;
        background: ${unsafeCSS(colors.bgSurface)};
        border: 1px solid ${unsafeCSS(colors.accentDim)};
        border-radius: ${unsafeCSS(radii.lg)};
        box-shadow: ${unsafeCSS(shadows.elevated)};
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr) auto;
      }
      header,
      footer {
        padding: ${unsafeCSS(spacing.lg)};
        border-bottom: 1px solid rgba(85, 85, 112, 0.35);
      }
      footer {
        border-top: 1px solid rgba(85, 85, 112, 0.35);
        border-bottom: 0;
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.md)};
        align-items: center;
      }
      h2,
      p {
        margin: 0;
      }
      h2 {
        font-size: ${unsafeCSS(fonts.sizeLg)};
      }
      .muted {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
      }
      .toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: ${unsafeCSS(spacing.md)};
        padding: 0 ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.lg)};
        border-bottom: 1px solid rgba(85, 85, 112, 0.25);
      }
      input {
        border: 1px solid rgba(85, 85, 112, 0.45);
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgInput)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        padding: 9px 10px;
      }
      .chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
      }
      .chip {
        border: 1px solid rgba(85, 85, 112, 0.5);
        border-radius: 999px;
        color: ${unsafeCSS(colors.textMuted)};
        padding: 3px 8px;
        font-size: ${unsafeCSS(fonts.sizeXs)};
      }
      .body {
        min-height: 0;
        overflow: auto;
        padding: ${unsafeCSS(spacing.lg)};
        display: grid;
        gap: ${unsafeCSS(spacing.md)};
      }
      slot-choice-list {
        --slot-choice-list-max-height: none;
      }
      .empty {
        color: ${unsafeCSS(colors.textMuted)};
        border: 1px dashed rgba(85, 85, 112, 0.5);
        border-radius: ${unsafeCSS(radii.md)};
        padding: ${unsafeCSS(spacing.xxl)};
        text-align: center;
      }
      button {
        border: 1px solid ${unsafeCSS(colors.accent)}66;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.accent)}22;
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        padding: 8px 10px;
        cursor: pointer;
      }
      button.secondary {
        border-color: rgba(85, 85, 112, 0.45);
        background: ${unsafeCSS(colors.bgCard)};
      }
      @media (max-width: 600px) {
        .backdrop {
          padding: 8px;
        }
        .modal {
          max-height: calc(100dvh - 16px);
        }
        header,
        footer,
        .body {
          padding: 12px;
        }
        footer {
          flex-wrap: wrap;
        }
      }
    `,
  ];

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKeydown);
    super.disconnectedCallback();
  }

  private get _visibleSlots(): SlotStatus[] {
    const query = this._query.trim().toLowerCase();
    return this.slots
      .filter((slot) => {
        if (this.project && slot.project !== this.project) return false;
        if (this.filters.projects.length > 0 && !this.filters.projects.includes(slot.project)) {
          return false;
        }
        if (this.filters.machines.length > 0 && !this.filters.machines.includes(slot.machine)) {
          return false;
        }
        if (
          this.filterable &&
          this.localProjects.length &&
          !this.localProjects.includes(slot.project)
        )
          return false;
        if (
          this.filterable &&
          this.localMachines.length &&
          !this.localMachines.includes(slot.machine)
        )
          return false;
        if (query && !slotSearchText(slot).includes(query)) return false;
        return true;
      })
      .sort(byMachineProjectSlot);
  }

  private _setOpen(open: boolean): void {
    this.open = open;
    if (!open)
      this.dispatchEvent(new CustomEvent('slot-selector-close', { bubbles: true, composed: true }));
  }

  private _applyChoice(event: CustomEvent<SlotChoiceChangeDetail>): void {
    if (this.disabled) return;
    const selected = event.detail.allowedSlots ?? [];
    this.dispatchEvent(
      new CustomEvent<SlotSelectorChangeDetail>('slot-selector-change', {
        bubbles: true,
        composed: true,
        detail: { selected },
      }),
    );
  }

  private _clear(): void {
    if (this.disabled) return;
    this.dispatchEvent(
      new CustomEvent<SlotSelectorChangeDetail>('slot-selector-change', {
        bubbles: true,
        composed: true,
        detail: { selected: [] },
      }),
    );
  }

  private _renderFilterChips() {
    const chips = [
      this.project ? `project: ${this.project}` : '',
      ...this.filters.projects.map((project) => `global project: ${project}`),
      ...this.filters.machines.map((machine) => `node: ${machine}`),
    ].filter(Boolean);
    return chips.length === 0
      ? html`<span class="chip">all projects</span><span class="chip">all nodes</span>`
      : chips.map((chip) => html`<span class="chip">${chip}</span>`);
  }

  render() {
    if (!this.open) return nothing;
    const slots = this._visibleSlots;
    return html`
      <div
        class="backdrop"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this._setOpen(false);
        }}
      >
        <section class="modal" role="dialog" aria-modal="true" aria-label=${this.heading}>
          <header>
            <h2>${this.heading}</h2>
            <p class="muted">${this.description}</p>
          </header>
          <div class="toolbar">
            <input
              placeholder="Search slot, node, project, runner…"
              .value=${this._query}
              @input=${(event: Event) => (this._query = (event.target as HTMLInputElement).value)}
            />
            <div class="chips">${this._renderFilterChips()}</div>
            ${this.filterable
              ? html`<details>
                  <summary>Filter by farm or machine</summary>
                  <p class="muted">Farms</p>
                  ${renderToggleChips({
                    options: [...new Set(this.slots.map((s) => s.project))].sort(),
                    selected: this.localProjects,
                    onToggle: (value) => {
                      this.localProjects = this.localProjects.includes(value)
                        ? this.localProjects.filter((p) => p !== value)
                        : [...this.localProjects, value];
                    },
                    testId: 'slot-picker-projects',
                  })}
                  <p class="muted">Machines</p>
                  ${renderToggleChips({
                    options: [...new Set(this.slots.map((s) => s.machine))].sort(),
                    selected: this.localMachines,
                    onToggle: (value) => {
                      this.localMachines = this.localMachines.includes(value)
                        ? this.localMachines.filter((p) => p !== value)
                        : [...this.localMachines, value];
                    },
                    testId: 'slot-picker-machines',
                  })}
                </details>`
              : nothing}
          </div>
          <div class="body">
            ${slots.length === 0
              ? html`<div class="empty">
                  No slots match the current project and global filters.
                </div>`
              : html`<slot-choice-list
                  .slots=${slots}
                  .disabled=${this.disabled}
                  .selectedSlots=${this.selected}
                  .project=${this.project}
                  .showAnyEligible=${false}
                  .grouped=${true}
                  selectionMode=${this.multiple ? 'multiple' : 'single'}
                  @slot-choice-change=${this._applyChoice}
                ></slot-choice-list>`}
          </div>
          <footer>
            <span class="muted">${this.selected.length} selected</span>
            <div class="chips">
              <button class="secondary" ?disabled=${this.disabled} @click=${this._clear}>
                ${this.clearLabel}
              </button>
              <button data-testid="slot-selector-done" @click=${() => this._setOpen(false)}>
                Done (Esc)
              </button>
            </div>
          </footer>
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-selector-modal': SlotSelectorModal;
  }
}
