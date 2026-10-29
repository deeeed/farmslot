import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  FleetStatusResult,
  FleetThumbnailsUpdatedPayload,
  MachineHealth,
  MachinePauseExecuteParams,
  MachinePauseExecuteResult,
  MachinePauseMode,
  MachinePausePreviewResult,
  MachinePauseRestoreParams,
  MachinePauseRestoreResult,
  MachinePauseSelector,
  MachinePauseStatusResult,
  MachinePauseUpdatedPayload,
  NodeInfo,
  NodesListResult,
  PressureAdmissionControlState,
  PressureAdmissionGetResult,
  PressureAdmissionSetEnabledResult,
  ProviderAccountsSnapshotResult,
  ResourceCleanupResult,
  ResourceListResult,
  ResourcePressureCleanupCandidate,
  ResourcePressureHistoryResult,
  ResourcePressureSnapshotParams,
  ResourcePressureSnapshotResult,
  ResourceStatus,
  ResourceStatusUpdatedPayload,
  ResourceWatchSetEnabledResult,
  Run,
  SlotResource,
  SlotStatus,
  TaskProgressResult,
  TaskProgressStructured,
} from '@farmslot/protocol';
import { Events, Methods, sourceObservationAge } from '@farmslot/protocol';
import type { ResourceQueryError, ResourceQueryState } from '@farmslot/protocol/client-cache';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { fleetRecoverySummary } from '@farmslot/review-dispatch';

import './machine-group.js';
import './machine-pause-dialog.js';
import './machine-pressure-overview.js';
import './resource-cleanup-preview.js';
import './resource-overview.js';
import '../slot-actions/slot-actions-modal.js';
import '../slot-actions/fleet-refresh-modal.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from '../../resource-cache.js';
import { type AppState, fleetQuery, getState, isHydrating, subscribe } from '../../state.js';
import { getRunForSlot } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import {
  heldDataIsSaved,
  isSupersededRead,
  readKeepsFailing,
  ResourceQueryController,
} from '../shared/resource-query-controller.js';
import {
  buildSlotPendingWork,
  type SlotPendingWork,
} from '../work-graph/work-graph-execution-overlay.js';

import {
  type FleetCanvasGroupBy,
  fleetCanvasUrlStateFromHash,
  fleetCanvasUrlStateHash,
  type FleetCanvasViewMode,
} from './fleet-canvas-url-state.js';
import { renderFleetSkeleton } from './fleet-skeleton.js';
import type { MachinePauseBusyAction } from './machine-pause-dialog.js';
import {
  machinePauseShouldRefetch,
  sortMachinePauseRecords,
} from './machine-pause-dialog-model.js';
import { cleanupExecutionTargets, cleanupTargetsRemainEligible } from './machine-pressure-model.js';

export interface ResourceEntry {
  slotId: string;
  machine: string;
  status: ResourceStatus;
  controllable: boolean;
  label: string;
  hasBoot: boolean;
  hasShutdown: boolean;
  hasRelaunch: boolean;
}

/** A busy node can miss a read or two; a slot's own alert waits for this many in a row. */
const PROGRESS_FAILURES_BEFORE_ALERT = 3;

export interface ResourceGroup {
  key: string;
  label: string;
  entries: ResourceEntry[];
}

