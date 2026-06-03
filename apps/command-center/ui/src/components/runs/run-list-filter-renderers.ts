import { html, nothing } from 'lit';

interface Option<T extends string> {
  label: string;
  value: T;
}

export interface RunListToolbarContext<Tab extends string> {
  totalCount: number;
  tab: Tab;
  activeCount: number;
  manageMode: boolean;
  setTab: (tab: Tab) => void;
  setManageMode: (manageMode: boolean) => void;
  openNewRun: () => void;
}

export function renderRunListToolbar<Tab extends string>(ctx: RunListToolbarContext<Tab>) {
  return html`
    <div class="header">
      <h2>Runs</h2>
      <span class="count">${ctx.totalCount} total</span>
    </div>
    <div class="toolbar">
      <button
        class="tab ${ctx.tab === 'active' ? 'active' : ''}"
        @click=${() => ctx.setTab('active' as Tab)}
      >
        Active${ctx.activeCount > 0 ? ` (${ctx.activeCount})` : ''}
      </button>
      <button
        class="tab ${ctx.tab === 'history' ? 'active' : ''}"
        @click=${() => ctx.setTab('history' as Tab)}
      >
        History
      </button>
      <button
        class="tab ${ctx.tab === 'all' ? 'active' : ''}"
        @click=${() => ctx.setTab('all' as Tab)}
      >
        All
      </button>
      <button
        class="manage-btn ${ctx.manageMode ? 'active' : ''}"
        @click=${() => ctx.setManageMode(!ctx.manageMode)}
      >
        ${ctx.manageMode ? 'Done managing' : 'Manage runs'}
      </button>
      <button class="new-run-btn" @click=${ctx.openNewRun}>+ New Run</button>
    </div>
  `;
}

export interface RunListSearchContext<
  Flow extends string,
  Lane extends string,
  Sort extends string,
> {
  searchQuery: string;
  flowFilter: Flow;
  laneFilter: Lane;
  sortBy: Sort;
  filteredCount: number;
  totalCount: number;
  flowOptions: Option<Flow>[];
  laneOptions: Option<Lane>[];
  sortOptions: Option<Sort>[];
  setSearchQuery: (value: string) => void;
  setFlowFilter: (value: Flow) => void;
  setLaneFilter: (value: Lane) => void;
  setSortBy: (value: Sort) => void;
}

export function renderRunListSearchRow<
  Flow extends string,
  Lane extends string,
  Sort extends string,
>(ctx: RunListSearchContext<Flow, Lane, Sort>) {
  return html`
    <div class="search-row">
      <input
        class="search-input"
        type="text"
        placeholder="Search ticket/PR..."
        .value=${ctx.searchQuery}
        @input=${(event: Event) => {
          ctx.setSearchQuery((event.target as HTMLInputElement).value);
        }}
      />
      <select
        class="filter-select"
        @change=${(event: Event) => {
          ctx.setFlowFilter((event.target as HTMLSelectElement).value as Flow);
        }}
      >
        ${ctx.flowOptions.map(
          (option) =>
            html`<option value=${option.value} ?selected=${ctx.flowFilter === option.value}>
              ${option.label}
            </option>`,
        )}
      </select>
      <select
        class="filter-select"
        @change=${(event: Event) => {
          ctx.setLaneFilter((event.target as HTMLSelectElement).value as Lane);
        }}
      >
        ${ctx.laneOptions.map(
          (option) =>
            html`<option value=${option.value} ?selected=${ctx.laneFilter === option.value}>
              ${option.label}
            </option>`,
        )}
      </select>
      <select
        class="filter-select"
        @change=${(event: Event) => {
          ctx.setSortBy((event.target as HTMLSelectElement).value as Sort);
        }}
      >
        ${ctx.sortOptions.map(
          (option) =>
            html`<option value=${option.value} ?selected=${ctx.sortBy === option.value}>
              ${option.label}
            </option>`,
        )}
      </select>
      <span class="result-count">Showing ${ctx.filteredCount} of ${ctx.totalCount} runs</span>
    </div>
  `;
}

export interface RunListStatusFilterContext<Status extends string> {
  statusFilter: Status;
  statusPills: Option<Status>[];
  familyFilter: string;
  actionInProgress: boolean;
  setStatusFilter: (value: Status) => void;
  clearFamilyFilter: () => void;
  startCleanup: () => void | Promise<void>;
  shortId: (id: string) => string;
}

export function renderRunListStatusFilter<Status extends string>(
  ctx: RunListStatusFilterContext<Status>,
) {
  return html`
    <div class="filter-bar">
      <span class="filter-label">Status:</span>
      ${ctx.statusPills.map(
        (pill) => html`
          <button
            class="pill ${ctx.statusFilter === pill.value ? 'active' : ''}"
            @click=${() => ctx.setStatusFilter(pill.value)}
          >
            ${pill.label}
          </button>
        `,
      )}
      ${ctx.familyFilter
        ? html`
            <button class="pill active" @click=${ctx.clearFamilyFilter}>
              Family ${ctx.shortId(ctx.familyFilter)} ×
            </button>
          `
        : nothing}
      <button
        class="action-btn cleanup"
        style="margin-left: auto"
        ?disabled=${ctx.actionInProgress}
        @click=${ctx.startCleanup}
      >
        Cleanup
      </button>
    </div>
  `;
}

export interface RunListManageBarContext {
  selectedCount: number;
  selectedTerminalCount: number;
  compareAllowed: boolean;
  actionInProgress: boolean;
  selectVisible: () => void;
  selectVisibleTerminal: () => void;
  clearSelection: () => void;
  compareSelected: () => void;
  archiveSelected: () => void | Promise<void>;
  deleteSelected: () => void | Promise<void>;
}

export function renderRunListManageBar(ctx: RunListManageBarContext) {
  return html`
    <div class="actions-bar manage">
      <span
        >${ctx.selectedCount}
        selected${ctx.selectedTerminalCount !== ctx.selectedCount
          ? ` · ${ctx.selectedTerminalCount} terminal`
          : ''}</span
      >
      <button class="action-secondary" @click=${ctx.selectVisible}>Select visible</button>
      <button class="action-secondary" @click=${ctx.selectVisibleTerminal}>
        Select visible terminal
      </button>
      <button
        class="action-secondary"
        ?disabled=${ctx.selectedCount === 0}
        @click=${ctx.clearSelection}
      >
        Clear
      </button>
      ${ctx.selectedCount === 2
        ? html`
            <button
              class="action-btn compare"
              title=${ctx.compareAllowed
                ? 'Compare runs'
                : 'Pick two runs from the same family to compare'}
              ?disabled=${!ctx.compareAllowed}
              @click=${ctx.compareSelected}
            >
              Compare
            </button>
          `
        : nothing}
      <button
        class="action-btn cleanup"
        ?disabled=${ctx.actionInProgress || ctx.selectedTerminalCount === 0}
        @click=${ctx.archiveSelected}
      >
        Archive
      </button>
      <button
        class="action-btn"
        ?disabled=${ctx.actionInProgress || ctx.selectedTerminalCount === 0}
        @click=${ctx.deleteSelected}
      >
        Delete
      </button>
    </div>
  `;
}
