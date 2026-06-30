// <device-grid> — fleet-wide device stream viewer with picker + controls

import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import type {
  FleetStatusResult,
  ResourceControlAction,
  ResourceListResult,
  ResourceStatus,
  ResourceStatusUpdatedPayload,
  ResourceStreamStatus,
  SlotResource,
  SlotStatus,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import '../stream-feed/stream-feed.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getRunForSlot, getState, isHydrating, subscribe } from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import {
  isDeviceGridResourceApplicable,
  isDeviceGridResourceLive,
  resolveDeviceGridResourceStatus,
} from './device-grid-model.js';

type LayoutMode = 'auto' | '1x1' | '2x1' | '2x2' | '3x2' | '4x2';

interface DevicePane {
  slotId: string;
  resourceId: string;
}

interface AvailableResource {
  slotId: string;
  resourceId: string;
  resourceLabel: string;
  workSummary: string;
  platform: string;
  status: ResourceStatus;
  stream?: ResourceStreamStatus;
  machine: string;
  hasBoot: boolean;
  hasShutdown: boolean;
  hasRelaunch: boolean;
}

const PANES_KEY = 'farmslot:device-grid:panes';
const LAYOUT_KEY = 'farmslot:device-grid:layout';

@customElement('device-grid')
export class DeviceGrid extends LitElement {
  @state() private _panes: DevicePane[] = [];
  @state() private _layout: LayoutMode = 'auto';
  @state() private _pickerOpen = false;
  @state() private _availableResources: AvailableResource[] = [];
  @state() private _resourceStatuses = new Map<string, ResourceStatus>();
  @state() private _hydrating = false;

  private _unsubFleet?: () => void;
  private _unsubResource?: () => void;
  private _unsubState?: () => void;
  private _globalFilters: AppState['globalFilters'] = { projects: [], machines: [] };
  private _onDocClick = (e: MouseEvent) => {
    if (!this._pickerOpen) return;
    const path = e.composedPath();
    const pickerWrap = this.shadowRoot?.querySelector('.picker-wrap');
    if (pickerWrap && !path.includes(pickerWrap)) {
      this._pickerOpen = false;
    }
  };

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

    .toolbar-btn {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      border: 1px solid #1e1e36;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
      border-radius: ${unsafeCSS(radii.sm)};
      transition:
        background 0.15s,
        color 0.15s;
    }

    .toolbar-btn:hover {
      background: rgba(99, 102, 241, 0.12);
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .toolbar-btn.active {
      background: ${unsafeCSS(colors.accent)};
      color: #fff;
      border-color: ${unsafeCSS(colors.accent)};
    }

    .layout-btns {
      display: flex;
      gap: 2px;
      margin-left: auto;
    }

    .layout-btns .toolbar-btn:first-child {
      border-radius: ${unsafeCSS(radii.sm)} 0 0 ${unsafeCSS(radii.sm)};
    }
    .layout-btns .toolbar-btn:last-child {
      border-radius: 0 ${unsafeCSS(radii.sm)} ${unsafeCSS(radii.sm)} 0;
    }
    .layout-btns .toolbar-btn:not(:first-child):not(:last-child) {
      border-radius: 0;
    }

    .picker-wrap {
      position: relative;
    }

    .picker-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 4px;
      z-index: 100;
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      min-width: 280px;
      max-height: 360px;
      overflow-y: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }

