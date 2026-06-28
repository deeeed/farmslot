import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import type {
  FleetStatus,
  RunListResult,
  SlotStatus,
  TmuxWorkerInventoryUpdatedPayload,
  TmuxWorkerListResult,
  TmuxWorkerRef,
  TmuxWorkerSummary,
  TmuxWorkerWatchEntry,
  TmuxWorkerWatchItem,
} from '@farmslot/protocol';
import {
  Events,
  flattenTmuxWorkers,
  isTmuxWorkerWatched,
  Methods,
  reconcileTmuxWorkerWatchlist,
  removeTmuxWorkerWatchItem,
  tmuxWorkerRefsMatch,
  upsertTmuxWorkerWatchItem,
} from '@farmslot/protocol';

import './terminal-view.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { isSlotPinned, togglePinnedSlot } from '../../utils/pinned-slots.js';

import {
  filterSlotsByGlobalFilters,
  isFarmslotWatchEntry,
  isFarmslotWorker,
  isWorkerPaneFilter,
  LAYOUT_KEY,
  type LayoutMode,
  parseWatchItems,
  parseWorkerRefs,
  selectActiveRunSlotIds,
  STORAGE_KEY,
  type TerminalPane,
  watchEntryDescription,
  watchEntryTitle,
  WORKER_FILTER_KEY,
  WORKER_PANES_KEY,
  WORKER_WATCHLIST_KEY,
  workerDescription,
  type WorkerPaneFilter,
  workerTitle,
} from './split-view-model.js';

@customElement('terminal-split-view')
export class TerminalSplitView extends LitElement {
  @property({ type: String }) initialSlot = '';

  @state() private _availableSlots: string[] = [];
  @state() private _selectedSlots: string[] = [];
  @state() private _selectedWorkers: TmuxWorkerRef[] = [];
  @state() private _layout: LayoutMode = 'auto';
  @state() private _expandedSlot: string | null = null;
  @state() private _hydrating = false;
  @state() private _tmuxWorkers: TmuxWorkerSummary[] = [];
  @state() private _workerWatchItems: TmuxWorkerWatchItem[] = [];
  @state() private _workerListError = '';
  @state() private _workerPaneFilter: WorkerPaneFilter = 'adhoc';

  private _unsubFleet?: () => void;
  private _unsubTmuxWorkerUpdated?: () => void;
  private _unsubState?: () => void;
  private _tmuxWorkerFetchSeq = 0;
  private _globalFilters: AppState['globalFilters'] = { projects: [], machines: [] };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: ${unsafeCSS(colors.bgBase)};
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .toolbar-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .slot-select {
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      outline: none;
      min-width: 160px;
    }