@customElement('fleet-canvas')
export class FleetCanvas extends LitElement {
  @state() private slots: SlotStatus[] = [];
  @state() private hydrating = false;
  @state() private bootstrapFailed = false;
  @state() private fleetObservation: ResourceQueryState<FleetStatusResult> = { status: 'loading' };
  @state() private now = Date.now();
  private fleetAgeTimer?: ReturnType<typeof setInterval>;
  @state() private groupBy: FleetCanvasGroupBy = 'machine';
  @state() private filterProjects: string[] = [];
  @state() private filterMachines: string[] = [];
  @state() private search = '';
  @state() private recoverySlotId = '';
  @state() private recoveryInspectOnly = false;
  @state() private onlineMachines: Set<string> = new Set();
  @state() private nodeInfo: Map<string, NodeInfo> = new Map();
  @state() private gatewayProtocolVersion = '';
  @state() private slotProgress: Map<string, TaskProgressStructured> = new Map();
  @state() private progressObservations = new Map<string, ResourceQueryState<TaskProgressResult>>();
  private progressAgeTimer?: ReturnType<typeof setInterval>;
  private readonly progressQueries = new Map<string, ResourceQueryController<TaskProgressResult>>();
  /** Consecutive failed reads per slot. Each failed read carries a new error object. */
  private readonly progressFailures = new Map<
    string,
    { error: ResourceQueryError; count: number }
  >();
  @state() private slotRuns: Map<string, Run> = new Map();
  @state() private machineHealthMap: Map<string, MachineHealth> = new Map();
  @state() private slotResourceStatus: Map<string, Map<string, ResourceStatus>> = new Map();
  @state() private slotResourceDefs: Map<string, SlotResource[]> = new Map();
  @state() private slotThumbnails: Map<string, { data: string; ts: number }> = new Map();
  @state() private slotDecisions: Map<string, number> = new Map();
  @state() private slotPendingWork: Map<string, SlotPendingWork> = new Map();
  @state() private viewMode: FleetCanvasViewMode = 'card';
  @state() private actionsModalSlotId = '';
  @state() private fleetRefreshOpen = false;
  @state() private resourceActionBusy = false;
  @state() private resourceActionFlash = '';
  @state() private resourceWatchesEnabled = true;
  @state() private resourcePressure?: ResourcePressureSnapshotResult;
  @state() private resourcePressureHistory?: ResourcePressureHistoryResult;
  @state() private pressureAdmissionControl?: PressureAdmissionControlState;
  @state() private resourceCleanupPreview?: ResourcePressureSnapshotResult;
  @state() private machinePauseMachine = '';
  @state() private machinePauseMode: MachinePauseMode = 'orchestration';
  @state() private machinePausePreview?: MachinePausePreviewResult;
  @state() private machinePauseStatus?: MachinePauseStatusResult;
  @state() private machinePauseRestorePreview?: MachinePauseRestoreResult;
  @state() private machinePauseBusy: MachinePauseBusyAction = null;
  @state() private machinePauseActionError = '';
  @state() private machinePauseConnectionStale = false;
  /** Machines with an explicit live seat probe in flight. */
  @state() private providerAccountsRefreshing = new Set<string>();
  @state() private providerAccountsRefreshError = '';
  private _resourceFetched = false;
  private _resourcePressureFetchEpoch = 0;
  private _machinePauseFetchEpoch = 0;
  private _machinePauseSelector: MachinePauseSelector = { kind: 'all' };
  private _machinePauseRestoreSelector: MachinePauseSelector = { kind: 'all' };
  private _machinePauseEventTimer?: ReturnType<typeof setTimeout>;
  private _pressureHistoryRefreshTimer?: ReturnType<typeof setTimeout>;
  private _resourcePressureRecoveryTimer?: ReturnType<typeof setTimeout>;
  private unsub?: () => void;
  private _unsubConnState?: () => void;
  private _unsubNodeHealth?: () => void;
  private _unsubResourceStatus?: () => void;
  private _unsubThumbnails?: () => void;
  private _unsubMachinePauseUpdated?: () => void;
  private _onHashChange = () => this._readUrlParams();
  /** Every fleet machine's runner seats; the config page shares the same cached owners. */
  private readonly providerAccountsQuery =
    new ResourceQueryController<ProviderAccountsSnapshotResult>(this);
  private readonly nodeQuery = new ResourceQueryController<NodesListResult>(this, (result) => {
    const nodes = result.data?.nodes ?? [];
    const changed = nodes.some((node) => this.nodeInfo.get(node.machine)?.pid !== node.pid);
    this.onlineMachines = new Set(nodes.map((node) => node.machine));
    this.nodeInfo = new Map(nodes.map((node) => [node.machine, node]));
    this.gatewayProtocolVersion = result.data?.gatewayProtocolVersion ?? '';
    if (changed && result.status === 'ready') this.scheduleResourcePressureRecoveryRefresh();
  });

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.xl)};
      flex-shrink: 0;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
    .toolbar input {
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textPrimary)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 4px;
      padding: 3px 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      outline: none;
    }
    .toolbar input:focus {
      border-color: ${unsafeCSS(colors.accent)};
    }
    .toolbar input {
      width: 140px;
    }
    .toggle-group {
      display: flex;
      gap: 1px;
    }
    .toggle-btn {
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textMuted)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      padding: 3px 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }
    .toggle-btn {
      border-radius: 0;
    }
    .toggle-btn:first-child {
      border-radius: 4px 0 0 4px;
    }
    .toggle-btn:last-child {
      border-radius: 0 4px 4px 0;
    }
    .toggle-btn.active {
      background: ${unsafeCSS(colors.accent)};
      color: #fff;
      border-color: ${unsafeCSS(colors.accent)};
    }
    .fleet-refresh-trigger {
      border-radius: 4px;
      margin-left: auto;
    }
    .fleet-refresh-trigger.has-eligible {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}88;
    }
    .fleet-refresh-trigger.has-eligible:hover:not(:disabled) {
      background: ${unsafeCSS(colors.accent)}22;
      border-color: ${unsafeCSS(colors.accent)};
    }
    .fleet-refresh-trigger:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .canvas {
      flex: 1;
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.xl)};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.xl)};
    }
    .empty {
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeMd)};
      text-align: center;
      padding: ${unsafeCSS(spacing.xxxl)};
    }
    .rehydrating-banner {
      color: ${unsafeCSS(colors.statusWarn)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    /* Toolbar notices share the leftover width on one line, so one coming or going never changes
       the toolbar's height. */
    .toolbar > .rehydrating-banner {
      flex: 1 1 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .progress-read-retry {
      flex: none;
    }
    .resource-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .resource-controls button {
      background: ${unsafeCSS(colors.bgInput)};
      color: ${unsafeCSS(colors.textMuted)};
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 4px;
      padding: 3px 8px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }
    .resource-controls button:hover:not(:disabled) {
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .resource-controls button.danger:hover:not(:disabled) {
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)};
    }
    .resource-controls button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .resource-flash-ok {
      color: ${unsafeCSS(colors.statusOk)};
    }
    .resource-flash-err {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .resource-watch-note {
      flex-basis: 100%;
      color: ${unsafeCSS(colors.textMuted)};
      line-height: 1.45;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.syncState(getState());
    this.unsub = subscribe((s) => this.syncState(s));

    this.nodeQuery.setQuery(resourceQuery<NodesListResult>(Methods.NODES_LIST));
    this.providerAccountsQuery.setQuery(
      resourceQuery<ProviderAccountsSnapshotResult>(Methods.PROVIDER_ACCOUNTS_SNAPSHOT),
    );
    this._unsubConnState = gateway.onConnectionChange((s) => {
      if (s === 'connected') {
        this.scheduleResourcePressureRecoveryRefresh();
        if (this.machinePauseMachine) {
          this.machinePauseConnectionStale = true;
          void this.fetchMachinePauseState(false);
        }
      } else if (this.machinePauseMachine) {
        this.machinePauseConnectionStale = true;
      }
    });
    // Track node health updates
    this._unsubNodeHealth = gateway.subscribe(Events.NODE_HEALTH_UPDATED, () => {
      // Keep pressure charts current on health beats with the LIGHTWEIGHT
      // history read only (debounced). The full snapshot (resources +
      // attribution) refreshes solely through explicit operator actions.
      this.schedulePressureHistoryRefresh();
    });

    // Track resource status updates
    this._unsubResourceStatus = gateway.subscribe<ResourceStatusUpdatedPayload>(
      Events.RESOURCE_STATUS_UPDATED,
      (p) => {
        const next = new Map(this.slotResourceStatus);
        const resMap = new Map<string, ResourceStatus>();
        for (const r of p.resources) resMap.set(r.id, r.status);
        next.set(p.slotId, resMap);
        this.slotResourceStatus = next;
      },
    );

    this._unsubMachinePauseUpdated = gateway.subscribe<MachinePauseUpdatedPayload>(
      Events.MACHINE_PAUSE_UPDATED,
      (payload) => this.onMachinePauseUpdated(payload),
    );

    // Subscribe to fleet thumbnail updates
    this._unsubThumbnails = gateway.subscribe<FleetThumbnailsUpdatedPayload>(
      Events.FLEET_THUMBNAILS_UPDATED,
      (p) => {
        const next = new Map<string, { data: string; ts: number }>();
        for (const [slotId, entry] of Object.entries(p.thumbnails)) {
          next.set(slotId, { data: entry.data, ts: entry.ts });
        }
        this.slotThumbnails = next;
      },
    );

    // Fetch initial thumbnails
    gateway
      .request<{
        thumbnails: Record<string, { data: string; width: number; height: number; ts: number }>;
      }>(Methods.SCREEN_THUMBNAIL)
      .then((res) => {
        const next = new Map<string, { data: string; ts: number }>();
        for (const [slotId, entry] of Object.entries(res.thumbnails)) {
          next.set(slotId, { data: entry.data, ts: entry.ts });
        }
        this.slotThumbnails = next;
      })
      .catch((err) => {
        console.warn(`[fleet-canvas] thumbnail fetch failed:`, (err as Error).message);
      });

    // Restore view params from URL, fall back to localStorage for migration
    this._readUrlParams();
    window.addEventListener('hashchange', this._onHashChange);
  }

  private _readUrlParams() {
    const next = fleetCanvasUrlStateFromHash(location.hash, {
      groupBy: localStorage.getItem('farmslot:fleet-groupBy'),
      viewMode: localStorage.getItem('farmslot:fleet-viewMode'),
    });
    if (this.groupBy !== next.groupBy) {
      this.groupBy = next.groupBy;
      if (next.groupBy === 'resource') this.fetchResourceData();
    }
    if (this.viewMode !== next.viewMode) this.viewMode = next.viewMode;
    if (next.fleetRefreshOpen !== this.fleetRefreshOpen)
      this.fleetRefreshOpen = next.fleetRefreshOpen;
  }

  private _writeUrlParams() {
    // Mutate the existing query in place so we don't clobber sibling params (the global
    // filter bar writes `projects=` and `machines=` into this same hash).
    const next = fleetCanvasUrlStateHash({
      groupBy: this.groupBy,
      viewMode: this.viewMode,
      fleetRefreshOpen: this.fleetRefreshOpen,
    });
    if (next && location.hash !== next) {
      history.replaceState(null, '', next);
    }
  }

  private clearPressureHistoryRefresh() {
    if (this._pressureHistoryRefreshTimer) {
      clearTimeout(this._pressureHistoryRefreshTimer);
      this._pressureHistoryRefreshTimer = undefined;
    }
  }

  private clearResourcePressureRecoveryRefresh() {
    if (this._resourcePressureRecoveryTimer) {
      clearTimeout(this._resourcePressureRecoveryTimer);
      this._resourcePressureRecoveryTimer = undefined;
    }
  }

  disconnectedCallback() {
    clearInterval(this.fleetAgeTimer);
    this.fleetAgeTimer = undefined;
    this.clearPressureHistoryRefresh();
    this.clearResourcePressureRecoveryRefresh();
    super.disconnectedCallback();
    this.unsub?.();
    this._unsubConnState?.();
    for (const query of this.progressQueries.values()) {
      query.hostDisconnected();
      this.removeController(query);
    }
    this.progressQueries.clear();
    this.slotProgress = new Map();
    this.progressObservations = new Map();
    this.progressFailures.clear();
    clearInterval(this.progressAgeTimer);
    this.progressAgeTimer = undefined;
    this._unsubNodeHealth?.();
    this._unsubResourceStatus?.();
    this._unsubThumbnails?.();
    this._unsubMachinePauseUpdated?.();
    if (this._machinePauseEventTimer) clearTimeout(this._machinePauseEventTimer);
    window.removeEventListener('hashchange', this._onHashChange);
  }

  /** The observation stays live; only the operator's Refresh waits for a new probe. */
  private async _refreshProviderAccounts(machine?: string, force = false) {
    if (!force || !machine) {
      await this.providerAccountsQuery.retry();
      return;
    }
    const owner = getResourceWorkspaceKey();
    this.providerAccountsRefreshing = new Set(this.providerAccountsRefreshing).add(machine);
    this.providerAccountsRefreshError = '';
    try {
      // Explicit live probe (~20s). Its source notification refreshes the shared observation.
      await gateway.request<ProviderAccountsSnapshotResult>(
        Methods.PROVIDER_ACCOUNTS_SNAPSHOT,
        { machines: [machine], forceRefresh: true },
        45_000,
      );
    } catch (err) {
      if (owner === getResourceWorkspaceKey())
        this.providerAccountsRefreshError = err instanceof Error ? err.message : String(err);
    } finally {
      const refreshing = new Set(this.providerAccountsRefreshing);
      refreshing.delete(machine);
      this.providerAccountsRefreshing = refreshing;
    }
  }

  private syncState(s: AppState) {
    const prev = this.slots;
    const previousPressureFilter = JSON.stringify([this.filterProjects, this.filterMachines]);
    this.slots = s.fleet?.slots ?? [];
    this.hydrating = isHydrating(s, 'fleet');
    this.bootstrapFailed = s.bootstrapFailed.fleet;
    this.fleetObservation = s.fleetObservation;
    if (s.fleetObservation.status === 'stale' && s.fleet && !this.fleetAgeTimer) {
      this.now = Date.now();
      this.fleetAgeTimer = setInterval(() => {
        this.now = Date.now();
      }, 1000);
    } else if (s.fleetObservation.status !== 'stale' || !s.fleet) {
      clearInterval(this.fleetAgeTimer);
      this.fleetAgeTimer = undefined;
    }
    this.filterProjects = s.globalFilters.projects;
    this.filterMachines = s.globalFilters.machines;
    const pressureFilterChanged =
      previousPressureFilter !== JSON.stringify([this.filterProjects, this.filterMachines]);
    if (pressureFilterChanged && this.groupBy === 'resource' && this._resourceFetched) {
      this.resourceCleanupPreview = undefined;
      void this.fetchResourceData();
    }
    // Populate machineHealthMap from fleet.machines
    this.machineHealthMap = new Map(
      (s.fleet?.machines ?? []).map((health) => [health.machine, health]),
    );
    this.syncProgressQueries();
    // Fetch resource data when slots arrive and we're in resource view
    if (
      this.groupBy === 'resource' &&
      !this._resourceFetched &&
      this.slots.length > 0 &&
      prev.length === 0
    ) {
      this.fetchResourceData();
    }
    // Build slotRuns map for working slots
    this.buildSlotRuns();
    // Build per-slot pending decision counts
    const decMap = new Map<string, number>();
    for (const d of s.decisions) {
      if (d.slotId) decMap.set(d.slotId, (decMap.get(d.slotId) ?? 0) + 1);
    }
    this.slotDecisions = decMap;
    this.slotPendingWork = buildSlotPendingWork({
      slots: this.slots,
      queueItems: s.queueItems,
      runs: s.runs,
      backlogItems: s.backlogItems,
      workGraphs: s.workGraphs,
      includeSchedulerReady: true,
    });
  }

  private buildSlotRuns() {
    const next = new Map<string, Run>();
    for (const s of this.slots) {
      const run = getRunForSlot(s.slot);
      if (run) next.set(s.slot, run);
    }
    this.slotRuns = next;
  }

  private syncProgressQueries(): void {
    const targets = new Map(
      this.slots
        .filter((slot) => slot.lifecycle === 'busy' && slot.taskFile)
        .map((slot) => [slot.slot, slot]),
    );
    for (const [slotId, query] of this.progressQueries) {
      if (targets.has(slotId)) continue;
      query.hostDisconnected();
      this.removeController(query);
      this.progressQueries.delete(slotId);
      this.slotProgress.delete(slotId);
      this.progressObservations.delete(slotId);
      this.progressFailures.delete(slotId);
    }
    for (const [slotId, slot] of targets) {
      let query = this.progressQueries.get(slotId);
      if (!query) {
        query = new ResourceQueryController<TaskProgressResult>(this, (state) => {
          if (!query || this.progressQueries.get(slotId) !== query) return;
          const progress = new Map(this.slotProgress);
          if (state.data?.structured) progress.set(slotId, state.data.structured);
          else progress.delete(slotId);
          this.slotProgress = progress;
          const failure = this.progressFailures.get(slotId);
          if (state.status === 'ready') this.progressFailures.delete(slotId);
          // A superseded read is not a failure: the write that superseded it scheduled the next read.
          else if (state.error && state.error !== failure?.error && !isSupersededRead(state.error))
            this.progressFailures.set(slotId, {
              error: state.error,
              count: (failure?.count ?? 0) + 1,
            });
          this.progressObservations = new Map(this.progressObservations).set(slotId, state);
          this.syncProgressAgeClock();
        });
        this.progressQueries.set(slotId, query);
      }
      query.setQuery(
        resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, {
          slotId,
          ...(slot.currentRunId ? { runId: slot.currentRunId } : {}),
        }),
      );
    }
    this.syncProgressAgeClock();
  }

  private syncProgressAgeClock(): void {
    const saved = [...this.progressObservations.values()].some(
      (state) => state.data && state.status !== 'ready',
    );
    if (saved && !this.progressAgeTimer)
      this.progressAgeTimer = setInterval(() => this.requestUpdate(), 60_000);
    else if (!saved) {
      clearInterval(this.progressAgeTimer);
      this.progressAgeTimer = undefined;
    }
  }

  /**
   * Slow or failing reads on a busy node share one line: the saved age, then an alert for slots
   * whose reads keep failing. A loaded node never adds a line per card; each keeps its progress.
   */
  private renderProgressReadStatus() {
    const quiet: Array<[string, ResourceQueryState<TaskProgressResult>]> = [];
    const failing: Array<[string, ResourceQueryError]> = [];
    const lines = [...this.progressObservations].map(([slotId, state]) => {
      const query = this.progressQueries.get(slotId);
      if (!query?.belongsToWorkspace) return nothing;
      if (state.status === 'unsupported')
        return html`<span
          class="rehydrating-banner"
          data-fleet-progress-slot=${slotId}
          data-progress-state=${state.status}
        >
          ${slotId}:
          ${state.data ? html`Saved progress, ${sourceObservationAge(state.observedAt)}.` : nothing}
          Progress updates are unavailable on this gateway.
        </span>`;
      const failed = state.error !== undefined && !isSupersededRead(state.error);
      if (
        failed &&
        (this.progressFailures.get(slotId)?.count ?? 0) >= PROGRESS_FAILURES_BEFORE_ALERT
      )
        failing.push([slotId, state.error!]);
      else if (
        heldDataIsSaved(state) ||
        (state.data === undefined && (failed || readKeepsFailing(query)))
      )
        quiet.push([slotId, state]);
      return nothing;
    });
    if (!quiet.length && !failing.length) return lines;
    const saved = quiet.flatMap(([, state]) => (state.data ? [state.observedAt ?? 0] : []));
    const quietText = !quiet.length
      ? ''
      : saved.length
        ? `Saved progress for ${saved.length} slot${saved.length === 1 ? '' : 's'}, oldest ${sourceObservationAge(Math.min(...saved))}.`
        : `Progress not read yet for ${quiet.length} slot${quiet.length === 1 ? '' : 's'}.`;
    const failingText = failing.length
      ? `Progress reads keep failing for ${failing.map(([slotId]) => slotId).join(', ')}: ${failing[0][1].message}`
      : '';
    const retryIds = [
      ...quiet.filter(([, state]) => state.error || !state.data).map(([slotId]) => slotId),
      ...failing.map(([slotId]) => slotId),
    ];
    // One line that never wraps, so slots joining or leaving cannot move the cards.
    return [
      html`<span
        class="rehydrating-banner"
        data-fleet-progress-quiet=${quiet.length}
        data-fleet-progress-failing=${failing.length}
        title=${[quietText, failingText].filter(Boolean).join(' ')}
      >
        ${quietText} ${failingText ? html`<span role="alert">${failingText}</span>` : nothing}
      </span>`,
      retryIds.length
        ? html`<button
            class="progress-read-retry"
            ?disabled=${gateway.connectionState !== 'connected'}
            @click=${() => {
              for (const slotId of retryIds) void this.progressQueries.get(slotId)?.retry();
            }}
          >
            Retry progress reads
          </button>`
        : nothing,
      ...lines,
    ];
  }

  private async fetchResourceData() {
    // Pressure paints first: start the pressure fetch (fast history read,
    // then the full snapshot) immediately, in parallel with the slower
    // per-slot resource-list batches below.
    const pressureFetch = this.fetchResourcePressure();
    const resourceSlots = this.resourceScopedSlots;
    if (resourceSlots.length === 0) {
      this.slotResourceDefs = new Map();
      this.slotResourceStatus = new Map();
      this._resourceFetched = true;
      await pressureFetch;
      return;
    }

    // Phase 1: fetch resource definitions (fast — reads project.json, no hooks)
    // Renders table immediately with "unknown" status dots
    const nextDefs = new Map<string, SlotResource[]>();
    const nextStatus = new Map<string, Map<string, ResourceStatus>>(this.slotResourceStatus);
    for (let index = 0; index < resourceSlots.length; index += 4) {
      const batch = resourceSlots.slice(index, index + 4);
      await Promise.all(
        batch.map(async (s) => {
          try {
            const listRes = await gateway.request<ResourceListResult>(Methods.RESOURCE_LIST, {
              slotId: s.slot,
            });
            if (listRes.resources.length > 0) {
              nextDefs.set(s.slot, listRes.resources);
              nextStatus.set(
                s.slot,
                new Map(listRes.resources.map((resource) => [resource.id, resource.status])),
              );
            }
          } catch (err) {
            console.warn(
              `[fleet-canvas] resource list failed for ${s.slot}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }),
      );
    }
    this.slotResourceDefs = nextDefs;
    this.slotResourceStatus = nextStatus;
    this._resourceFetched = true;
    await pressureFetch;
  }

  private async fetchResourcePressure() {
    const epoch = ++this._resourcePressureFetchEpoch;
    // Ride every pressure refresh (initial load, the Refresh-pressure button,
    // post-toggle refetch): a boot-time fetch can race the gateway connect,
    // so the kill-switch control must recover on the same retry paths the
    // pressure cards use.
    void this.fetchPressureAdmissionControl();
    // Charts-first: the history-only read returns immediately (rehydrated
    // rings + freshness), so pressure charts paint right after a gateway
    // restart while the full snapshot resolves attribution in the background.
    if (!this.resourcePressure) {
      void gateway
        .request<ResourcePressureHistoryResult>(
          Methods.RESOURCE_PRESSURE_HISTORY,
          this.pressureRequestParams(),
        )
        .then((history) => {
          if (epoch !== this._resourcePressureFetchEpoch || this.resourcePressure) return;
          this.resourcePressureHistory = history;
        })
        .catch((err: unknown) => {
          // First-paint acceleration only. The full snapshot below is the
          // authoritative fetch and reports its own failure.
          console.warn(
            '[fleet-canvas] resource pressure history fetch failed:',
            err instanceof Error ? err.message : String(err),
          );
        });
    }
    try {
      const snapshot = await gateway.request<ResourcePressureSnapshotResult>(
        Methods.RESOURCE_PRESSURE_SNAPSHOT,
        this.pressureRequestParams(),
      );
      if (epoch !== this._resourcePressureFetchEpoch) return;
      this.resourcePressure = snapshot;
      this.resourceWatchesEnabled = snapshot.watchState.enabled;
    } catch (err) {
      console.warn(
        '[fleet-canvas] resource pressure fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private openMachinePause(machine: string) {
    this.machinePauseMachine = machine;
    this.machinePauseMode = 'orchestration';
    this.machinePausePreview = undefined;
    this.machinePauseStatus = undefined;
    this.machinePauseRestorePreview = undefined;
    this.machinePauseActionError = '';
    this._machinePauseSelector = { kind: 'all' };
    this._machinePauseRestoreSelector = { kind: 'all' };
    this.machinePauseConnectionStale = gateway.connectionState !== 'connected';
    if (!this.machinePauseConnectionStale) void this.fetchMachinePauseState(true);
  }

  private closeMachinePause() {
    this._machinePauseFetchEpoch += 1;
    this.clearMachinePauseEventRefresh();
    this.machinePauseMachine = '';
    this.machinePausePreview = undefined;
    this.machinePauseStatus = undefined;
    this.machinePauseRestorePreview = undefined;
    this.machinePauseBusy = null;
    this.machinePauseActionError = '';
    this.machinePauseConnectionStale = false;
    this._machinePauseSelector = { kind: 'all' };
    this._machinePauseRestoreSelector = { kind: 'all' };
  }

  private clearMachinePauseEventRefresh() {
    if (this._machinePauseEventTimer) clearTimeout(this._machinePauseEventTimer);
    this._machinePauseEventTimer = undefined;
  }

  private async setMachinePauseMode(mode: MachinePauseMode) {
    if (mode === this.machinePauseMode) return;
    this.machinePauseMode = mode;
    this._machinePauseSelector = { kind: 'all' };
    this.machinePausePreview = undefined;
    if (gateway.connectionState === 'connected') await this.fetchMachinePauseState(true);
  }

  private async fetchMachinePauseState(showBusy: boolean) {
    const machine = this.machinePauseMachine;
    if (!machine || gateway.connectionState !== 'connected') {
      if (machine) this.machinePauseConnectionStale = true;
      return;
    }
    const epoch = ++this._machinePauseFetchEpoch;
    if (showBusy) {
      this.machinePauseBusy = 'loading';
      this.machinePauseActionError = '';
    }
    try {
      const [preview, status, restorePreview] = await Promise.all([
        gateway.request<MachinePausePreviewResult>(Methods.MACHINE_PAUSE_PREVIEW, {
          machine,
          mode: this.machinePauseMode,
          selector: this._machinePauseSelector,
        }),
        gateway.request<MachinePauseStatusResult>(Methods.MACHINE_PAUSE_STATUS, { machine }),
        gateway.request<MachinePauseRestoreResult>(Methods.MACHINE_PAUSE_RESTORE, {
          machine,
          selector: this._machinePauseRestoreSelector,
        }),
      ]);
      if (epoch !== this._machinePauseFetchEpoch || machine !== this.machinePauseMachine) return;
      this.machinePausePreview = preview;
      this.machinePauseStatus = status;
      this.machinePauseRestorePreview = restorePreview;
      this.machinePauseConnectionStale = false;
    } catch (err) {
      if (epoch !== this._machinePauseFetchEpoch || machine !== this.machinePauseMachine) return;
      this.machinePauseActionError = `Machine state refresh failed: ${err instanceof Error ? err.message : String(err)}`;
      this.machinePauseConnectionStale = true;
    } finally {
      if (showBusy && machine === this.machinePauseMachine && this.machinePauseBusy === 'loading') {
        this.machinePauseBusy = null;
      }
    }
  }

  private async setMachinePauseSelection(detail: {
    scope: 'pause' | 'restore';
    selector: MachinePauseSelector;
  }) {
    if (!this.machinePauseMachine || this.machinePauseBusy) return;
    if (detail.scope === 'pause') this._machinePauseSelector = detail.selector;
    else this._machinePauseRestoreSelector = detail.selector;
    const epoch = ++this._machinePauseFetchEpoch;
    this.machinePauseBusy = 'preview';
    this.machinePauseActionError = '';
    const machine = this.machinePauseMachine;
    try {
      if (detail.scope === 'pause') {
        const preview = await gateway.request<MachinePausePreviewResult>(
          Methods.MACHINE_PAUSE_PREVIEW,
          {
            machine,
            mode: this.machinePauseMode,
            selector: detail.selector,
          },
        );
        if (epoch === this._machinePauseFetchEpoch && machine === this.machinePauseMachine) {
          this.machinePausePreview = preview;
        }
      } else {
        const preview = await gateway.request<MachinePauseRestoreResult>(
          Methods.MACHINE_PAUSE_RESTORE,
          { machine, selector: detail.selector },
        );
        if (epoch === this._machinePauseFetchEpoch && machine === this.machinePauseMachine) {
          this.machinePauseRestorePreview = preview;
        }
      }
    } catch (err) {
      if (epoch === this._machinePauseFetchEpoch && machine === this.machinePauseMachine) {
        this.machinePauseActionError = `Selection preview failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      if (machine === this.machinePauseMachine && this.machinePauseBusy === 'preview') {
        this.machinePauseBusy = null;
      }
    }
  }

  private onMachinePauseUpdated(payload: MachinePauseUpdatedPayload) {
    if (payload.machine !== this.machinePauseMachine) return;
    const records = this.machinePauseStatus?.records ?? [];
    const next = records.filter((record) => record.runId !== payload.record.runId);
    next.push(payload.record);
    this.machinePauseStatus = {
      machine: payload.machine,
      records: sortMachinePauseRecords(next),
      ...(this.machinePauseStatus?.pressure ? { pressure: this.machinePauseStatus.pressure } : {}),
    };
    if (!machinePauseShouldRefetch('progress', this.machinePauseBusy)) return;
    if (this._machinePauseEventTimer) clearTimeout(this._machinePauseEventTimer);
    this._machinePauseEventTimer = setTimeout(() => {
      this._machinePauseEventTimer = undefined;
      void this.fetchMachinePauseState(false);
    }, 150);
  }

  private async executeMachinePause(params: MachinePauseExecuteParams) {
    if (params.machine !== this.machinePauseMachine || this.machinePauseBusy) return;
    this.clearMachinePauseEventRefresh();
    this.machinePauseBusy = 'execute';
    this.machinePauseActionError = '';
    try {
      const result = await gateway.request<MachinePauseExecuteResult>(
        Methods.MACHINE_PAUSE_EXECUTE,
        params,
      );
      if (params.machine !== this.machinePauseMachine) return;
      this.machinePauseStatus = {
        machine: result.machine,
        records: result.records,
        ...(result.pressure ? { pressure: result.pressure } : {}),
      };
      if (!result.ok) {
        this.machinePauseActionError = `Pause ${result.outcome}; inspect the durable per-run errors and residuals below.`;
      }
      if (machinePauseShouldRefetch('completion', this.machinePauseBusy)) {
        await this.fetchMachinePauseState(false);
      }
    } catch (err) {
      if (params.machine === this.machinePauseMachine) {
        this.machinePauseActionError = `Pause failed: ${err instanceof Error ? err.message : String(err)}`;
        if (machinePauseShouldRefetch('completion', this.machinePauseBusy)) {
          await this.fetchMachinePauseState(false);
        }
      }
    } finally {
      if (params.machine === this.machinePauseMachine && this.machinePauseBusy === 'execute') {
        this.machinePauseBusy = null;
      }
    }
  }

  private async restoreMachinePause(params: Extract<MachinePauseRestoreParams, { execute: true }>) {
    if (params.machine !== this.machinePauseMachine || this.machinePauseBusy) return;
    this.clearMachinePauseEventRefresh();
    this.machinePauseBusy = 'restore';
    this.machinePauseActionError = '';
    try {
      const result = await gateway.request<MachinePauseRestoreResult>(
        Methods.MACHINE_PAUSE_RESTORE,
        params,
      );
      if (params.machine !== this.machinePauseMachine) return;
      this.machinePauseStatus = {
        machine: result.machine,
        records: result.records,
        ...(result.pressure ? { pressure: result.pressure } : {}),
      };
      if (!result.ok) {
        this.machinePauseActionError = `Restore ${result.outcome}; inspect the durable per-run errors and residuals below.`;
      }
      if (machinePauseShouldRefetch('completion', this.machinePauseBusy)) {
        await this.fetchMachinePauseState(false);
      }
    } catch (err) {
      if (params.machine === this.machinePauseMachine) {
        this.machinePauseActionError = `Restore failed: ${err instanceof Error ? err.message : String(err)}`;
        if (machinePauseShouldRefetch('completion', this.machinePauseBusy)) {
          await this.fetchMachinePauseState(false);
        }
      }
    } finally {
      if (params.machine === this.machinePauseMachine && this.machinePauseBusy === 'restore') {
        this.machinePauseBusy = null;
      }
    }
  }

  private pressureRequestParams(): ResourcePressureSnapshotParams {
    const machines = this.pressureScopedMachines;
    return {
      ...(machines ? { machines } : {}),
      ...(this.filterProjects.length > 0 ? { projects: this.filterProjects } : {}),
    };
  }

  private get filteredSlots(): SlotStatus[] {
    let result = this.resourceScopedSlots;
    if (this.search) {
      const q = this.search.toLowerCase();
      result = result.filter(
        (s) =>
          s.slot.toLowerCase().includes(q) ||
          s.branch.toLowerCase().includes(q) ||
          (s.taskId?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }

  private get resourceScopedSlots(): SlotStatus[] {
    return this.slots.filter(
      (slot) =>
        (this.filterProjects.length === 0 || this.filterProjects.includes(slot.project)) &&
        (this.filterMachines.length === 0 || this.filterMachines.includes(slot.machine)),
    );
  }

  private get groups(): Array<{ key: string; slots: SlotStatus[] }> {
    const filtered = this.filteredSlots;
    const map = new Map<string, SlotStatus[]>();
    for (const s of filtered) {
      const key = this.groupBy === 'machine' ? s.machine : s.project;
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, slots]) => ({ key, slots }));
  }

  private get resourceGroups(): ResourceGroup[] {
    const filtered = this.filteredSlots;
    const groupMap = new Map<string, { label: string; entries: ResourceEntry[] }>();

    for (const s of filtered) {
      const defs = this.slotResourceDefs.get(s.slot);
      const statuses = this.slotResourceStatus.get(s.slot);
      if (!defs) continue;

      for (const res of defs) {
        const status = statuses?.get(res.id) ?? 'unknown';
        if (!groupMap.has(res.id)) {
          groupMap.set(res.id, { label: res.definition.label, entries: [] });
        }
        groupMap.get(res.id)!.entries.push({
          slotId: s.slot,
          machine: s.machine,
          status,
          controllable: res.definition.controllable,
          label: res.definition.label,
          hasBoot: !!res.definition.hooks?.boot,
          hasShutdown: !!res.definition.hooks?.shutdown,
          hasRelaunch: !!res.definition.hooks?.relaunch,
        });
      }
    }

    return Array.from(groupMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => ({ key, label: val.label, entries: val.entries }));
  }

  private get pressureVisibleMachines(): string[] | undefined {
    if (
      this.filterMachines.length === 0 &&
      this.filterProjects.length === 0 &&
      this.search.length === 0
    )
      return undefined;
    if (this.search.length > 0) {
      return [...new Set(this.filteredSlots.map((slot) => slot.machine))];
    }
    return this.pressureScopedMachines;
  }

  private get pressureScopedMachines(): string[] | undefined {
    if (this.filterMachines.length === 0 && this.filterProjects.length === 0) return undefined;
    return [...new Set(this.resourceScopedSlots.map((slot) => slot.machine))];
  }

  private setGroupBy(mode: FleetCanvasGroupBy) {
    this.groupBy = mode;
    localStorage.setItem('farmslot:fleet-groupBy', mode);
    this._writeUrlParams();
    if (mode === 'resource' && !this._resourceFetched) {
      this.fetchResourceData();
    }
  }

  private setViewMode(mode: FleetCanvasViewMode) {
    this.viewMode = mode;
    localStorage.setItem('farmslot:fleet-viewMode', mode);
    this._writeUrlParams();
  }

  private showResourceFlash(message: string, ok: boolean) {
    this.resourceActionFlash = `${ok ? 'ok' : 'err'}:${message}`;
    setTimeout(() => {
      this.resourceActionFlash = '';
      this.requestUpdate();
    }, 5000);
  }

  private async previewResourceCleanup() {
    this.resourceActionBusy = true;
    try {
      const snapshot = await gateway.request<ResourcePressureSnapshotResult>(
        Methods.RESOURCE_PRESSURE_SNAPSHOT,
        this.pressureRequestParams(),
      );
      this.resourcePressure = snapshot;
      this.resourceCleanupPreview = this.cleanupPreviewForFilters(snapshot);
    } catch (err) {
      this.showResourceFlash(err instanceof Error ? err.message : String(err), false);
    } finally {
      this.resourceActionBusy = false;
    }
  }

  private async confirmResourceCleanup(selected: ResourcePressureCleanupCandidate[]) {
    const reviewed = this.resourceCleanupPreview;
    if (!reviewed || selected.length === 0) return;
    const reviewedKeys = new Set(
      cleanupExecutionTargets(reviewed.cleanupCandidates).map(
        (target) => `${target.machine}:${target.slotId}:${target.resourceId}`,
      ),
    );
    const selectedTargets = cleanupExecutionTargets(selected);
    if (
      selectedTargets.some(
        (target) => !reviewedKeys.has(`${target.machine}:${target.slotId}:${target.resourceId}`),
      )
    ) {
      this.showResourceFlash('selected cleanup target is not in the reviewed preview', false);
      return;
    }
    this.resourceActionBusy = true;
    try {
      const fresh = await gateway.request<ResourceCleanupResult>(Methods.RESOURCE_CLEANUP, {
        dryRun: true,
        targets: selectedTargets,
      });
      const freshTargets = this.cleanupTargetsForFilters(fresh.targets);
      if (!cleanupTargetsRemainEligible(selectedTargets, freshTargets)) {
        const snapshot = await gateway.request<ResourcePressureSnapshotResult>(
          Methods.RESOURCE_PRESSURE_SNAPSHOT,
          this.pressureRequestParams(),
        );
        this.resourcePressure = snapshot;
        this.resourceCleanupPreview = this.cleanupPreviewForFilters(snapshot);
        this.showResourceFlash('eligible targets changed — review the updated preview', false);
        return;
      }
      const result = await gateway.request<ResourceCleanupResult>(Methods.RESOURCE_CLEANUP, {
        dryRun: false,
        targets: selectedTargets,
      });
      this.showResourceFlash(
        `stopped ${result.stopped}/${selectedTargets.length}${result.failed ? `, failed ${result.failed}` : ''}`,
        result.ok,
      );
      this.resourceCleanupPreview = undefined;
      await this.fetchResourceData();
    } catch (err) {
      this.showResourceFlash(err instanceof Error ? err.message : String(err), false);
    } finally {
      this.resourceActionBusy = false;
    }
  }

  private cleanupTargetsForFilters<T extends { machine: string; project?: string; slotId: string }>(
    targets: T[],
  ): T[] {
    const searchedSlots = new Set(this.filteredSlots.map((slot) => `${slot.machine}:${slot.slot}`));
    return targets.filter(
      (target) =>
        (this.filterMachines.length === 0 || this.filterMachines.includes(target.machine)) &&
        (this.filterProjects.length === 0 ||
          (target.project != null && this.filterProjects.includes(target.project))) &&
        (this.search.length === 0 || searchedSlots.has(`${target.machine}:${target.slotId}`)),
    );
  }

  private cleanupPreviewForFilters(
    snapshot: ResourcePressureSnapshotResult,
  ): ResourcePressureSnapshotResult {
    const cleanupCandidates = this.cleanupTargetsForFilters(snapshot.cleanupCandidates);
    return {
      ...snapshot,
      summary: { ...snapshot.summary, cleanupCandidates: cleanupCandidates.length },
      cleanupCandidates,
    };
  }

  /** Durable gateway-owned kill switch for pressure-based dispatch prevention.
   * Backend-driven: this control only renders and forwards the state. The
   * gateway persists it (with updatedAt/updatedBy) and the policy returns
   * admitted state='disabled' when off. */
  private async setPressureAdmission(enabled: boolean) {
    if (
      !enabled &&
      !window.confirm(
        'Disable pressure-based dispatch prevention? New dispatches will no longer be rejected on sustained pressure until re-enabled. Sampling, history, and charts continue; no other safety check changes.',
      )
    ) {
      return;
    }
    this.resourceActionBusy = true;
    try {
      const state = await gateway.request<PressureAdmissionSetEnabledResult>(
        Methods.DISPATCH_PRESSURE_ADMISSION_SET_ENABLED,
        { enabled },
      );
      this.pressureAdmissionControl = state;
      this.showResourceFlash(`pressure admission ${state.enabled ? 'enabled' : 'disabled'}`, true);
      // Fresh decisions immediately: refetch the pressure cards. The dispatch
      // wizard mounts per-route and fetches candidates on entry, and its
      // rejection panel has an explicit "Refresh decision" action, so a
      // previously rendered blocker never outlives a re-fetch after the toggle.
      void this.fetchResourcePressure();
    } catch (err) {
      this.showResourceFlash(err instanceof Error ? err.message : String(err), false);
    } finally {
      this.resourceActionBusy = false;
    }
  }

  /** Debounced LIGHTWEIGHT history refetch for node health/reconnect events.
   * Never triggers the full snapshot; only relevant while the resource view
   * is showing pressure data. */
  private schedulePressureHistoryRefresh(): void {
    if (this.groupBy !== 'resource' || this._pressureHistoryRefreshTimer) return;
    this._pressureHistoryRefreshTimer = setTimeout(() => {
      this._pressureHistoryRefreshTimer = undefined;
      gateway
        .request<ResourcePressureHistoryResult>(
          Methods.RESOURCE_PRESSURE_HISTORY,
          this.pressureRequestParams(),
        )
        .then((history) => {
          this.resourcePressureHistory = history;
        })
        .catch((err: unknown) => {
          console.warn(
            '[fleet-canvas] pressure history event refresh failed:',
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 2_000);
  }

  private scheduleResourcePressureRecoveryRefresh(): void {
    if (this.groupBy !== 'resource' || this._resourcePressureRecoveryTimer) return;
    this._resourcePressureRecoveryTimer = setTimeout(() => {
      this._resourcePressureRecoveryTimer = undefined;
      void this.fetchResourcePressure();
    }, 2_000);
  }

  private async fetchPressureAdmissionControl() {
    try {
      this.pressureAdmissionControl = await gateway.request<PressureAdmissionGetResult>(
        Methods.DISPATCH_PRESSURE_ADMISSION_GET,
        {},
      );
    } catch (err) {
      console.warn(
        '[fleet-canvas] pressure admission control fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async setResourceWatches(enabled: boolean) {
    if (
      !enabled &&
      !window.confirm(
        'Pause resource liveness watches? This stops background resource probes and marks cached resource status unknown. It does not stop apps, agents, builds, or host pressure metrics.',
      )
    ) {
      return;
    }
    this.resourceActionBusy = true;
    try {
      const result = await gateway.request<ResourceWatchSetEnabledResult>(
        Methods.RESOURCE_WATCH_SET_ENABLED,
        { enabled },
      );
      this.resourceWatchesEnabled = result.enabled;
      this.showResourceFlash(
        `${enabled ? 'resumed' : 'paused'} watches on ${result.affectedMachines.length} machine${result.affectedMachines.length === 1 ? '' : 's'}`,
        result.ok,
      );
      if (!enabled) await this.fetchResourceData();
    } catch (err) {
      this.showResourceFlash(err instanceof Error ? err.message : String(err), false);
    } finally {
      this.resourceActionBusy = false;
    }
  }

  render() {
    return html`
      <div
        style="display: contents"
        @fleet-slot-recovery=${(event: CustomEvent<{ slotId: string; inspectOnly: boolean }>) => {
          this.recoverySlotId = event.detail.slotId;
          this.recoveryInspectOnly = event.detail.inspectOnly;
          this.fleetRefreshOpen = true;
        }}
      >
        <div class="toolbar">
          <div class="toggle-group">
            <button
              class="toggle-btn ${this.groupBy === 'machine' ? 'active' : ''}"
              @click=${() => this.setGroupBy('machine')}
            >
              machine
            </button>
            <button
              class="toggle-btn ${this.groupBy === 'project' ? 'active' : ''}"
              @click=${() => this.setGroupBy('project')}
            >
              project
            </button>
            <button
              class="toggle-btn ${this.groupBy === 'resource' ? 'active' : ''}"
              @click=${() => this.setGroupBy('resource')}
            >
              resource
            </button>
          </div>
          <div class="toggle-group">
            <button
              class="toggle-btn ${this.viewMode === 'card' ? 'active' : ''}"
              @click=${() => this.setViewMode('card')}
            >
              cards
            </button>
            <button
              class="toggle-btn ${this.viewMode === 'list' ? 'active' : ''}"
              data-testid="fleet-view-list"
              @click=${() => this.setViewMode('list')}
            >
              list
            </button>
          </div>
          <input
            type="text"
            placeholder="search slots..."
            @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
          />
          ${this.renderFleetRefreshTrigger()} ${this.renderProgressReadStatus()}
          ${heldDataIsSaved(this.fleetObservation)
            ? html`<span
                class="rehydrating-banner"
                data-fleet-freshness="stale"
                title=${`Saved fleet, ${sourceObservationAge(this.fleetObservation.observedAt, this.now)}. Actions wait for a current read.`}
              >
                Saved fleet, ${sourceObservationAge(this.fleetObservation.observedAt, this.now)}.
                Actions wait for a current read.
              </span>`
            : ''}
          ${heldDataIsSaved(this.nodeQuery.state)
            ? html`<span
                class="rehydrating-banner"
                data-node-freshness="stale"
                title=${`Saved nodes, ${sourceObservationAge(this.nodeQuery.state.observedAt, this.now)}.`}
              >
                Saved nodes, ${sourceObservationAge(this.nodeQuery.state.observedAt, this.now)}.
              </span>`
            : ''}
          ${this.nodeQuery.state.error
            ? html`<span role="alert"
                >Could not read nodes: ${this.nodeQuery.state.error.message}
                <button @click=${() => this.nodeQuery.retry()}>Retry reading nodes</button>
              </span>`
            : ''}
          ${this.fleetObservation.data?.fleet.stale
            ? html`<span class="rehydrating-banner"
                >Fleet source is stale. Actions wait for a fresh observation.</span
              >`
            : ''}
          ${this.fleetObservation.status === 'unsupported'
            ? html`<span class="rehydrating-banner"
                >Live fleet updates are unavailable on this gateway.</span
              >`
            : ''}
          ${this.fleetObservation.error
            ? html`<span role="alert"
                >Could not read fleet: ${this.fleetObservation.error.message}
                <button @click=${() => getResourceCache()?.retry(fleetQuery)}>
                  Retry reading fleet
                </button>
              </span>`
            : ''}
        </div>
        <div class="canvas">
          ${this.groupBy === 'resource' ? this.renderResourceView() : this.renderGroupView()}
        </div>
        <slot-actions-modal
          slot-id=${this.actionsModalSlotId}
          ?open=${!!this.actionsModalSlotId}
          @close=${() => {
            this.actionsModalSlotId = '';
          }}
        ></slot-actions-modal>
        <fleet-refresh-modal
          .slotIds=${this.filteredSlots.map((slot) => slot.slot)}
          .singleSlotId=${this.recoverySlotId}
          .inspectOnly=${this.recoveryInspectOnly}
          ?open=${this.fleetRefreshOpen}
          @close=${() => {
            this.fleetRefreshOpen = false;
            this._writeUrlParams();
          }}
        ></fleet-refresh-modal>
      </div>
    `;
  }

  private renderFleetRefreshTrigger() {
    const { count: eligible, canInspect } = fleetRecoverySummary(this.filteredSlots);
    const label = eligible === 0 ? 'Release idle slots' : `Release idle slots (${eligible})`;
    return html`
      <button
        class="toggle-btn fleet-refresh-trigger ${eligible > 0 ? 'has-eligible' : ''}"
        ?disabled=${!canInspect || this.fleetRefreshOpen}
        title=${eligible === 0
          ? 'No eligible slots — every slot is busy, held, or disabled'
          : 'Bulk refresh idle slots'}
        @click=${() => {
          this.recoverySlotId = '';
          this.recoveryInspectOnly = false;
          this.fleetRefreshOpen = true;
          this._writeUrlParams();
        }}
      >
        ${label}
      </button>
    `;
  }
  private renderGroupView() {
    if (this.bootstrapFailed && this.slots.length === 0) {
      return renderFleetSkeleton('Fleet unavailable', () => gateway.reconnect());
    }
    if (this.hydrating && this.slots.length === 0) {
      return renderFleetSkeleton();
    }
    if (this.groups.length === 0) {
      return html`<div class="empty">
        No slots${this.slots.length === 0 ? ' — waiting for fleet data' : ' match filters'}
      </div>`;
    }
    return this.groups.map(
      (g) => html`
        <machine-group
          .machine=${g.key}
          .slots=${g.slots}
          .onlineMachines=${this.onlineMachines}
          .slotProgress=${this.slotProgress}
          .slotRuns=${this.slotRuns}
          .machineHealth=${this.machineHealthMap.get(g.key)}
          .machineHealthMap=${this.machineHealthMap}
          .slotThumbnails=${this.slotThumbnails}
          .slotDecisions=${this.slotDecisions}
          .slotPendingWork=${this.slotPendingWork}
          .nodeInfo=${this.nodeInfo.get(g.key)}
          .nodeInfoMap=${this.nodeInfo}
          .gatewayProtocolVersion=${this.gatewayProtocolVersion}
          .viewMode=${this.viewMode}
          .providerAccounts=${this.providerAccountsQuery.state.data?.machines.find(
            (snapshot) => snapshot.machine === g.key,
          )}
          .providerAccountsError=${this.providerAccountsRefreshError ||
          this.providerAccountsQuery.state.error?.message ||
          undefined}
          .providerAccountsFetching=${this.providerAccountsQuery.state.status === 'loading' ||
          this.providerAccountsRefreshing.has(g.key)}
          .providerAccountsActionable=${gateway.connectionState === 'connected'}
          @provider-accounts-refresh=${(e: CustomEvent<{ machine?: string; force?: boolean }>) =>
            void this._refreshProviderAccounts(e.detail?.machine, e.detail?.force === true)}
          @slot-selected=${(e: CustomEvent) => {
            location.hash = `slot/${e.detail.slotId}`;
          }}
          @slot-terminal=${(e: CustomEvent) => {
            location.hash = `terminal/${e.detail.slotId}`;
          }}
          @slot-actions-open=${(e: CustomEvent) => {
            this.actionsModalSlotId = e.detail.slotId;
          }}
        ></machine-group>
      `,
    );
  }

  private renderResourceView() {
    if (this.bootstrapFailed && this.slots.length === 0) {
      return renderFleetSkeleton('Fleet unavailable', () => gateway.reconnect());
    }
    if (this.hydrating && this.slots.length === 0) {
      return renderFleetSkeleton();
    }
    // Never block the pressure section on the slower per-slot resource
    // batches. machine-pressure-overview paints from the fast history read
    // first; the resource groups get their own loading placeholder below.
    const groups = this.resourceGroups;
    return html`
      <div class="resource-controls">
        <span>Resource pressure</span>
        <button ?disabled=${this.resourceActionBusy} @click=${() => this.fetchResourcePressure()}>
          Refresh pressure
        </button>
        <button
          title="Inspect the exact eligible resources and estimated process impact; does not stop anything"
          ?disabled=${this.resourceActionBusy}
          @click=${() => this.previewResourceCleanup()}
        >
          Preview cleanup
        </button>
        <button
          class="danger"
          title="Opens the same impact preview; shutdown requires a second explicit action"
          ?disabled=${this.resourceActionBusy}
          @click=${() => this.previewResourceCleanup()}
        >
          Review & stop idle
        </button>
        <button
          title="Stops background resource liveness probes only; does not stop apps, agents, builds, or pressure metrics"
          ?disabled=${this.resourceActionBusy || !this.resourceWatchesEnabled}
          @click=${() => this.setResourceWatches(false)}
        >
          Pause watches
        </button>
        <button
          title="Restarts node-owned resource liveness probes and repopulates cached resource status"
          ?disabled=${this.resourceActionBusy || this.resourceWatchesEnabled}
          @click=${() => this.setResourceWatches(true)}
        >
          Resume watches
        </button>
        ${this.pressureAdmissionControl
          ? html`<button
                class=${this.pressureAdmissionControl.enabled ? '' : 'danger'}
                data-testid="pressure-admission-toggle"
                title=${this.pressureAdmissionControl.updatedAt
                  ? `Last change ${this.pressureAdmissionControl.updatedAt} by ${this.pressureAdmissionControl.updatedBy ?? 'unknown'}. Only pressure rejection/override prompts pause; sampling and charts continue.`
                  : 'Gateway default (enabled). Only pressure rejection/override prompts pause; sampling and charts continue.'}
                ?disabled=${this.resourceActionBusy}
                @click=${() => this.setPressureAdmission(!this.pressureAdmissionControl!.enabled)}
              >
                ${this.pressureAdmissionControl.enabled
                  ? 'Disable pressure dispatch gate'
                  : 'Enable pressure dispatch gate'}
              </button>
              ${this.pressureAdmissionControl.enabled
                ? ''
                : html`<span
                    class="resource-watch-note"
                    style="color:${colors.statusWarn}"
                    data-testid="pressure-admission-disabled-note"
                  >
                    Pressure dispatch prevention is OFF; new dispatches are not pressure-gated.
                  </span>`}`
          : ''}
        ${this.resourceActionFlash
          ? html`<span
              class="${this.resourceActionFlash.startsWith('ok:')
                ? 'resource-flash-ok'
                : 'resource-flash-err'}"
              >${this.resourceActionFlash.slice(this.resourceActionFlash.indexOf(':') + 1)}</span
            >`
          : ''}
        <span class="resource-watch-note">
          Watches track resource liveness from cached node probes. Pausing stops those probes and
          marks resource status unknown; it does not stop apps, agents, builds, or host pressure
          metrics. Global selectors and slot search limit visible machine cards and cleanup rows;
          pressure values remain whole-machine.
        </span>
      </div>
      <machine-pressure-overview
        .snapshot=${this.resourcePressure}
        .historyPreview=${this.resourcePressureHistory}
        .visibleMachines=${this.pressureVisibleMachines}
        @machine-pressure-open=${(event: CustomEvent<{ machine: string }>) =>
          this.openMachinePause(event.detail.machine)}
      ></machine-pressure-overview>
      ${this.machinePauseMachine
        ? html`<machine-pause-dialog
            .open=${true}
            .machine=${this.machinePauseMachine}
            .mode=${this.machinePauseMode}
            .preview=${this.machinePausePreview}
            .status=${this.machinePauseStatus}
            .restorePreview=${this.machinePauseRestorePreview}
            .busy=${this.machinePauseBusy}
            .actionError=${this.machinePauseActionError}
            .connectionStale=${this.machinePauseConnectionStale}
            @machine-pause-close=${this.closeMachinePause}
            @machine-pause-refresh=${() => this.fetchMachinePauseState(true)}
            @machine-pause-mode-change=${(event: CustomEvent<{ mode: MachinePauseMode }>) =>
              this.setMachinePauseMode(event.detail.mode)}
            @machine-pause-execute=${(event: CustomEvent<MachinePauseExecuteParams>) =>
              this.executeMachinePause(event.detail)}
            @machine-pause-selection-change=${(
              event: CustomEvent<{
                scope: 'pause' | 'restore';
                selector: MachinePauseSelector;
              }>,
            ) => this.setMachinePauseSelection(event.detail)}
            @machine-pause-restore=${(
              event: CustomEvent<Extract<MachinePauseRestoreParams, { execute: true }>>,
            ) => this.restoreMachinePause(event.detail)}
          ></machine-pause-dialog>`
        : ''}
      ${this.resourceCleanupPreview
        ? html`<resource-cleanup-preview
            .snapshot=${this.resourceCleanupPreview}
            .busy=${this.resourceActionBusy}
            @cleanup-preview-close=${() => {
              if (!this.resourceActionBusy) this.resourceCleanupPreview = undefined;
            }}
            @cleanup-preview-confirm=${(
              event: CustomEvent<{ targets: ResourcePressureCleanupCandidate[] }>,
            ) => this.confirmResourceCleanup(event.detail.targets)}
          ></resource-cleanup-preview>`
        : ''}
      ${!this._resourceFetched
        ? html`<div class="empty">Resource details loading…</div>`
        : groups.length === 0
          ? html`<div class="empty">No resources found</div>`
          : groups.map(
              (g) => html`
                <resource-overview
                  .resourceId=${g.key}
                  .label=${g.label}
                  .entries=${g.entries}
                  .onlineMachines=${this.onlineMachines}
                  @refresh-resources=${() => this.fetchResourceData()}
                ></resource-overview>
              `,
            )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fleet-canvas': FleetCanvas;
  }
}
