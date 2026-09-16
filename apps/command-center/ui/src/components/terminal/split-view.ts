import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import type {
  FleetStatus,
  FleetStatusResult,
  Run,
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
import '../shared/workspace-pin.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, isHydrating, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { listPinnedSlots, listPinnedWorkspaces } from '../../utils/pinned-slots.js';
import { hashParams } from '../../utils/url-state.js';
import { isRunListActiveRun } from '../runs/run-list-model.js';

import {
  filterSlotsByGlobalFilters,
  isFarmslotWatchEntry,
  isFarmslotWorker,
  isWorkerPaneFilter,
  LAYOUT_KEY,
  type LayoutMode,
  parseWatchItems,
  parseWorkerRefs,
  parseWorkerRouteParam,
  RUN_PANES_KEY,
  selectActiveRunSlotIds,
  selectPinnedSlotIds,
  selectWorkspaceRuns,
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
  @property() initialRun = '';
  @state() private _selectedRuns: string[] = [];
  @state() private _runs: Run[] = [];

  @state() private _availableSlots: string[] = [];
  @state() private _selectedSlots: string[] = [];
  @state() private _selectedWorkers: TmuxWorkerRef[] = [];
  @state() private _layout: LayoutMode = 'auto';
  @state() private _expandedPane: string | null = null;
  @state() private _hydrating = false;
  @state() private _tmuxWorkers: TmuxWorkerSummary[] = [];
  @state() private _workerWatchItems: TmuxWorkerWatchItem[] = [];
  @state() private _workerListError = '';
  @state() private _workerSearch = '';
  @state() private _endingSession: string | null = null;
  @state() private _endSessionError = '';
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
      min-width: 0;
      overflow: hidden;
      background: ${unsafeCSS(colors.bgBase)};
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
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
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
      gap: ${unsafeCSS(spacing.sm)};
      min-width: 0;
      max-height: 28vh;
      overflow-y: auto;
      overflow-x: hidden;
    }
    details.worker-panel > summary {
      cursor: pointer;
      list-style: none;
    }
    .worker-search {
      flex: 1;
      min-width: 150px;
      padding: 6px 8px;
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid #2a2a44;
      border-radius: 4px;
    }
    .worker-chip-actions {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .worker-chip-btn.danger {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .worker-chip-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .worker-empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 12px;
      padding: 8px;
    }

    .worker-chip {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      min-width: 0;
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
      min-width: 0;
      overflow-wrap: anywhere;
      line-height: 1.4;
    }

    .worker-chip-meta {
      color: ${unsafeCSS(colors.textMuted)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      grid-column: 1 / -1;
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
    if (changed.has('initialRun') && this.initialRun) {
      this._selectedRuns = [this.initialRun];
      this._selectedSlots = [];
      this._selectedWorkers = [];
      this._expandedPane = null;
      this._layout = '1x1';
      this._save();
    }
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
    this._applyRouteWorker();
    this._fetchSlots();
    void this._fetchRuns();
    this._fetchTmuxWorkers();
    const initial = getState();
    this._globalFilters = initial.globalFilters;
    this._runs = initial.runs;
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
      this._runs = s.runs;
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
      const savedRuns: unknown = JSON.parse(localStorage.getItem(RUN_PANES_KEY) ?? '[]');
      this._selectedRuns = Array.isArray(savedRuns)
        ? savedRuns.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
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
      localStorage.removeItem(RUN_PANES_KEY);
      this._selectedRuns = [];
      localStorage.removeItem(WORKER_PANES_KEY);
      localStorage.removeItem(WORKER_WATCHLIST_KEY);
      localStorage.removeItem(WORKER_FILTER_KEY);
      this._selectedSlots = [];
      this._selectedWorkers = [];
      this._workerWatchItems = [];
    }
  }

  private _applyRouteWorker() {
    const routeWorker = parseWorkerRouteParam(hashParams().get('worker'));
    if (!routeWorker) return;
    this._selectedRuns = [];
    this._selectedSlots = [];
    this._selectedWorkers = [routeWorker];
    this._workerPaneFilter = 'all';
    this._layout = '1x1';
    this._save();
  }

  private _save() {
    localStorage.setItem(RUN_PANES_KEY, JSON.stringify(this._selectedRuns));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._selectedSlots));
    localStorage.setItem(WORKER_PANES_KEY, JSON.stringify(this._selectedWorkers));
    localStorage.setItem(LAYOUT_KEY, this._layout);
    localStorage.setItem(WORKER_FILTER_KEY, this._workerPaneFilter);
  }

  private _saveWatchItems(items: TmuxWorkerWatchItem[]) {
    this._workerWatchItems = items;
    localStorage.setItem(WORKER_WATCHLIST_KEY, JSON.stringify(items));
  }

  private async _fetchRuns() {
    try {
      const result = await gateway.request<RunListResult>(Methods.RUN_LIST, { limit: 1000 });
      this._runs = result.runs;
    } catch (error) {
      this._workerListError = `Could not load worktree reviews: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private _openRun(runId: string) {
    this._selectedRuns = [runId, ...this._selectedRuns.filter((id) => id !== runId)].slice(
      0,
      this._maxSlots(),
    );
    this._selectedWorkers = this._selectedWorkers.slice(
      0,
      this._maxSlots() - this._selectedRuns.length,
    );
    this._selectedSlots = this._selectedSlots.slice(
      0,
      Math.max(0, this._maxSlots() - this._selectedRuns.length - this._selectedWorkers.length),
    );
    this._expandedPane = null;
    this._save();
  }

  private async _fetchSlots() {
    try {
      const result = await gateway.request<FleetStatusResult>(Methods.FLEET_STATUS, {});
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
        gateway.request<FleetStatusResult>(Methods.FLEET_STATUS, {}),
        gateway.request<RunListResult>(Methods.RUN_LIST, { limit: 1000 }),
      ]);
      const activeRuns = selectActiveRunSlotIds(
        fleetResult.fleet.slots,
        (runResult.runs ?? []).filter(isRunListActiveRun),
        this._globalFilters,
      );
      this._runs = runResult.runs;
      this._selectedRuns = selectWorkspaceRuns(runResult.runs, this._globalFilters)
        .slice(0, 8)
        .map((run) => run.id);
      this._selectedSlots = activeRuns.slice(0, 8 - this._selectedRuns.length);
      this._selectedWorkers = [];
      this._layout = 'auto';
      this._expandedPane = null;
      this._save();
    } catch (err) {
      console.warn('[terminal-split-view] failed to open active run slots', err);
    }
  }

  private async _showPinnedSlots() {
    try {
      const [fleetResult, runResult] = await Promise.all([
        gateway.request<FleetStatusResult>(Methods.FLEET_STATUS, {}),
        gateway.request<RunListResult>(Methods.RUN_LIST, { limit: 1000 }),
      ]);
      this._runs = runResult.runs;
      const availableRuns = new Set(
        selectWorkspaceRuns(this._runs, this._globalFilters).map((run) => run.id),
      );
      this._selectedRuns = listPinnedWorkspaces()
        .flatMap((pin) => ('runId' in pin && availableRuns.has(pin.runId) ? [pin.runId] : []))
        .slice(0, 8);
      const pinned = selectPinnedSlotIds(
        fleetResult.fleet.slots,
        listPinnedSlots().map((pin) => pin.slotId),
        this._globalFilters,
      );
      this._selectedSlots = pinned.slice(0, 8 - this._selectedRuns.length);
      this._selectedWorkers = [];
      this._layout = 'auto';
      this._expandedPane = null;
      this._save();
    } catch (err) {
      console.warn('[terminal-split-view] failed to open pinned slots', err);
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
    this._selectedRuns = [];
    this._selectedWorkers = sameWatchlist ? [] : watchRefs;
    this._selectedSlots = [];
    this._expandedPane = null;
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
    this._expandedPane = null;
    this._save();
  }

  private _handleLayoutChange(layout: LayoutMode) {
    this._layout = layout;
    this._expandedPane = null;
    this._save();
  }

  private _handleExpand(e: CustomEvent) {
    const { slotId, runId } = e.detail;
    const key = slotId ? `slot:${slotId}` : runId ? `run:${runId}` : null;
    this._expandedPane = this._expandedPane === key ? null : key;
  }

  private _handleTerminalClose(
    e: CustomEvent<{ slotId?: string; runId?: string; worker?: TmuxWorkerRef }>,
  ) {
    const { slotId, runId, worker } = e.detail;
    if (worker) {
      this._closeWorker(worker);
      return;
    }
    if (!slotId && runId) {
      this._selectedRuns = this._selectedRuns.filter((id) => id !== runId);
      if (this._expandedPane === `run:${runId}`) this._expandedPane = null;
      this._save();
      return;
    }
    if (!slotId) return;
    this._selectedSlots = this._selectedSlots.filter((selected) => selected !== slotId);
    if (this._expandedPane === `slot:${slotId}`) this._expandedPane = null;
    this._save();
  }

  private _removeSlot(index: number) {
    const updated = [...this._selectedSlots];
    updated.splice(index, 1);
    this._selectedSlots = updated;
    this._save();
  }

  private _addSlotSelector() {
    if (
      this._selectedSlots.length + this._selectedRuns.length + this._selectedWorkers.length <
      this._maxSlots()
    ) {
      this._selectedSlots = [...this._selectedSlots, ''];
    }
  }

  private _machineFilteredWorkers(): TmuxWorkerSummary[] {
    const { machines } = this._globalFilters;
    return machines.length === 0
      ? this._tmuxWorkers
      : this._tmuxWorkers.filter((worker) => machines.includes(worker.ref.nodeId));
  }

  private _matchesSearch(text: string): boolean {
    return this._workerSearch
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .every((term) => text.toLowerCase().includes(term));
  }

  private _filteredWorkers(): TmuxWorkerSummary[] {
    const workspaceIds = new Set(
      selectWorkspaceRuns(this._runs, this._globalFilters).map((run) => run.id),
    );
    return this._machineFilteredWorkers().filter((worker) => {
      if (worker.linkedRunId && workspaceIds.has(worker.linkedRunId)) return false;
      if (!this._matchesSearch(workerTitle(worker) + ' ' + workerDescription(worker))) return false;
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
      if (!this._matchesSearch(watchEntryTitle(entry) + ' ' + watchEntryDescription(entry)))
        return false;
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
    this._selectedWorkers = [
      ref,
      ...this._selectedWorkers.filter((candidate) => !tmuxWorkerRefsMatch(candidate, ref)),
    ].slice(0, Math.min(4, this._maxSlots()));
    this._selectedRuns = this._selectedRuns.slice(
      0,
      this._maxSlots() - this._selectedWorkers.length,
    );
    this._selectedSlots = this._selectedSlots.slice(
      0,
      Math.max(0, this._maxSlots() - this._selectedRuns.length - this._selectedWorkers.length),
    );
    this._expandedPane = null;
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
      <details class="worker-panel" open>
        <summary class="worker-panel-header">
          <div>
            <div class="worker-panel-title">Sessions · ${liveWorkers.length} matching</div>
            <div class="worker-panel-hint">
              Watch sessions for quick access. Collapse this list to give terminals more room.
            </div>
          </div>
          <button
            class="layout-btn"
            @click=${(event: Event) => {
              event.preventDefault();
              void this._fetchTmuxWorkers();
            }}
          >
            Refresh sessions
          </button>
        </summary>
        <div class="worker-filter-row">
          <input
            class="worker-search"
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions, machines, folders…"
            .value=${this._workerSearch}
            @input=${(event: Event) => {
              this._workerSearch = (event.target as HTMLInputElement).value;
            }}
          />
          ${(['adhoc', 'farmslot', 'all'] as WorkerPaneFilter[]).map(
            (filter) => html`
              <button
                class="worker-filter-btn ${this._workerPaneFilter === filter ? 'active' : ''}"
                @click=${() => this._setWorkerPaneFilter(filter)}
              >
                ${filter === 'adhoc'
                  ? `Unmanaged ${counts.adhoc}`
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
        ${this._endSessionError
          ? html`<div class="worker-error" role="alert">${this._endSessionError}</div>`
          : ''}
        <div class="worker-list">
          ${!watchEntries.length && !liveUnwatched.length
            ? html`<div class="worker-empty">No sessions match these filters.</div>`
            : ''}
          ${watchEntries.map((entry) => this._renderWatchEntry(entry))}
          ${liveUnwatched.map((worker) => this._renderLiveWorker(worker))}
        </div>
      </details>
    `;
  }

  private _renderWatchEntry(entry: TmuxWorkerWatchEntry) {
    return this._renderSessionCard(
      entry.ref,
      watchEntryTitle(entry),
      watchEntryDescription(entry),
      entry.worker,
      true,
      () => this._removeWatchEntry(entry),
    );
  }

  private _renderLiveWorker(worker: TmuxWorkerSummary) {
    return this._renderSessionCard(
      worker.ref,
      workerTitle(worker),
      workerDescription(worker),
      worker,
      false,
      () => this._toggleWorkerWatch(worker),
    );
  }

  private async _endSession(worker: TmuxWorkerSummary) {
    if (!gateway.isGlobalAdmin || !worker.canEndSession || !worker.pid || this._endingSession)
      return;
    if (
      !window.confirm(
        `End tmux session "${worker.ref.session}" on ${worker.ref.nodeId}?\n\nEvery pane and any programs running in this session will stop.`,
      )
    )
      return;
    this._endingSession = `${worker.ref.nodeId}:${worker.ref.session}`;
    this._endSessionError = '';
    try {
      await gateway.request(Methods.TMUX_WORKER_END_SESSION, {
        worker: worker.ref,
        expectedPid: worker.pid,
      });
      const belongs = (ref: TmuxWorkerRef) =>
        ref.nodeId === worker.ref.nodeId && ref.session === worker.ref.session;
      this._selectedWorkers = this._selectedWorkers.filter((ref) => !belongs(ref));
      this._saveWatchItems(this._workerWatchItems.filter((item) => !belongs(item.ref)));
      this._save();
      await this._fetchTmuxWorkers();
      // Node inventory can remain cached briefly after confirmed termination.
      this._tmuxWorkers = this._tmuxWorkers.filter((current) => !belongs(current.ref));
    } catch (error) {
      this._endSessionError = error instanceof Error ? error.message : String(error);
    } finally {
      this._endingSession = null;
    }
  }

  private _renderSessionCard(
    ref: TmuxWorkerRef,
    title: string,
    description: string,
    worker: TmuxWorkerSummary | undefined,
    watched: boolean,
    toggleWatch: () => void,
  ) {
    const open = this._selectedWorkers.some((selected) => tmuxWorkerRefsMatch(selected, ref));
    const ending = this._endingSession === `${ref.nodeId}:${ref.session}`;
    return html`<div
      data-session=${ref.session}
      class="worker-chip ${worker ? 'live' : 'stale'} ${worker?.status.requiresAttention
        ? 'needs-attention'
        : ''}"
    >
      <button
        class="worker-chip-btn ${watched ? 'pinned' : ''}"
        title=${watched ? 'Remove from watchlist' : 'Add to watchlist'}
        @click=${toggleWatch}
      >
        ${watched ? '★' : '☆'}
      </button>
      <div class="worker-chip-title" title=${title}>${title}</div>
      <div class="worker-chip-meta" title=${description}>
        ${ref.nodeId} · ${worker?.status.label ?? 'Unavailable'} · ${worker?.cwd ?? ''}
      </div>
      <div class="worker-chip-actions">
        <button
          class="worker-chip-btn ${open ? 'active' : ''}"
          @click=${() => (open ? this._closeWorker(ref) : this._openWorker(ref))}
        >
          ${open ? 'Hide terminal' : 'Open terminal'}
        </button>
        ${worker?.linkedSlotId
          ? html`<workspace-pin .slotId=${worker.linkedSlotId}></workspace-pin
              ><a class="worker-chip-btn" href=${`#slot/${worker.linkedSlotId}`}>Workspace</a>`
          : worker?.linkedRunId
            ? html`<workspace-pin
                  .runId=${worker.linkedRunId}
                  .label=${this._runs.find((run) => run.id === worker.linkedRunId)?.ticketOrPr ??
                  ''}
                ></workspace-pin
                ><a class="worker-chip-btn" href=${`#run/${worker.linkedRunId}`}>Workspace</a>`
            : html`<button
                class="worker-chip-btn danger"
                data-end-session=${ref.session}
                ?disabled=${!gateway.isGlobalAdmin ||
                !worker?.canEndSession ||
                Boolean(this._endingSession)}
                title=${!gateway.isGlobalAdmin
                  ? 'Only a farm administrator can end sessions'
                  : worker?.canEndSession
                    ? 'Stop every pane in this session'
                    : 'Session termination requires current inventory from an updated gateway'}
                @click=${() => worker && this._endSession(worker)}
              >
                ${ending ? 'Ending…' : 'End session'}
              </button>`}
      </div>
    </div>`;
  }

  render() {
    const max = this._maxSlots();
    const slotsToShow = this._selectedSlots.slice(0, max);
    const allPanes: TerminalPane[] = [
      ...this._selectedRuns.map((runId) => ({ type: 'run' as const, runId })),
      ...this._selectedWorkers.map((ref) => ({ type: 'worker' as const, ref })),
      ...slotsToShow.map((slotId, index) => ({ type: 'slot' as const, slotId, index })),
    ];
    const paneKey = (pane: TerminalPane) =>
      pane.type === 'run'
        ? `run:${pane.runId}`
        : pane.type === 'worker'
          ? `worker:${pane.ref.nodeId}:${pane.ref.target}`
          : `slot:${pane.slotId || pane.index}`;
    const panes = this._expandedPane
      ? allPanes.filter((pane) => paneKey(pane) === this._expandedPane)
      : allPanes.slice(0, max);
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
        ${!this._expandedPane && allPanes.length < max
          ? html` <button class="layout-btn" @click=${this._addSlotSelector}>+</button> `
          : ''}
        <button class="layout-btn" @click=${this._showActiveRuns}>Active Runs</button>
        <button class="layout-btn" @click=${this._showPinnedSlots}>Pinned</button>
        <button class="layout-btn" @click=${this._openWatchlist}>Watchlist</button>
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
      ${selectWorkspaceRuns(this._runs, this._globalFilters).length
        ? html`<div class="worker-panel" data-testid="workspace-terminals">
            <div class="worker-panel-title">Worktree reviews</div>
            <div class="worker-list">
              ${selectWorkspaceRuns(this._runs, this._globalFilters).map(
                (run) =>
                  html`<div class="worker-chip live">
                    <workspace-pin .runId=${run.id} .label=${run.ticketOrPr}></workspace-pin>
                    <div class="worker-chip-title">${run.ticketOrPr}</div>
                    <div class="worker-chip-actions">
                      <button
                        class="worker-chip-btn"
                        data-run-id=${run.id}
                        @click=${() => this._openRun(run.id)}
                      >
                        Open terminal
                      </button>
                      <a class="worker-chip-btn" href=${`#run/${encodeURIComponent(run.id)}`}
                        >Workspace</a
                      >
                    </div>
                    <div class="worker-chip-meta">
                      ${run.reviewWorkspace!.machine} · ${run.status}
                    </div>
                  </div>`,
              )}
            </div>
          </div>`
        : ''}
      ${this._renderWorkerPanel()}
      ${this._availableSlots.length === 0 &&
      this._selectedSlots.filter(Boolean).length === 0 &&
      this._selectedWorkers.length === 0 &&
      this._selectedRuns.length === 0 &&
      this._hydrating
        ? html`<farm-hydrating message="Loading fleet data…"></farm-hydrating>`
        : html` <div
            class="grid ${this._expandedPane ? 'expanded' : ''}"
            style="${this._expandedPane ? '' : this._gridStyle(paneCount)}"
          >
            ${repeat(panes, paneKey, (pane) =>
              pane.type === 'run'
                ? this._runs.some(
                    (run) =>
                      run.id === pane.runId &&
                      run.reviewWorkspace &&
                      !run.reviewWorkspace.cleanedAt,
                  )
                  ? html`<terminal-view
                      .runId=${pane.runId}
                      @terminal-expand=${this._handleExpand}
                      @terminal-close=${this._handleTerminalClose}
                    ></terminal-view>`
                  : html`<div class="empty-slot">
                      ${this._runs.find((run) => run.id === pane.runId)?.reviewWorkspace?.cleanedAt
                        ? 'This worktree has been cleaned up.'
                        : 'Worktree unavailable.'}
                      <a href=${`#run/${encodeURIComponent(pane.runId)}`}
                        >Open run and saved review</a
                      ><button
                        @click=${() => {
                          this._selectedRuns = this._selectedRuns.filter((id) => id !== pane.runId);
                          this._expandedPane = null;
                          this._save();
                        }}
                      >
                        Close
                      </button>
                    </div>`
                : pane.type === 'worker'
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