    .slot-select:focus {
      border-color: ${unsafeCSS(colors.accent)};
    }
    .slot-select option {
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .slot-selector-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .close-slot-btn {
      background: transparent;
      border: 1px solid transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 12px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: ${unsafeCSS(radii.sm)};
      line-height: 1;
    }
    .close-slot-btn:hover {
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)}44;
      background: ${unsafeCSS(colors.statusFail)}12;
    }

    .layout-btns {
      display: flex;
      gap: 2px;
      margin-left: auto;
    }

    .layout-btn {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      border: 1px solid #1e1e36;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }

    .layout-btn:first-child {
      border-radius: ${unsafeCSS(radii.sm)} 0 0 ${unsafeCSS(radii.sm)};
    }
    .layout-btn:last-child {
      border-radius: 0 ${unsafeCSS(radii.sm)} ${unsafeCSS(radii.sm)} 0;
    }

    .layout-btn.active {
      background: ${unsafeCSS(colors.accent)};
      color: #fff;
      border-color: ${unsafeCSS(colors.accent)};
    }

    .grid {
      flex: 1;
      display: grid;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      min-height: 0;
    }

    .grid.expanded {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr;
    }

    terminal-view {
      min-height: 0;
    }

    .empty-slot {
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px dashed #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }

    .worker-panel {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.sm)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgBase)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .worker-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
    }

    .worker-panel-title {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .worker-panel-hint {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .worker-filter-row {
      display: flex;
      gap: 2px;
      align-items: center;
      flex-wrap: wrap;
    }

    .worker-filter-btn {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      border: 1px solid #1e1e36;
      border-radius: ${unsafeCSS(radii.sm)};
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
    }

    .worker-filter-btn.active {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}66;
    }

    .worker-list {
      display: flex;
      gap: ${unsafeCSS(spacing.sm)};
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .worker-chip {
      display: grid;
      grid-template-columns: auto minmax(160px, 1fr) auto auto;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      min-width: 340px;
      max-width: 520px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }

    .worker-chip.live {
      border-color: ${unsafeCSS(colors.statusOk)}55;
    }

    .worker-chip.needs-attention {
      border-color: ${unsafeCSS(colors.statusWarn)}aa;
      box-shadow: 0 0 0 1px ${unsafeCSS(colors.statusWarn)}22;
    }

    .worker-chip.stale {
      opacity: 0.7;
    }

    .worker-chip-title {
      color: ${unsafeCSS(colors.textPrimary)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .worker-chip-meta {
      color: ${unsafeCSS(colors.textMuted)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      grid-column: 2 / 5;
    }

    .worker-chip-btn {
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 2px 6px;
    }

    .worker-chip-btn:hover,
    .worker-chip-btn.active {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}66;
      background: ${unsafeCSS(colors.accent)}12;
    }

    .worker-chip-btn.pinned {
      color: ${unsafeCSS(colors.statusWarn)};
      border-color: ${unsafeCSS(colors.statusWarn)}66;
      background: ${unsafeCSS(colors.statusWarn)}12;
    }

    .worker-error {
      color: ${unsafeCSS(colors.statusWarn)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (
      changed.has('initialSlot') &&
      this.initialSlot &&
      !this._selectedSlots.includes(this.initialSlot)
    ) {
      this._selectedSlots = [
        this.initialSlot,
        ...this._selectedSlots.slice(0, this._maxSlots() - 1),
      ];
      this._save();
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadSaved();
    this._fetchSlots();
    this._fetchTmuxWorkers();
    const initial = getState();
    this._globalFilters = initial.globalFilters;
    this._hydrating = isHydrating(initial, 'fleet');
    this._unsubFleet = gateway.subscribe(Events.FLEET_UPDATED, (payload: unknown) => {
      const fleet = payload as FleetStatus;
      this._availableSlots = this._applyFilters(fleet.slots).map((s) => s.slot);
    });
    this._unsubTmuxWorkerUpdated = gateway.subscribe<TmuxWorkerInventoryUpdatedPayload>(
      Events.TMUX_WORKER_INVENTORY_UPDATED,
      (payload) => {
        this._tmuxWorkers = flattenTmuxWorkers(payload.result.nodes);
        this._workerWatchItems = reconcileTmuxWorkerWatchlist(
          this._workerWatchItems,
          this._tmuxWorkers,
        ).map((entry) => entry.item);
      },
    );
    this._unsubState = subscribe((s: AppState) => {
      this._globalFilters = s.globalFilters;
      this._hydrating = isHydrating(s, 'fleet');
      if (s.fleet) {
        this._availableSlots = this._applyFilters(s.fleet.slots).map((slot) => slot.slot);
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubFleet?.();
    this._unsubTmuxWorkerUpdated?.();
    this._unsubState?.();
  }

  private _loadSaved() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) this._selectedSlots = parsed;
      }
      this._selectedWorkers = parseWorkerRefs(localStorage.getItem(WORKER_PANES_KEY));
      this._workerWatchItems = parseWatchItems(localStorage.getItem(WORKER_WATCHLIST_KEY));
      const workerFilter = localStorage.getItem(WORKER_FILTER_KEY);
      if (isWorkerPaneFilter(workerFilter)) this._workerPaneFilter = workerFilter;
      const layout = localStorage.getItem(LAYOUT_KEY);
      const validLayouts: LayoutMode[] = ['auto', '1x1', '2x1', '2x2', '3x2', '4x2'];
      if (validLayouts.includes(layout as LayoutMode)) {
        this._layout = layout as LayoutMode;
      }
    } catch (err) {
      // Local terminal layout preferences are recoverable. Clear only the
      // terminal preferences so a corrupt browser cache cannot break the page.
      console.warn('[terminal-split-view] resetting corrupt local terminal preferences', err);
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(WORKER_PANES_KEY);
      localStorage.removeItem(WORKER_WATCHLIST_KEY);
      localStorage.removeItem(WORKER_FILTER_KEY);
      this._selectedSlots = [];
      this._selectedWorkers = [];
      this._workerWatchItems = [];
    }
  }

  private _save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._selectedSlots));
    localStorage.setItem(WORKER_PANES_KEY, JSON.stringify(this._selectedWorkers));
    localStorage.setItem(LAYOUT_KEY, this._layout);
    localStorage.setItem(WORKER_FILTER_KEY, this._workerPaneFilter);
  }

  private _saveWatchItems(items: TmuxWorkerWatchItem[]) {
    this._workerWatchItems = items;
    localStorage.setItem(WORKER_WATCHLIST_KEY, JSON.stringify(items));
  }

  private async _fetchSlots() {
    try {
      const result = await gateway.request<{ fleet: FleetStatus }>(Methods.FLEET_STATUS, {});
      this._availableSlots = this._applyFilters(result.fleet.slots).map((s) => s.slot);
    } catch (err) {
      console.warn('[terminal-split-view] failed to refresh fleet slots', err);
    }
  }

  private async _fetchTmuxWorkers() {
    const fetchSeq = (this._tmuxWorkerFetchSeq += 1);
    try {
      const result = await gateway.request<TmuxWorkerListResult>(Methods.TMUX_WORKER_LIST, {
        includeDisconnected: true,
      });
      if (fetchSeq !== this._tmuxWorkerFetchSeq) return;
      this._tmuxWorkers = flattenTmuxWorkers(result.nodes);
      this._workerWatchItems = reconcileTmuxWorkerWatchlist(
        this._workerWatchItems,
        this._tmuxWorkers,
      ).map((entry) => entry.item);
      localStorage.setItem(WORKER_WATCHLIST_KEY, JSON.stringify(this._workerWatchItems));
      this._workerListError = '';
    } catch (err) {
      if (fetchSeq !== this._tmuxWorkerFetchSeq) return;
      this._workerListError = err instanceof Error ? err.message : String(err);
    }
  }

  private _applyFilters(slots: SlotStatus[]): SlotStatus[] {
    return filterSlotsByGlobalFilters(slots, this._globalFilters);
  }

  private _currentRunIdForSlot(slotId: string): string {
    return getState().fleet?.slots.find((slot) => slot.slot === slotId)?.currentRunId ?? '';
  }

  private _resolvedLayout(
    paneCount = this._selectedSlots.filter(Boolean).length || 1,
  ): Exclude<LayoutMode, 'auto'> {
    if (this._layout !== 'auto') return this._layout;
    const n = paneCount || 1;
    if (n <= 1) return '1x1';
    if (n <= 2) return '2x1';
    if (n <= 4) return '2x2';
    if (n <= 6) return '3x2';
    return '4x2';
  }

  private _gridStyle(paneCount?: number): string {
    const layout = this._resolvedLayout(paneCount);
    switch (layout) {
      case '1x1':
        return 'grid-template-columns: 1fr; grid-template-rows: 1fr;';
      case '2x1':
        return 'grid-template-columns: 1fr 1fr; grid-template-rows: 1fr;';
      case '2x2':
        return 'grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;';
      case '3x2':
        return 'grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr;';
      case '4x2':
        return 'grid-template-columns: repeat(4, 1fr); grid-template-rows: 1fr 1fr;';
    }
  }

  private _maxSlots(): number {
    switch (this._layout) {
      case 'auto':
        return 8;
      case '1x1':
        return 1;
      case '2x1':
        return 2;
      case '2x2':
        return 4;
      case '3x2':
        return 6;
      case '4x2':
        return 8;
    }
  }

  private async _showActiveRuns() {
    try {
      const [fleetResult, runResult] = await Promise.all([
        gateway.request<{ fleet: FleetStatus }>(Methods.FLEET_STATUS, {}),
        gateway.request<RunListResult>(Methods.RUN_LIST, { active: true, limit: 1000 }),
      ]);
      const activeRuns = selectActiveRunSlotIds(
        fleetResult.fleet.slots,
        runResult.runs ?? [],
        this._globalFilters,
      );
      this._selectedSlots = activeRuns;
      this._selectedWorkers = [];
      this._layout = 'auto';
      this._expandedSlot = null;
      this._save();
    } catch (err) {
      console.warn('[terminal-split-view] failed to open active run slots', err);
    }
  }

  private _openWatchlist() {
    const watchRefs = this._watchEntries()
      .map((entry) => entry.ref)
      .slice(0, 4);
    const sameWatchlist =
      this._selectedSlots.filter(Boolean).length === 0 &&
      this._selectedWorkers.length === watchRefs.length &&
      watchRefs.every((ref) =>
        this._selectedWorkers.some((selected) => tmuxWorkerRefsMatch(selected, ref)),
      );
    this._selectedWorkers = sameWatchlist ? [] : watchRefs;
    this._selectedSlots = [];
    this._expandedSlot = null;
    this._layout = 'auto';
    this._save();
  }

  private _handleSlotChange(index: number, e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const updated = [...this._selectedSlots];
    if (value) {
      updated[index] = value;
    } else {
      updated.splice(index, 1);
    }
    this._selectedSlots = updated;
    this._save();
  }

  private _handleLayoutChange(layout: LayoutMode) {
    this._layout = layout;
    this._expandedSlot = null;
    this._save();
  }

  private _handleExpand(e: CustomEvent) {
    const { slotId } = e.detail;
    this._expandedSlot = this._expandedSlot === slotId ? null : slotId;
  }

  private _handleTerminalClose(e: CustomEvent<{ slotId?: string; worker?: TmuxWorkerRef }>) {
    const { slotId, worker } = e.detail;
    if (worker) {
      this._closeWorker(worker);
      return;
    }
    if (!slotId) return;
    this._selectedSlots = this._selectedSlots.filter((selected) => selected !== slotId);
    if (this._expandedSlot === slotId) this._expandedSlot = null;
    this._save();
  }

  private _removeSlot(index: number) {
    const updated = [...this._selectedSlots];
    updated.splice(index, 1);
    this._selectedSlots = updated;
    this._save();
  }

  private _addSlotSelector() {
    if (this._selectedSlots.length < this._maxSlots()) {
      this._selectedSlots = [...this._selectedSlots, ''];
    }
  }

  private _machineFilteredWorkers(): TmuxWorkerSummary[] {
    const { machines } = this._globalFilters;
    return machines.length === 0
      ? this._tmuxWorkers
      : this._tmuxWorkers.filter((worker) => machines.includes(worker.ref.nodeId));
  }

  private _filteredWorkers(): TmuxWorkerSummary[] {
    return this._machineFilteredWorkers().filter((worker) => {
      if (this._workerPaneFilter === 'all') return true;
      const farmslot = isFarmslotWorker(worker);
      return this._workerPaneFilter === 'farmslot' ? farmslot : !farmslot;
    });
  }

  private _watchEntries(): TmuxWorkerWatchEntry[] {
    return reconcileTmuxWorkerWatchlist(
      this._workerWatchItems,
      this._machineFilteredWorkers(),
    ).filter((entry) => {
      if (this._workerPaneFilter === 'all') return true;
      const farmslot = isFarmslotWatchEntry(entry);
      return this._workerPaneFilter === 'farmslot' ? farmslot : !farmslot;
    });
  }

  private _workerFilterCounts(): Record<WorkerPaneFilter, number> {
    const { machines } = this._globalFilters;
    const workers =
      machines.length === 0
        ? this._tmuxWorkers
        : this._tmuxWorkers.filter((worker) => machines.includes(worker.ref.nodeId));
    const farmslot = workers.filter(isFarmslotWorker).length;
    return {
      adhoc: workers.length - farmslot,
      all: workers.length,
      farmslot,
    };
  }

  private _setWorkerPaneFilter(filter: WorkerPaneFilter) {
    this._workerPaneFilter = filter;
    localStorage.setItem(WORKER_FILTER_KEY, filter);
  }

  private _openWorker(ref: TmuxWorkerRef) {
    if (this._selectedWorkers.some((candidate) => tmuxWorkerRefsMatch(candidate, ref))) return;
    this._selectedWorkers = [ref, ...this._selectedWorkers].slice(0, 4);
    this._expandedSlot = null;
    this._save();
  }

  private _closeWorker(ref: TmuxWorkerRef) {
    this._selectedWorkers = this._selectedWorkers.filter(
      (candidate) => !tmuxWorkerRefsMatch(candidate, ref),
    );
    this._save();
  }

  private _toggleWorkerWatch(worker: TmuxWorkerSummary) {
    const next = isTmuxWorkerWatched(this._workerWatchItems, worker.ref)
      ? removeTmuxWorkerWatchItem(this._workerWatchItems, worker.ref)
      : upsertTmuxWorkerWatchItem(this._workerWatchItems, worker);
    this._saveWatchItems(next);
  }

  private _removeWatchEntry(entry: TmuxWorkerWatchEntry) {
    this._saveWatchItems(removeTmuxWorkerWatchItem(this._workerWatchItems, entry.ref));
  }

  private _renderWorkerPanel() {
    const watchEntries = this._watchEntries();
    const liveWorkers = this._filteredWorkers();
    const counts = this._workerFilterCounts();
    const liveUnwatched = liveWorkers.filter(
      (worker) => !isTmuxWorkerWatched(this._workerWatchItems, worker.ref),
    );

    return html`
      <div class="worker-panel">
        <div class="worker-panel-header">
          <div>
            <div class="worker-panel-title">Tmux watchlist</div>
            <div class="worker-panel-hint">
              Local browser cache. Pin tmux panes that were not launched by Farmslot.
            </div>
          </div>
          <button class="layout-btn" @click=${() => this._fetchTmuxWorkers()}>Refresh tmux</button>
        </div>
        <div class="worker-filter-row">
          ${(['adhoc', 'farmslot-farm', 'all'] as WorkerPaneFilter[]).map(
            (filter) => html`
              <button
                class="worker-filter-btn ${this._workerPaneFilter === filter ? 'active' : ''}"
                @click=${() => this._setWorkerPaneFilter(filter)}
              >
                ${filter === 'adhoc'
                  ? `Non-Farmslot ${counts.adhoc}`
                  : filter === 'farmslot'
                    ? `Farmslot ${counts.farmslot}`
                    : `All ${counts.all}`}
              </button>
            `,
          )}
        </div>
        ${this._workerListError
          ? html`<div class="worker-error">${this._workerListError}</div>`
          : ''}
        <div class="worker-list">
          ${watchEntries.map((entry) => this._renderWatchEntry(entry))}
          ${liveUnwatched.slice(0, 12).map((worker) => this._renderLiveWorker(worker))}
        </div>
      </div>
    `;
  }

  private _renderWatchEntry(entry: TmuxWorkerWatchEntry) {
    const needsAttention = entry.worker?.status.requiresAttention === true;
    return html`
      <div
        class="worker-chip ${entry.live ? 'live' : 'stale'} ${needsAttention
          ? 'needs-attention'
          : ''}"
      >
        <button class="worker-chip-btn pinned" @click=${() => this._removeWatchEntry(entry)}>
          ★
        </button>
        <div class="worker-chip-title">${watchEntryTitle(entry)}</div>
        <button class="worker-chip-btn active" @click=${() => this._openWorker(entry.ref)}>
          Open
        </button>
        ${entry.worker?.linkedSlotId
          ? html`<button
              class="worker-chip-btn ${isSlotPinned(entry.worker.linkedSlotId) ? 'pinned' : ''}"
              title=${isSlotPinned(entry.worker.linkedSlotId)
                ? `Remove ${entry.worker.linkedSlotId} from pinned slots`
                : `Pin ${entry.worker.linkedSlotId}`}
              @click=${() => togglePinnedSlot(entry.worker!.linkedSlotId!)}
            >
              ${isSlotPinned(entry.worker.linkedSlotId) ? 'Pinned slot' : 'Pin slot'}
            </button>`
          : ''}
        <button class="worker-chip-btn" @click=${() => this._closeWorker(entry.ref)}>Close</button>
        <div class="worker-chip-meta">${watchEntryDescription(entry)}</div>
      </div>
    `;
  }

  private _renderLiveWorker(worker: TmuxWorkerSummary) {
    const needsAttention = worker.status.requiresAttention === true;
    return html`
      <div class="worker-chip live ${needsAttention ? 'needs-attention' : ''}">
        <button class="worker-chip-btn" @click=${() => this._toggleWorkerWatch(worker)}>☆</button>
        <div class="worker-chip-title">${workerTitle(worker)}</div>
        <button class="worker-chip-btn active" @click=${() => this._openWorker(worker.ref)}>
          Open
        </button>
        ${worker.linkedSlotId
          ? html`<button
              class="worker-chip-btn ${isSlotPinned(worker.linkedSlotId) ? 'pinned' : ''}"
              title=${isSlotPinned(worker.linkedSlotId)
                ? `Remove ${worker.linkedSlotId} from pinned slots`
                : `Pin ${worker.linkedSlotId}`}
              @click=${() => togglePinnedSlot(worker.linkedSlotId!)}
            >
              ${isSlotPinned(worker.linkedSlotId) ? 'Pinned slot' : 'Pin slot'}
            </button>`
          : ''}
        <button class="worker-chip-btn" @click=${() => this._closeWorker(worker.ref)}>Close</button>
        <div class="worker-chip-meta">${workerDescription(worker)}</div>
      </div>
    `;
  }

  render() {
    const max = this._maxSlots();
    const slotsToShow = this._expandedSlot
      ? [this._expandedSlot]
      : this._selectedSlots.slice(0, max);
    const panes: TerminalPane[] = this._expandedSlot
      ? slotsToShow.map((slotId, index) => ({ type: 'slot' as const, slotId, index }))
      : [
          ...this._selectedWorkers.map((ref) => ({ type: 'worker' as const, ref })),
          ...slotsToShow.map((slotId, index) => ({ type: 'slot' as const, slotId, index })),
        ];
    const paneCount = panes.length || 1;

    return html`
      <div class="toolbar">
        <span class="toolbar-label">Terminals</span>
        ${repeat(
          slotsToShow.map((_, i) => i),
          (i) => i,
          (i) => html`
            <div class="slot-selector-group">
              <select
                class="slot-select"
                .value=${this._selectedSlots[i] || ''}
                @change=${(e: Event) => this._handleSlotChange(i, e)}
              >
                <option value="">-- select slot --</option>
                ${this._availableSlots.map(
                  (s) =>
                    html`<option value=${s} ?selected=${this._selectedSlots[i] === s}>
                      ${s}
                    </option>`,
                )}
              </select>
              <button
                class="close-slot-btn"
                title="Remove terminal"
                @click=${() => this._removeSlot(i)}
              >
                x
              </button>
            </div>
          `,
        )}
        ${!this._expandedSlot && slotsToShow.length < max
          ? html` <button class="layout-btn" @click=${this._addSlotSelector}>+</button> `
          : ''}
        <button class="layout-btn" @click=${this._showActiveRuns}>Active Runs</button>
        <button class="layout-btn" @click=${this._openWatchlist}>Open Watchlist</button>
        <div class="layout-btns">
          ${(['auto', '1x1', '2x1', '2x2', '3x2', '4x2'] as LayoutMode[]).map(
            (l) => html`
              <button
                class="layout-btn ${this._layout === l ? 'active' : ''}"
                @click=${() => this._handleLayoutChange(l)}
              >
                ${l}
              </button>
            `,
          )}
        </div>
      </div>
      ${this._renderWorkerPanel()}
      ${this._availableSlots.length === 0 &&
      this._selectedSlots.filter(Boolean).length === 0 &&
      this._selectedWorkers.length === 0 &&
      this._hydrating
        ? html`<farm-hydrating message="Loading fleet data…"></farm-hydrating>`
        : html` <div
            class="grid ${this._expandedSlot ? 'expanded' : ''}"
            style="${this._expandedSlot ? '' : this._gridStyle(paneCount)}"
          >
            ${repeat(
              panes,
              (pane) =>
                pane.type === 'worker'
                  ? `worker:${pane.ref.nodeId}:${pane.ref.target}`
                  : `slot:${pane.slotId || pane.index}`,
              (pane) =>
                pane.type === 'worker'
                  ? html`<terminal-view
                      .workerRefJson=${JSON.stringify(pane.ref)}
                      @terminal-close=${this._handleTerminalClose}
                    ></terminal-view>`
                  : pane.slotId
                    ? html`<terminal-view
                        .slotId=${pane.slotId}
                        .runId=${this._currentRunIdForSlot(pane.slotId)}
                        @terminal-expand=${this._handleExpand}
                        @terminal-close=${this._handleTerminalClose}
                      ></terminal-view>`
                    : html`<div class="empty-slot">Select a slot</div>`,
            )}
          </div>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'terminal-split-view': TerminalSplitView;
  }
}
