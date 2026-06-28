import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { SlotStatus } from '@farmslot/protocol';

import { projectMatchesGlobalFilter } from '../../project-filter.js';
import type { GlobalFilters } from '../../state.js';
import {
  colors,
  fonts,
  lifecycleColor,
  radii,
  shadows,
  spacing,
} from '../../styles/theme-tokens.js';

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
  @state() private _query = '';

  static styles = css`
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
      padding: ${unsafeCSS(spacing.xxl)};
    }
    .modal {
      width: min(960px, 96vw);
      max-height: 88vh;
      overflow: hidden;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.accentDim)};
      border-radius: ${unsafeCSS(radii.lg)};
      box-shadow: ${unsafeCSS(shadows.elevated)};
      display: grid;
      grid-template-rows: auto auto 1fr auto;
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
      grid-template-columns: minmax(220px, 1fr) auto;
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
      overflow: auto;
      padding: ${unsafeCSS(spacing.lg)};
      display: grid;
      gap: ${unsafeCSS(spacing.md)};
    }
    .group {
      display: grid;
      gap: ${unsafeCSS(spacing.sm)};
    }
    .group-title {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: ${unsafeCSS(spacing.sm)};
    }
    .slot {
      text-align: left;
      border: 1px solid rgba(85, 85, 112, 0.45);
      border-left: 4px solid var(--slot-color);
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textPrimary)};
      padding: ${unsafeCSS(spacing.md)};
      cursor: pointer;
      display: grid;
      gap: 6px;
      font: inherit;
    }
    .slot:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .slot.selected {
      border-color: ${unsafeCSS(colors.accentHover)};
      box-shadow: 0 0 0 1px ${unsafeCSS(colors.accentHover)};
    }
    .slot.disabled {
      opacity: 0.55;
    }
    .slot-head {
      display: flex;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
    }
    .slot-id {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .pill {
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
      color: ${unsafeCSS(colors.textMuted)};
      padding: 2px 7px;
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .meta {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      line-height: 1.45;
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
  `;

  private get _visibleSlots(): SlotStatus[] {
    const query = this._query.trim().toLowerCase();
    return this.slots
      .filter((slot) => {
        if (this.project && slot.project !== this.project) return false;
        if (
          this.filters.projects.length > 0 &&
          !projectMatchesGlobalFilter(slot.project, this.filters.projects)
        ) {
          return false;
        }
        if (this.filters.machines.length > 0 && !this.filters.machines.includes(slot.machine)) {
          return false;
        }
        if (query && !slotSearchText(slot).includes(query)) return false;
        return true;
      })
      .sort(byMachineProjectSlot);
  }

  private _groups(): Array<{ key: string; slots: SlotStatus[] }> {
    const groups = new Map<string, SlotStatus[]>();
    for (const slot of this._visibleSlots) {
      const key = `${slot.machine} / ${slot.project}`;
      groups.set(key, [...(groups.get(key) ?? []), slot]);
    }
    return [...groups.entries()].map(([key, slots]) => ({ key, slots }));
  }

  private _setOpen(open: boolean): void {
    this.open = open;
    if (!open)
      this.dispatchEvent(new CustomEvent('slot-selector-close', { bubbles: true, composed: true }));
  }

  private _toggleSlot(slotId: string): void {
    const current = new Set(this.selected);
    if (this.multiple) {
      if (current.has(slotId)) current.delete(slotId);
      else current.add(slotId);
    } else {
      current.clear();
      current.add(slotId);
    }
    const selected = [...current].sort();
    this.dispatchEvent(
      new CustomEvent<SlotSelectorChangeDetail>('slot-selector-change', {
        bubbles: true,
        composed: true,
        detail: { selected },
      }),
    );
  }

  private _clear(): void {
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
    const selectedSet = new Set(this.selected);
    const groups = this._groups();
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
            <p class="muted">Choose the exact slots this backlog item may dispatch to.</p>
          </header>
          <div class="toolbar">
            <input
              placeholder="Search slot, node, project, runner…"
              .value=${this._query}
              @input=${(event: Event) => (this._query = (event.target as HTMLInputElement).value)}
            />
            <div class="chips">${this._renderFilterChips()}</div>
          </div>
          <div class="body">
            ${groups.length === 0
              ? html`<div class="empty">
                  No slots match the current project and global filters.
                </div>`
              : groups.map(
                  (group) => html`
                    <section class="group">
                      <div class="group-title">${group.key}</div>
                      <div class="grid">
                        ${group.slots.map((slot) => {
                          const selected = selectedSet.has(slot.slot);
                          const color = lifecycleColor(slot.lifecycle);
                          return html`
                            <button
                              type="button"
                              class="slot ${selected ? 'selected' : ''} ${!slot.dispatchable ||
                              !slot.enabled
                                ? 'disabled'
                                : ''}"
                              style=${`--slot-color: ${color}`}
                              @click=${() => this._toggleSlot(slot.slot)}
                            >
                              <span class="slot-head">
                                <span class="slot-id">${slot.slot}</span>
                                <span class="pill">${selected ? 'selected' : slot.lifecycle}</span>
                              </span>
                              <span class="meta"
                                >${slot.machine} · ${slot.platform} · ${slot.agent}</span
                              >
                              <span class="meta"
                                >${slot.runner ?? 'no runner'} / ${slot.model ?? 'no model'}</span
                              >
                              <span class="meta">${slot.branch || 'no branch'}</span>
                            </button>
                          `;
                        })}
                      </div>
                    </section>
                  `,
                )}
          </div>
          <footer>
            <span class="muted">${this.selected.length} selected</span>
            <div class="chips">
              <button class="secondary" @click=${this._clear}>Clear</button>
              <button @click=${() => this._setOpen(false)}>Done</button>
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
