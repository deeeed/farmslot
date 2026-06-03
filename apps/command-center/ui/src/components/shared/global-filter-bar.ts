import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { SlotStatus } from '@farmslot/protocol';

import { type AppState, getState, subscribe, updateGlobalFilters } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';

@customElement('global-filter-bar')
export class GlobalFilterBar extends LitElement {
  @property({ attribute: false }) slots: SlotStatus[] = [];

  @state() private selectedProjects: string[] = [];
  @state() private selectedMachines: string[] = [];

  private _unsub?: () => void;

  static styles = css`
    :host {
      display: block;
    }
    .filter-bar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: 6px ${unsafeCSS(spacing.xl)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 11px;
      color: ${unsafeCSS(colors.textSecondary)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
      flex-shrink: 0;
      flex-wrap: wrap;
      min-height: 32px;
      box-sizing: border-box;
    }
    .label {
      color: ${unsafeCSS(colors.textMuted)};
      white-space: nowrap;
    }
    .chips {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .chip {
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font-family: inherit;
      font-size: 10px;
      line-height: 1.4;
      transition:
        border-color 0.1s,
        background 0.1s,
        color 0.1s;
    }
    .chip:hover {
      border-color: ${unsafeCSS(colors.accent)}66;
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .chip.active {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .sep {
      color: ${unsafeCSS(colors.textMuted)};
      margin: 0 2px;
    }
    .clear-btn {
      margin-left: auto;
      background: transparent;
      border: none;
      color: ${unsafeCSS(colors.textMuted)};
      cursor: pointer;
      font-family: inherit;
      font-size: 10px;
      padding: 2px 4px;
      text-decoration: underline;
    }
    .clear-btn:hover {
      color: ${unsafeCSS(colors.textSecondary)};
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._syncFromState(getState());
    this._unsub = subscribe((s) => this._syncFromState(s));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub?.();
  }

  private _syncFromState(s: AppState) {
    this.selectedProjects = s.globalFilters.projects;
    this.selectedMachines = s.globalFilters.machines;
  }

  private _commit(): void {
    updateGlobalFilters({
      projects: this.selectedProjects,
      machines: this.selectedMachines,
    });
  }

  // Derive available projects: if machines selected, only show projects on those machines
  private get availableProjects(): string[] {
    const source =
      this.selectedMachines.length > 0
        ? this.slots.filter((s) => this.selectedMachines.includes(s.machine))
        : this.slots;
    return [...new Set(source.map((s) => s.project))].sort();
  }

  // Derive available machines: if projects selected, only show machines that have those projects
  private get availableMachines(): string[] {
    const source =
      this.selectedProjects.length > 0
        ? this.slots.filter((s) => this.selectedProjects.includes(s.project))
        : this.slots;
    return [...new Set(source.map((s) => s.machine))].sort();
  }

  private _toggleProject(project: string) {
    this.selectedProjects = this.selectedProjects.includes(project)
      ? this.selectedProjects.filter((p) => p !== project)
      : [...this.selectedProjects, project];
    this._commit();
  }

  private _toggleMachine(machine: string) {
    this.selectedMachines = this.selectedMachines.includes(machine)
      ? this.selectedMachines.filter((m) => m !== machine)
      : [...this.selectedMachines, machine];
    this._commit();
  }

  private _clearAll() {
    this.selectedProjects = [];
    this.selectedMachines = [];
    this._commit();
  }

  private get hasFilters(): boolean {
    return this.selectedProjects.length > 0 || this.selectedMachines.length > 0;
  }

  render() {
    const projects = this.availableProjects;
    const machines = this.availableMachines;

    return html`
      <div class="filter-bar">
        <span class="label">Projects:</span>
        <div class="chips">
          ${projects.map(
            (p) => html`
              <button
                class="chip ${this.selectedProjects.includes(p) ? 'active' : ''}"
                @click=${() => this._toggleProject(p)}
              >
                ${p}
              </button>
            `,
          )}
        </div>
        <span class="sep">|</span>
        <span class="label">Machines:</span>
        <div class="chips">
          ${machines.map(
            (m) => html`
              <button
                class="chip ${this.selectedMachines.includes(m) ? 'active' : ''}"
                @click=${() => this._toggleMachine(m)}
              >
                ${m}
              </button>
            `,
          )}
        </div>
        ${this.hasFilters
          ? html` <button class="clear-btn" @click=${this._clearAll}>Clear</button> `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'global-filter-bar': GlobalFilterBar;
  }
}
