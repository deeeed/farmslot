import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  FleetThumbnailsUpdatedPayload,
  MachineHealth,
  NodeConnectedPayload,
  NodeDisconnectedPayload,
  NodeHealthUpdatedPayload,
  NodeInfo,
  NodesListResult,
  ResourceCleanupResult,
  ResourceListResult,
  ResourcePressureCleanupCandidate,
  ResourcePressureSnapshotResult,
  ResourceStatus,
  ResourceStatusUpdatedPayload,
  ResourceWatchSetEnabledResult,
  Run,
  SlotResource,
  SlotStatus,
  TaskProgressResult,
  TaskProgressStructured,
  TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import { Events, Methods, primaryRoleForFlow } from '@farmslot/protocol';

import './machine-group.js';
import './machine-pressure-overview.js';
import './resource-cleanup-preview.js';
import './resource-overview.js';
import '../slot-actions/slot-actions-modal.js';
import '../slot-actions/fleet-refresh-modal.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { providerAccountsStore } from '../../provider-accounts-store.js';
import {
  type AppState,
  getProjectSlotTrackingConfigs,
  getState,
  isHydrating,
  subscribe,
} from '../../state.js';
import { getRunForSlot } from '../../state.js';
import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { summarizeFleetRefreshEligibility } from '../slot-actions/fleet-refresh-modal-model.js';
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
  @state() private groupBy: FleetCanvasGroupBy = 'machine';
  @state() private filterProjects: string[] = [];
  @state() private filterMachines: string[] = [];
  @state() private search = '';
  @state() private onlineMachines: Set<string> = new Set();
  @state() private nodeInfo: Map<string, NodeInfo> = new Map();
  @state() private gatewayProtocolVersion = '';
  @state() private slotProgress: Map<string, TaskProgressStructured> = new Map();
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
  @state() private resourceCleanupPreview?: ResourcePressureSnapshotResult;
  /** machine → provider subscription snapshot (labels only). */
  private _providerAccountsUnsub: (() => void) | null = null;
  private _resourceFetched = false;
  private unsub?: () => void;
  private _unsubConnected?: () => void;
  private _unsubDisconnected?: () => void;
  private _unsubConnState?: () => void;
  private _unsubFleetRefresh?: () => void;
  private _unsubProgress?: () => void;
  private _unsubRunUpdated?: () => void;
  private _unsubRunCreated?: () => void;
  private _unsubNodeHealth?: () => void;
  private _unsubResourceStatus?: () => void;
  private _unsubThumbnails?: () => void;
  private _progressTimer?: ReturnType<typeof setInterval>;
  private _onHashChange = () => this._readUrlParams();

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
    this._providerAccountsUnsub = providerAccountsStore.subscribe(() => this.requestUpdate());
    this.syncState(getState());
    this.unsub = subscribe((s) => this.syncState(s));

    // Fetch initial agent list — retry whenever gateway reconnects or fleet updates
    this._fetchAgents();
    this._unsubConnState = gateway.onConnectionChange((s) => {
      if (s === 'connected') this._fetchAgents();
    });
    let agentRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    this._unsubFleetRefresh = gateway.subscribe(Events.FLEET_UPDATED, () => {
      if (agentRefreshTimer) clearTimeout(agentRefreshTimer);
      agentRefreshTimer = setTimeout(() => this._fetchAgents(), 5000);
    });

    // Track node connect/disconnect
    this._unsubConnected = gateway.subscribe<NodeConnectedPayload>(Events.NODE_CONNECTED, (p) => {
      this.onlineMachines = new Set([...this.onlineMachines, p.machine]);
      const nextInfo = new Map(this.nodeInfo);
      nextInfo.set(p.machine, {
        machine: p.machine,
        pid: p.pid,
        connectedAt: new Date().toISOString(),
        protocolVersion: p.protocolVersion,
        versionMatch: p.versionMatch ?? p.protocolVersion === this.gatewayProtocolVersion,
      });
      this.nodeInfo = nextInfo;
    });
    this._unsubDisconnected = gateway.subscribe<NodeDisconnectedPayload>(
      Events.NODE_DISCONNECTED,
      (p) => {
        const next = new Set(this.onlineMachines);
        next.delete(p.machine);
        this.onlineMachines = next;
        const nextInfo = new Map(this.nodeInfo);
        nextInfo.delete(p.machine);
        this.nodeInfo = nextInfo;
      },
    );

    // Subscribe to real-time task progress events
    this._unsubProgress = gateway.subscribe<TaskProgressUpdatedPayload>(
      Events.TASK_PROGRESS_UPDATED,
      (p) => {
        const slot = this.slots.find((candidate) => candidate.slot === p.slotId);
        const flowRole = primaryRoleForFlow(slot?.currentFlowType);
        const matchesCurrentRun = !!slot?.currentRunId && p.runId === slot.currentRunId;
        const matchesPrimaryWorker = !p.contextId || p.role === 'primary' || p.role === flowRole;
        if (p.progress.structured && matchesCurrentRun && matchesPrimaryWorker) {
          const next = new Map(this.slotProgress);
          next.set(p.slotId, p.progress.structured);
          this.slotProgress = next;
        }
      },
    );

    // Rebuild slotRuns when runs change
    this._unsubRunUpdated = gateway.subscribe(Events.RUN_UPDATED, () => this.buildSlotRuns());
    this._unsubRunCreated = gateway.subscribe(Events.RUN_CREATED, () => this.buildSlotRuns());

    // Track node health updates
    this._unsubNodeHealth = gateway.subscribe<NodeHealthUpdatedPayload>(
      Events.NODE_HEALTH_UPDATED,
      (p) => {
        const next = new Map(this.machineHealthMap);
        next.set(p.machine, p.health);
        this.machineHealthMap = next;
      },
    );

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

    // Fetch progress on init + poll as fallback (60s)
    this.fetchAllProgress();
    this._progressTimer = setInterval(() => this.fetchAllProgress(), 60_000);

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

  disconnectedCallback() {
    this._providerAccountsUnsub?.();
    this._providerAccountsUnsub = null;
    super.disconnectedCallback();
    this.unsub?.();
    this._unsubConnected?.();
    this._unsubDisconnected?.();
    this._unsubConnState?.();
    this._unsubFleetRefresh?.();
    this._unsubProgress?.();
    this._unsubRunUpdated?.();
    this._unsubRunCreated?.();
    this._unsubNodeHealth?.();
    this._unsubResourceStatus?.();
    this._unsubThumbnails?.();
    if (this._progressTimer) clearInterval(this._progressTimer);
    window.removeEventListener('hashchange', this._onHashChange);
  }

  private async _fetchAgents() {
    try {
      const res = await gateway.request<NodesListResult>(Methods.NODES_LIST);
      this.onlineMachines = new Set(res.nodes.map((a) => a.machine));
      this.gatewayProtocolVersion = res.gatewayProtocolVersion;
      const infoMap = new Map<string, NodeInfo>();
      for (const a of res.nodes) infoMap.set(a.machine, a);
      this.nodeInfo = infoMap;
    } catch (err) {
      console.warn(
        '[fleet-canvas] node list fetch failed; connection change will retry:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async _fetchProviderAccounts(only?: string[], forceRefresh = false) {
    const machines = only ?? [...new Set(this.slots.map((s) => s.machine))];
    if (machines.length === 0) return;
    await providerAccountsStore.fetch(machines, forceRefresh);
  }

  private syncState(s: AppState) {
    const prev = this.slots;
    const previousPressureFilter = JSON.stringify([this.filterProjects, this.filterMachines]);
    this.slots = s.fleet?.slots ?? [];
    this.hydrating = isHydrating(s, 'fleet');
    this.bootstrapFailed = s.bootstrapFailed.fleet;
    this.filterProjects = s.globalFilters.projects;
    this.filterMachines = s.globalFilters.machines;
    const pressureFilterChanged =
      previousPressureFilter !== JSON.stringify([this.filterProjects, this.filterMachines]);
    if (pressureFilterChanged && this.groupBy === 'resource' && this._resourceFetched) {
      void this.fetchResourcePressure();
    }
    // Populate machineHealthMap from fleet.machines
    if (s.fleet?.machines) {
      const next = new Map(this.machineHealthMap);
      for (const mh of s.fleet.machines) next.set(mh.machine, mh);
      this.machineHealthMap = next;
    }
    // Refresh provider subscription chips when fleet machines change
    const prevMachines = new Set(prev.map((sl) => sl.machine));
    const nextMachines = new Set(this.slots.map((sl) => sl.machine));
    if (
      prevMachines.size !== nextMachines.size ||
      [...nextMachines].some((m) => !prevMachines.has(m)) ||
      ([...nextMachines].some((m) => !providerAccountsStore.get(m)) && nextMachines.size > 0)
    ) {
      void this._fetchProviderAccounts();
    }
    // Refresh progress when working slots change
    const prevWorking = new Set(
      prev.filter((sl) => sl.lifecycle === 'busy' && sl.taskFile).map((sl) => sl.slot),
    );
    const newWorking = new Set(
      this.slots.filter((sl) => sl.lifecycle === 'busy' && sl.taskFile).map((sl) => sl.slot),
    );
    if (
      prevWorking.size !== newWorking.size ||
      [...newWorking].some((id) => !prevWorking.has(id))
    ) {
      this.fetchAllProgress();
    }
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

  private async fetchAllProgress() {
    const workingSlots = this.slots.filter((s) => s.lifecycle === 'busy' && s.taskFile);
    if (workingSlots.length === 0) {
      if (this.slotProgress.size > 0) this.slotProgress = new Map();
      return;
    }
    const next = new Map<string, TaskProgressStructured>();
    await Promise.all(
      workingSlots.map(async (s) => {
        try {
          const res = await gateway.request<TaskProgressResult>(Methods.TASK_PROGRESS, {
            slotId: s.slot,
            ...(s.currentRunId ? { runId: s.currentRunId } : {}),
          });
          if (res.structured) next.set(s.slot, res.structured);
        } catch (err) {
          console.warn(
            `[fleet-canvas] task progress fetch failed for ${s.slot}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }),
    );
    this.slotProgress = next;
  }

  private async fetchResourceData() {
    if (this.slots.length === 0) return;

    // Phase 1: fetch resource definitions (fast — reads project.json, no hooks)
    // Renders table immediately with "unknown" status dots
    const nextDefs = new Map<string, SlotResource[]>();
    const nextStatus = new Map<string, Map<string, ResourceStatus>>(this.slotResourceStatus);
    await Promise.all(
      this.slots.map(async (s) => {
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
    this.slotResourceDefs = nextDefs;
    this.slotResourceStatus = nextStatus;
    this._resourceFetched = true;
    await this.fetchResourcePressure();
  }

  private async fetchResourcePressure() {
    try {
      this.resourcePressure = await gateway.request<ResourcePressureSnapshotResult>(
        Methods.RESOURCE_PRESSURE_SNAPSHOT,
        this.pressureRequestParams(),
      );
      this.resourceWatchesEnabled = this.resourcePressure.watchState.enabled;
    } catch (err) {
      console.warn(
        '[fleet-canvas] resource pressure fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private pressureRequestParams(): { machine?: string; project?: string } {
    return {
      ...(this.filterMachines.length === 1 ? { machine: this.filterMachines[0] } : {}),
      ...(this.filterProjects.length === 1 ? { project: this.filterProjects[0] } : {}),
    };
  }

  private get filteredSlots(): SlotStatus[] {
    let result = this.slots;
    if (this.filterProjects.length > 0) {
      result = result.filter((s) => this.filterProjects.includes(s.project));
    }
    if (this.filterMachines.length > 0) {
      result = result.filter((s) => this.filterMachines.includes(s.machine));
    }
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
    if (this.filterMachines.length === 0 && this.filterProjects.length === 0) return undefined;
    return [
      ...new Set(
        this.slots
          .filter(
            (slot) =>
              (this.filterMachines.length === 0 || this.filterMachines.includes(slot.machine)) &&
              (this.filterProjects.length === 0 || this.filterProjects.includes(slot.project)),
          )
          .map((slot) => slot.machine),
      ),
    ];
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
        ...this.pressureRequestParams(),
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
        `stopped ${result.stopped}/${result.targets.length}${result.failed ? `, failed ${result.failed}` : ''}`,
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

  private cleanupTargetsForFilters<T extends { machine: string; project?: string }>(
    targets: T[],
  ): T[] {
    return targets.filter(
      (target) =>
        (this.filterMachines.length === 0 || this.filterMachines.includes(target.machine)) &&
        (this.filterProjects.length === 0 ||
          (target.project != null && this.filterProjects.includes(target.project))),
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
        ${this.renderFleetRefreshTrigger()}
        ${this.bootstrapFailed && this.slots.length > 0
          ? html`<span class="rehydrating-banner">Refresh failed… showing cached fleet state</span>`
          : this.hydrating && this.slots.length > 0
            ? html`<span class="rehydrating-banner">Reconnecting… showing last snapshot</span>`
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
        ?open=${this.fleetRefreshOpen}
        @close=${() => {
          this.fleetRefreshOpen = false;
          this._writeUrlParams();
        }}
      ></fleet-refresh-modal>
    `;
  }

  private renderFleetRefreshTrigger() {
    const { cleanIdle, stale, eligible } = summarizeFleetRefreshEligibility(
      this.slots,
      getProjectSlotTrackingConfigs(),
    );
    const label =
      eligible === 0
        ? 'Refresh idle'
        : `Refresh idle (${cleanIdle} ready${stale > 0 ? `, ${stale} stale` : ''})`;
    return html`
      <button
        class="toggle-btn fleet-refresh-trigger ${eligible > 0 ? 'has-eligible' : ''}"
        ?disabled=${eligible === 0 || this.fleetRefreshOpen}
        title=${eligible === 0
          ? 'No eligible slots — every slot is busy, held, or disabled'
          : 'Bulk refresh idle slots'}
        @click=${() => {
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
      return html`<div class="empty">Fleet refresh failed — no cached fleet data available</div>`;
    }
    if (this.hydrating && this.slots.length === 0) {
      return html`<farm-hydrating message="Loading fleet data…"></farm-hydrating>`;
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
          .providerAccounts=${providerAccountsStore.get(g.key)}
          .providerAccountsError=${providerAccountsStore.error() ?? undefined}
          .providerAccountsFetching=${providerAccountsStore.isFetching(g.key)}
          @provider-accounts-refresh=${(e: CustomEvent<{ machine?: string; force?: boolean }>) =>
            void this._fetchProviderAccounts(
              e.detail?.machine ? [e.detail.machine] : undefined,
              e.detail?.force === true,
            )}
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
      return html`<div class="empty">Fleet refresh failed — no cached fleet data available</div>`;
    }
    if (this.hydrating && this.slots.length === 0) {
      return html`<farm-hydrating message="Loading fleet data…"></farm-hydrating>`;
    }
    const groups = this.resourceGroups;
    if (!this._resourceFetched) {
      return html`<div class="empty">Loading resources...</div>`;
    }
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
          metrics.
        </span>
      </div>
      <machine-pressure-overview
        .snapshot=${this.resourcePressure}
        .visibleMachines=${this.pressureVisibleMachines}
      ></machine-pressure-overview>
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
      ${groups.length === 0
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