    .picker-group-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid #1e1e36;
      background: ${unsafeCSS(colors.bgSurface)};
    }

    .picker-item {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textSecondary)};
      transition: background 0.1s;
    }

    .picker-item:hover {
      background: rgba(99, 102, 241, 0.08);
    }

    .picker-item.dimmed {
      opacity: 0.35;
      cursor: default;
    }

    .picker-item .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .picker-item .resource-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .picker-item .resource-status {
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
    }

    .grid {
      flex: 1;
      display: grid;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      min-height: 0;
    }

    .pane {
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #1e1e36;
      border-radius: ${unsafeCSS(radii.md)};
      overflow: hidden;
      min-height: 0;
    }

    .pane-header {
      display: flex;
      align-items: flex-start;
      gap: ${unsafeCSS(spacing.sm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgCard)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .pane-header .pane-title-wrap {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .pane-header .pane-title {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pane-header .pane-summary {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pane-header .close-btn {
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
      cursor: pointer;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .pane-header .close-btn:hover {
      background: rgba(255, 68, 68, 0.15);
      color: ${unsafeCSS(colors.statusFail)};
    }

    .pane-body {
      flex: 1;
      min-height: 0;
    }

    .pane-body stream-feed {
      height: 100%;
    }

    .pane-footer {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.xs)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgCard)};
      border-top: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .pane-footer .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .pane-footer .status-text {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
    }

    .pane-footer .spacer {
      flex: 1;
    }

    .control-btn {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      padding: 2px 8px;
      border: 1px solid #2a2a44;
      border-radius: 3px;
      background: transparent;
      color: ${unsafeCSS(colors.textSecondary)};
      cursor: pointer;
      transition: all 0.1s;
    }

    .control-btn:hover {
      background: rgba(99, 102, 241, 0.12);
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .control-btn.danger:hover {
      background: rgba(255, 68, 68, 0.12);
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)}44;
    }

    .empty-grid {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: ${unsafeCSS(colors.textMuted)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      gap: ${unsafeCSS(spacing.md)};
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.3;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._loadSaved();
    const initial = getState();
    this._globalFilters = initial.globalFilters;
    this._hydrating = isHydrating(initial, 'fleet');
    this._fetchAllResources();

    document.addEventListener('click', this._onDocClick);

    this._unsubFleet = gateway.subscribe(Events.FLEET_UPDATED, () => {
      this._fetchAllResources();
    });

    this._unsubResource = gateway.subscribe<ResourceStatusUpdatedPayload>(
      Events.RESOURCE_STATUS_UPDATED,
      (p) => {
        for (const r of p.resources) {
          this._resourceStatuses.set(`${p.slotId}:${r.id}`, r.status);
        }
        this._availableResources = this._availableResources.map((ar) => {
          if (ar.slotId !== p.slotId) return ar;
          const updated = p.resources.find((r) => r.id === ar.resourceId);
          return updated ? { ...ar, status: updated.status, stream: updated.stream } : ar;
        });
      },
    );

    this._unsubState = subscribe((s: AppState) => {
      const prev = this._globalFilters;
      this._globalFilters = s.globalFilters;
      this._hydrating = isHydrating(s, 'fleet');
      if (
        prev.projects !== s.globalFilters.projects ||
        prev.machines !== s.globalFilters.machines
      ) {
        this._fetchAllResources();
        return;
      }
      this._syncResourceSummaries();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this._onDocClick);
    this._unsubFleet?.();
    this._unsubResource?.();
    this._unsubState?.();
  }

  private _loadSaved() {
    try {
      const saved = localStorage.getItem(PANES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) this._panes = parsed;
      }
      const layout = localStorage.getItem(LAYOUT_KEY);
      const valid: LayoutMode[] = ['auto', '1x1', '2x1', '2x2', '3x2', '4x2'];
      if (valid.includes(layout as LayoutMode)) {
        this._layout = layout as LayoutMode;
      }
    } catch {
      /* ignore */
    }
  }

  private _save() {
    localStorage.setItem(PANES_KEY, JSON.stringify(this._panes));
    localStorage.setItem(LAYOUT_KEY, this._layout);
  }

  private _applyFilters(slots: SlotStatus[]): SlotStatus[] {
    const { projects, machines } = this._globalFilters;
    return slots.filter((s) => {
      if (projects.length > 0 && !projects.includes(s.project)) return false;
      if (machines.length > 0 && !machines.includes(s.machine)) return false;
      return true;
    });
  }

  private async _fetchAllResources() {
    try {
      const result = await gateway.request<FleetStatusResult>(Methods.FLEET_STATUS, {});
      const filtered = this._applyFilters(result.fleet.slots);

      const resources: AvailableResource[] = [];
      const statusMap = new Map<string, ResourceStatus>();

      // Fetch resources for all slots in parallel
      const entries = await Promise.allSettled(
        filtered.map(async (slot) => {
          try {
            const res = await gateway.request<ResourceListResult>(Methods.RESOURCE_LIST, {
              slotId: slot.slot,
            });
            return { slot, resources: res.resources };
          } catch {
            return { slot, resources: [] as SlotResource[] };
          }
        }),
      );

      for (const entry of entries) {
        if (entry.status !== 'fulfilled') continue;
        const { slot, resources: slotResources } = entry.value;
        for (const r of slotResources) {
          if (!r.definition.streamable || !isDeviceGridResourceApplicable(slot, r)) continue;
          const status = resolveDeviceGridResourceStatus(slot, r);
          resources.push({
            slotId: slot.slot,
            resourceId: r.id,
            resourceLabel: r.definition.label,
            workSummary: this._summaryForSlot(slot),
            platform: r.definition.platform ?? '',
            status,
            stream: r.stream,
            machine: slot.machine,
            hasBoot: !!r.definition.hooks?.boot,
            hasShutdown: !!r.definition.hooks?.shutdown,
            hasRelaunch: !!r.definition.hooks?.relaunch,
          });
          statusMap.set(`${slot.slot}:${r.id}`, status);
        }
      }

      this._availableResources = resources;
      this._resourceStatuses = statusMap;
    } catch {
      /* ignore — not connected */
    }
  }

  private _summaryForSlot(slot: SlotStatus): string {
    const run = getRunForSlot(slot.slot);
    return run?.summary || slot.taskId || slot.branch || '';
  }

  private _syncResourceSummaries() {
    const fleet = getState().fleet;
    if (!fleet || this._availableResources.length === 0) return;
    this._availableResources = this._availableResources.map((resource) => {
      const slot = fleet.slots.find((candidate) => candidate.slot === resource.slotId);
      return slot ? { ...resource, workSummary: this._summaryForSlot(slot) } : resource;
    });
  }

  private _addPane(slotId: string, resourceId: string) {
    if (this._panes.some((p) => p.slotId === slotId && p.resourceId === resourceId)) return;
    this._panes = [...this._panes, { slotId, resourceId }];
    this._pickerOpen = false;
    this._save();
  }

  private _removePane(index: number) {
    const updated = [...this._panes];
    updated.splice(index, 1);
    this._panes = updated;
    this._save();
  }

  private async _showAllRunning() {
    await this._fetchAllResources();
    const running = this._availableResources
      .filter((r) => isDeviceGridResourceLive(r.status))
      .map((r) => ({ slotId: r.slotId, resourceId: r.resourceId }));
    this._panes = running.slice(0, 8);
    this._layout = 'auto';
    this._save();
  }

  private async _handleControl(slotId: string, resourceId: string, action: ResourceControlAction) {
    try {
      await gateway.request(Methods.RESOURCE_CONTROL, { slotId, resourceId, action });
    } catch (err) {
      console.error(
        `[device-grid] control ${action} failed for ${slotId}:${resourceId}:`,
        (err as Error).message,
      );
    }
  }

  private _resolvedLayout(): Exclude<LayoutMode, 'auto'> {
    if (this._layout !== 'auto') return this._layout;
    const n = this._panes.length || 1;
    if (n <= 1) return '1x1';
    if (n <= 2) return '2x1';
    if (n <= 4) return '2x2';
    if (n <= 6) return '3x2';
    return '4x2';
  }

  private _gridStyle(): string {
    const layout = this._resolvedLayout();
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

  private _statusColor(status: ResourceStatus): string {
    switch (status) {
      case 'running':
        return colors.statusOk;
      case 'stale':
        return colors.statusWarn;
      case 'stopped':
        return colors.textMuted;
      case 'error':
        return colors.statusFail;
      default:
        return colors.textMuted;
    }
  }

  private _streamLabel(resource?: Pick<AvailableResource, 'stream'>): string {
    if (!resource?.stream || resource.stream.state === 'unknown') return '';
    if (resource.stream.state === 'starting') return 'starting';
    if (resource.stream.state === 'ready') return 'live';
    return `stream error${resource.stream.detail ? `: ${resource.stream.detail}` : ''}`;
  }

  private _getResourceInfo(pane: DevicePane): AvailableResource | undefined {
    return this._availableResources.find(
      (r) => r.slotId === pane.slotId && r.resourceId === pane.resourceId,
    );
  }

  private _getPaneStatus(pane: DevicePane): ResourceStatus {
    return this._resourceStatuses.get(`${pane.slotId}:${pane.resourceId}`) ?? 'unknown';
  }

  private _renderToolbar() {
    return html`
      <div class="toolbar">
        <span class="toolbar-label">Devices</span>
        <div class="picker-wrap">
          <button
            class="toolbar-btn"
            @click=${() => {
              this._pickerOpen = !this._pickerOpen;
            }}
          >
            + Add
          </button>
          ${this._pickerOpen ? this._renderPicker() : ''}
        </div>
        <button class="toolbar-btn" @click=${() => this._showAllRunning()}>All Running</button>
        <div class="layout-btns">
          ${(['auto', '1x1', '2x1', '2x2', '3x2', '4x2'] as LayoutMode[]).map(
            (l) => html`
              <button
                class="toolbar-btn ${this._layout === l ? 'active' : ''}"
                @click=${() => {
                  this._layout = l;
                  this._save();
                }}
              >
                ${l}
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private _renderPicker() {
    // Group by machine
    const grouped = new Map<string, AvailableResource[]>();
    for (const r of this._availableResources) {
      const list = grouped.get(r.machine) ?? [];
      list.push(r);
      grouped.set(r.machine, list);
    }

    const isAdded = (r: AvailableResource) =>
      this._panes.some((p) => p.slotId === r.slotId && p.resourceId === r.resourceId);

    return html`
      <div class="picker-dropdown">
        ${[...grouped.entries()].map(
          ([machine, resources]) => html`
            <div class="picker-group-label">${machine}</div>
            ${resources.map(
              (r) => html`
                <div
                  class="picker-item ${isAdded(r) ? 'dimmed' : ''}"
                  @click=${() => {
                    if (!isAdded(r)) this._addPane(r.slotId, r.resourceId);
                  }}
                >
                  <span
                    class="status-dot"
                    style="background: ${this._statusColor(r.status)}"
                  ></span>
                  <span class="resource-label">${r.slotId} / ${r.resourceLabel}</span>
                  <span class="resource-status"
                    >${r.status}${this._streamLabel(r) ? ` · ${this._streamLabel(r)}` : ''}</span
                  >
                </div>
              `,
            )}
          `,
        )}
        ${this._availableResources.length === 0
          ? html`
              <div class="picker-item" style="color: ${colors.textMuted}; cursor: default">
                No streamable resources found
              </div>
            `
          : ''}
      </div>
    `;
  }

  private _renderPane(pane: DevicePane, index: number) {
    const info = this._getResourceInfo(pane);
    const status = this._getPaneStatus(pane);
    const resourceLabel = info?.resourceLabel ?? pane.resourceId;
    const workSummary = info?.workSummary ?? '';
    const platform = (info?.platform as 'ios' | 'android' | 'chrome-extension' | '') ?? '';
    const streamLabel = this._streamLabel(info);

    return html`
      <div class="pane">
        <div class="pane-header">
          <div class="pane-title-wrap">
            <span class="pane-title">${pane.slotId} / ${resourceLabel}</span>
            ${workSummary
              ? html`<span class="pane-summary" title=${workSummary}>${workSummary}</span>`
              : ''}
          </div>
          <button class="close-btn" title="Remove pane" @click=${() => this._removePane(index)}>
            &#x2715;
          </button>
        </div>
        <div class="pane-body">
          <stream-feed
            .slotId=${pane.slotId}
            .platform=${platform}
            .resourceId=${pane.resourceId}
          ></stream-feed>
        </div>
        <div class="pane-footer">
          <span class="status-dot" style="background: ${this._statusColor(status)}"></span>
          <span class="status-text" title=${streamLabel || status}
            >${status}${streamLabel ? ` · ${streamLabel}` : ''}</span
          >
          <span class="spacer"></span>
          ${status === 'running'
            ? html`
                ${info?.hasRelaunch
                  ? html`<button
                      class="control-btn"
                      @click=${() => this._handleControl(pane.slotId, pane.resourceId, 'relaunch')}
                    >
                      RL
                    </button>`
                  : ''}
                ${info?.hasShutdown
                  ? html`<button
                      class="control-btn danger"
                      @click=${() => this._handleControl(pane.slotId, pane.resourceId, 'shutdown')}
                    >
                      Off
                    </button>`
                  : ''}
              `
            : ''}
          ${status === 'stopped' && info?.hasBoot
            ? html`
                <button
                  class="control-btn"
                  @click=${() => this._handleControl(pane.slotId, pane.resourceId, 'boot')}
                >
                  Boot
                </button>
              `
            : ''}
        </div>
      </div>
    `;
  }

  render() {
    const max = this._maxSlots();
    const panesToShow = this._panes.slice(0, max);
    // Only show the placeholder when there is nothing to render at all.
    // Preselected panes (from localStorage) can keep streaming their feeds
    // through `stream-feed` even before the fleet resource list arrives.
    const hydrating =
      this._hydrating && this._availableResources.length === 0 && this._panes.length === 0;

    return html`
      ${this._renderToolbar()}
      ${hydrating
        ? html`<farm-hydrating message="Loading device resources…"></farm-hydrating>`
        : panesToShow.length === 0
          ? html`
              <div class="empty-grid">
                <div class="empty-icon">&#9632;</div>
                <span>No device streams selected</span>
                <span style="font-size: 11px; color: ${colors.textMuted}"
                  >Click "+ Add" to pick devices, or "All Running" to auto-populate</span
                >
              </div>
            `
          : html`
              <div class="grid" style="${this._gridStyle()}">
                ${repeat(
                  panesToShow,
                  (p) => `${p.slotId}:${p.resourceId}`,
                  (p, i) => this._renderPane(p, i),
                )}
              </div>
            `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-grid': DeviceGrid;
  }
}
