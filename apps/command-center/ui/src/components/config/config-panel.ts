import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  ConfigPoolRawResult,
  ConfigPoolsResult,
  ConfigPoolUpdateResult,
  ConfigProjectAutoRecoveryUpdateResult,
  ConfigProjectResult,
  ConfigProjectsResult,
  PoolConfig,
  ProjectConfig,
  ProjectLearningsDocument,
  SlotStatus,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import './llm-config.js';
import './template-viewer.js';
import './slot-toggle.js';
import '../flow-graph/flow-graph.js';
import '../shared/source-status-panel.js';

import { gateway } from '../../gateway-client.js';
import { providerAccountsStore } from '../../provider-accounts-store.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { getState, type GlobalFilters, subscribe } from '../../state.js';
import { getAlphaFeaturesEnabled, setAlphaFeaturesEnabled } from '../../utils/alpha-features.js';
import { renderMarkdown } from '../../utils/markdown.js';
import {
  type AttentionAlertPreferences,
  getAttentionAlertPreferences,
  setAttentionAlertPreferences,
} from '../../utils/notifications.js';
import { gatewayMediaHtml } from '../shared/gateway-media-src.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';
import { renderRunnerAccountInventory } from '../shared/runner-account-inventory.js';

import {
  type AutoRecoveryDraft,
  autoRecoveryDraftFromProject,
  autoRecoveryModeDetail,
  autoRecoveryModeLabel,
  type AutoRecoveryPreset,
  autoRecoveryPresetPatch,
  autoRecoveryUpdateFromDraft,
} from './config-panel-auto-recovery-model.js';
import { configPanelLoadingStyle, renderConfigPanelStyles } from './config-panel-styles.js';
import {
  type ConfigPanelFlowsState,
  type ConfigPanelSelection,
  formatConfigPanelRoute,
  parseConfigPanelRoute,
} from './config-panel-url-state.js';

type PoolViewMode = 'structured' | 'editor';
type ProjectTab = 'config' | 'templates' | 'learnings';

function pathForProjectLearnings(project: string): string {
  return `projects/${project}/learnings/LEARNINGS.md`;
}

@customElement('config-panel')
export class ConfigPanel extends LitElement {
  @property() initialPath = '';
  @state() private _pools: PoolConfig[] = [];
  @state() private _flowsState: ConfigPanelFlowsState = {
    flowType: 'fix-bug',
    mode: 'interactive',
    laneMode: 'phase',
    project: '',
  };
  @state() private _projects: ProjectConfig[] = [];
  @state() private _selection: ConfigPanelSelection | null = null;
  @state() private _loading = true;
  @state() private _poolViewMode: PoolViewMode = 'structured';
  @state() private _editorContent = '';
  @state() private _editorDirty = false;
  @state() private _editorError = '';
  private _editorMachine?: string;
  private _editorWorkspace?: string;
  private _editorRequest = 0;
  @state() private _saving = false;
  @state() private _projectTab: ProjectTab = 'config';
  @state() private _filters: GlobalFilters = { projects: [], machines: [] };
  @state() private _fleetSlots: SlotStatus[] = [];
  @state() private _autoRecoveryDraft: AutoRecoveryDraft | null = null;
  @state() private _autoRecoveryDirty = false;
  @state() private _autoRecoverySaving = false;
  @state() private _autoRecoveryError = '';
  @state() private _projectLearnings = new Map<string, ProjectLearningsDocument>();
  @state() private _projectLearningsLoading = false;
  @state() private _projectLearningsError = '';
  @state() private _alphaFeaturesEnabled = getAlphaFeaturesEnabled();
  @state() private _attentionAlerts = getAttentionAlertPreferences();

  // Light DOM so Monaco CSS works
  protected override createRenderRoot() {
    return this;
  }

  private readonly _poolsQuery = new ResourceQueryController<ConfigPoolsResult>(this, () =>
    this.applyConfiguration(),
  );
  private readonly _projectsQuery = new ResourceQueryController<ConfigProjectsResult>(this, () =>
    this.applyConfiguration(),
  );
  private readonly _poolRawQuery = new ResourceQueryController<ConfigPoolRawResult>(
    this,
    (state) => {
      const workspace = getResourceWorkspaceKey();
      if (workspace !== this._editorWorkspace) {
        this._editorWorkspace = workspace;
        this._editorContent = '';
        this._editorDirty = false;
        this._editorError = '';
      }
      if (this._selection?.kind !== 'pool' || this._selection.machine !== this._editorMachine)
        return;
      if (state.data && !this._editorDirty) this._editorContent = state.data.raw;
    },
  );
  private readonly _projectQuery = new ResourceQueryController<ConfigProjectResult>(this, () => {
    const state = this._projectQuery.state;
    if (!state.data) this._projectLearnings = new Map();
    else
      this._projectLearnings = new Map(this._projectLearnings).set(
        state.data.project.name,
        state.data.learnings,
      );
    this._projectLearningsLoading = state.status === 'loading';
    this._projectLearningsError = state.error?.message ?? '';
  });
  @state() private _configurationError = '';

  private applyConfiguration(): void {
    this._pools = this._poolsQuery.belongsToWorkspace
      ? (this._poolsQuery.state.data?.pools ?? [])
      : [];
    this._projects = this._projectsQuery.belongsToWorkspace
      ? (this._projectsQuery.state.data?.projects ?? [])
      : [];
    this._loading =
      !this._pools.length &&
      !this._projects.length &&
      [this._poolsQuery.state, this._projectsQuery.state].some(
        (value) => value.status === 'loading',
      );
    this._configurationError = [
      this._poolsQuery.state.error?.message,
      this._projectsQuery.state.error?.message,
    ]
      .filter(Boolean)
      .join('; ');
    if (!this._selection) {
      if (this.initialPath) this._selection = this._parseInitialPath(this.initialPath);
      else if (this.filteredPools[0])
        this._selection = { kind: 'pool', machine: this.filteredPools[0].machine };
      else if (this.filteredProjects[0])
        this._selection = { kind: 'project', name: this.filteredProjects[0].name };
    }
  }
  private get configurationCurrent(): boolean {
    return this._poolsQuery.ready && this._projectsQuery.ready;
  }
  private get configurationAge(): string {
    const state = this._projectsQuery.state;
    if (state.status !== 'stale' || !state.observedAt) return '';
    return `Saved projects, ${Math.max(0, Math.floor((Date.now() - state.observedAt) / 1000))}s old. Actions wait for a current read.`;
  }
  private _connUnsub?: () => void;
  private _stateUnsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._seatsUnsub = providerAccountsStore.subscribe(() => this.requestUpdate());
    const s = getState();
    this._filters = s.globalFilters;
    this._fleetSlots = s.fleet?.slots ?? [];
    this.loadData();
    // Retry when gateway connects (initial page load may fire before WS is open)
    this._connUnsub = gateway.onConnectionChange((st) => {
      if (st === 'connected' && this._pools.length === 0) {
        this.loadData();
      }
    });
    // Track global filter + fleet changes (fleet needed for slot lifecycle in toggle)
    this._stateUnsub = subscribe((s) => {
      this._filters = s.globalFilters;
      this._fleetSlots = s.fleet?.slots ?? [];
    });
    // Reload pool data after a slot toggle so enabled/mode stay in sync
    this.addEventListener('slot-toggled', this._onSlotToggled);
  }

  disconnectedCallback() {
    this._seatsUnsub?.();
    this._seatsUnsub = null;
    super.disconnectedCallback();
    this._connUnsub?.();
    this._stateUnsub?.();
    this.removeEventListener('slot-toggled', this._onSlotToggled);
  }

  private _onSlotToggled = () => {
    this.loadData();
  };

  updated(changed: Map<string, unknown>) {
    if (changed.has('initialPath') && this.initialPath) {
      const sel = this._parseInitialPath(this.initialPath);
      if (sel) {
        if (
          sel.kind !== 'pool' ||
          this._selection?.kind !== 'pool' ||
          sel.machine !== this._selection.machine
        )
          this.leavePoolEditor();
        this._selection = sel;
      }
    }
  }

  private _parseInitialPath(path: string): ConfigPanelSelection | null {
    const route = parseConfigPanelRoute(path);
    if (!route) return null;
    if (route.flowsState) this._flowsState = route.flowsState;
    return route.selection;
  }

  private _updateHash() {
    if (!this._selection) return;
    const subpath = formatConfigPanelRoute(this._selection, this._flowsState);
    history.replaceState(null, '', `#config/${subpath}`);
  }

  private _onFlowsStateChange(e: CustomEvent<ConfigPanelFlowsState>) {
    this._flowsState = e.detail;
    this._updateHash();
  }

  private get filteredPools(): PoolConfig[] {
    if (this._filters.machines.length === 0 && this._filters.projects.length === 0)
      return this._pools;
    return this._pools.filter((p) => {
      if (this._filters.machines.length > 0 && !this._filters.machines.includes(p.machine))
        return false;
      if (this._filters.projects.length > 0 && !this._filters.projects.includes(p.project))
        return false;
      return true;
    });
  }

  private slotLifecycle(slotId: string): string {
    return this._fleetSlots.find((s) => s.slot === slotId)?.lifecycle ?? '';
  }

  private get filteredProjects(): ProjectConfig[] {
    if (this._filters.projects.length === 0) return this._projects;
    return this._projects.filter((p) => this._filters.projects.includes(p.name));
  }

  private async loadData() {
    this._poolsQuery.setQuery(resourceQuery<ConfigPoolsResult>(Methods.CONFIG_POOLS));
    this._projectsQuery.setQuery(resourceQuery<ConfigProjectsResult>(Methods.CONFIG_PROJECTS));
    await Promise.all([this._poolsQuery.retry(), this._projectsQuery.retry()]);
  }

  private _seatsUnsub: (() => void) | null = null;

  private async _fetchSeats(machine: string, forceRefresh = false) {
    await providerAccountsStore.fetch([machine], forceRefresh);
  }

  private selectPool(machine: string) {
    this.leavePoolEditor();
    this._selection = { kind: 'pool', machine };
    void this._fetchSeats(machine);
    this._poolViewMode = 'structured';
    this._editorDirty = false;
    this._editorError = '';
    this._updateHash();
  }

  private selectProject(name: string) {
    this.leavePoolEditor();
    this._selection = { kind: 'project', name };
    this._projectTab = 'config';
    this._autoRecoveryDraft = null;
    this._autoRecoveryDirty = false;
    this._autoRecoveryError = '';
    this._projectLearningsError = '';
    this._updateHash();
  }

  private selectProjectTab(project: ProjectConfig, tab: ProjectTab) {
    this._projectTab = tab;
    if (tab === 'learnings') void this.loadProjectLearnings(project.name);
  }

  private async loadProjectLearnings(projectName: string, force = false) {
    this._projectQuery.setQuery(
      resourceQuery<ConfigProjectResult>(Methods.CONFIG_PROJECT, { project: projectName }),
    );
    if (force) await this._projectQuery.retry();
  }

  private getSelectedPool(): PoolConfig | undefined {
    if (this._selection?.kind !== 'pool') return undefined;
    return this._pools.find(
      (p) => p.machine === (this._selection as { kind: 'pool'; machine: string }).machine,
    );
  }

  private getSelectedProject(): ProjectConfig | undefined {
    if (this._selection?.kind !== 'project') return undefined;
    return this._projects.find(
      (p) => p.name === (this._selection as { kind: 'project'; name: string }).name,
    );
  }

  private async enterEditor() {
    const pool = this.getSelectedPool();
    if (!pool) return;
    const request = ++this._editorRequest;
    const workspace = getResourceWorkspaceKey();
    this._editorMachine = pool.machine;
    this._editorDirty = false;
    this._editorError = '';
    this._poolRawQuery.setQuery(
      resourceQuery<ConfigPoolRawResult>(Methods.CONFIG_POOL_RAW, { machine: pool.machine }),
    );
    const result = await this._poolRawQuery.retry();
    if (
      request !== this._editorRequest ||
      workspace !== getResourceWorkspaceKey() ||
      this._selection?.kind !== 'pool' ||
      this._selection.machine !== pool.machine
    )
      return;
    if (result.data && this._poolRawQuery.ready) {
      this._poolViewMode = 'editor';
    } else this._editorError = result.error?.message ?? 'Wait for current pool configuration.';
  }

  private leavePoolEditor() {
    this._editorRequest++;
    this._editorMachine = undefined;
    this._poolRawQuery.setQuery(undefined);
    this._poolViewMode = 'structured';
  }

  private onEditorInput(e: Event) {
    const textarea = e.target as HTMLTextAreaElement;
    this._editorContent = textarea.value;
    this._editorDirty = true;
    // Validate JSON
    try {
      JSON.parse(this._editorContent);
      this._editorError = '';
    } catch (err) {
      this._editorError = (err as Error).message;
    }
  }

  private async savePoolJson() {
    if (!this._selection || this._selection.kind !== 'pool' || this._editorError) return;
    this._saving = true;
    const machine = this._selection.machine;
    const workspace = getResourceWorkspaceKey();
    const connection = gateway.connectionEpoch;
    const request = this._editorRequest;
    const current = () =>
      this.isConnected &&
      request === this._editorRequest &&
      workspace === getResourceWorkspaceKey() &&
      connection === gateway.connectionEpoch;
    try {
      this._poolsQuery.requireReady();
      this._poolRawQuery.requireReady();
      const result = (await gateway.request(Methods.CONFIG_POOL_UPDATE, {
        machine,
        content: this._editorContent,
      })) as ConfigPoolUpdateResult;
      if (result.ok && current()) {
        this._editorDirty = false;
        this.leavePoolEditor();
        await this.loadData();
      }
    } catch (err) {
      if (current()) this._editorError = (err as Error).message;
    } finally {
      this._saving = false;
    }
  }

  private draftFromProject(project: ProjectConfig): AutoRecoveryDraft {
    return autoRecoveryDraftFromProject(project);
  }

  private autoRecoveryDraft(project: ProjectConfig): AutoRecoveryDraft {
    if (
      !this._autoRecoveryDraft ||
      this._autoRecoveryDraft.project !== project.name ||
      !this._autoRecoveryDirty
    ) {
      this._autoRecoveryDraft = this.draftFromProject(project);
      this._autoRecoveryDirty = false;
      this._autoRecoveryError = '';
    }
    return this._autoRecoveryDraft;
  }

  private updateAutoRecoveryDraft(project: ProjectConfig, patch: Partial<AutoRecoveryDraft>) {
    const current = this.autoRecoveryDraft(project);
    this._autoRecoveryDraft = { ...current, ...patch };
    this._autoRecoveryDirty = true;
    this._autoRecoveryError = '';
  }

  private applyAutoRecoveryPreset(project: ProjectConfig, preset: AutoRecoveryPreset) {
    this.updateAutoRecoveryDraft(project, autoRecoveryPresetPatch(preset));
  }

  private autoRecoveryModeLabel(ar: AutoRecoveryDraft): string {
    return autoRecoveryModeLabel(ar);
  }

  private autoRecoveryModeDetail(ar: AutoRecoveryDraft): string {
    return autoRecoveryModeDetail(ar);
  }

  private async saveAutoRecovery(project: ProjectConfig) {
    const draft = this.autoRecoveryDraft(project);
    this._autoRecoverySaving = true;
    this._autoRecoveryError = '';
    try {
      this._projectsQuery.requireReady();
      const result = (await gateway.request(Methods.CONFIG_PROJECT_AUTO_RECOVERY_UPDATE, {
        project: project.name,
        autoRecovery: autoRecoveryUpdateFromDraft(draft),
      })) as ConfigProjectAutoRecoveryUpdateResult;
      this._projects = this._projects.map((p) => (p.name === project.name ? result.project : p));
      this._autoRecoveryDraft = this.draftFromProject(result.project);
      this._autoRecoveryDirty = false;
    } catch (err) {
      this._autoRecoveryError = err instanceof Error ? err.message : String(err);
    } finally {
      this._autoRecoverySaving = false;
    }
  }

  private renderSidebar() {
    const pools = this.filteredPools;
    const projects = this.filteredProjects;
    return html`
      <div class="cp-sidebar">
        <div class="cp-sidebar-section">
          <div class="cp-sidebar-title">Pools</div>
          ${pools.map(
            (p) => html`
              <button
                class="cp-sidebar-item ${this._selection?.kind === 'pool' &&
                (this._selection as { kind: 'pool'; machine: string }).machine === p.machine
                  ? 'active'
                  : ''}"
                @click=${() => this.selectPool(p.machine)}
              >
                <span class="cp-item-icon">#</span>
                <span class="cp-item-label">${p.machine}</span>
                <span class="cp-item-badge">${p.slots.length}</span>
              </button>
            `,
          )}
        </div>
        <div class="cp-sidebar-section">
          <div class="cp-sidebar-title">Projects</div>
          ${projects.map(
            (p) => html`
              <button
                class="cp-sidebar-item ${this._selection?.kind === 'project' &&
                (this._selection as { kind: 'project'; name: string }).name === p.name
                  ? 'active'
                  : ''}"
                @click=${() => this.selectProject(p.name)}
              >
                <span class="cp-item-icon">@</span>
                <span class="cp-item-label">${p.name}</span>
              </button>
            `,
          )}
        </div>
        <div class="cp-sidebar-section">
          <button
            class="cp-sidebar-item ${this._selection?.kind === 'flows' ? 'active' : ''}"
            @click=${() => {
              this._selection = { kind: 'flows' };
              this._updateHash();
            }}
          >
            <span class="cp-item-icon">/</span>
            <span class="cp-item-label">Flows</span>
          </button>
        </div>
        <div class="cp-sidebar-section">
          <button
            class="cp-sidebar-item ${this._selection?.kind === 'llm' ? 'active' : ''}"
            @click=${() => {
              this._selection = { kind: 'llm' };
              this._updateHash();
            }}
          >
            <span class="cp-item-icon">~</span>
            <span class="cp-item-label">LLM</span>
          </button>
        </div>
        <div class="cp-sidebar-section">
          <button
            class="cp-sidebar-item ${this._selection?.kind === 'settings' ? 'active' : ''}"
            @click=${() => {
              this._selection = { kind: 'settings' };
              this._updateHash();
            }}
          >
            <span class="cp-item-icon">s</span>
            <span class="cp-item-label">Settings</span>
          </button>
        </div>
      </div>
    `;
  }

  private renderPoolStructured(pool: PoolConfig) {
    return html`
      <div class="cp-pool-header">
        <h3>${pool.machine}</h3>
        <button class="cp-action-btn" @click=${() => this.enterEditor()}>Edit JSON</button>
      </div>
      <div class="cp-pool-info">
        <div class="cp-info-row">
          <span class="cp-info-label">Host</span><span class="cp-info-value">${pool.host}</span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label">OS</span><span class="cp-info-value">${pool.os}</span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label">Platform</span
          ><span class="cp-info-value">${pool.platform}</span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label">SSH User</span
          ><span class="cp-info-value">${pool.sshUser}</span>
        </div>
      </div>
      ${this.renderRunnerSeats(pool.machine)}
      <table class="cp-slot-table">
        <thead>
          <tr>
            <th>Slot ID</th>
            <th>Project</th>
            <th>Mode</th>
            <th>Enabled</th>
            <th>Resources</th>
          </tr>
        </thead>
        <tbody>
          ${pool.slots.map(
            (slot) => html`
              <tr>
                <td>
                  <a
                    class="cp-slot-link"
                    @click=${() => {
                      location.hash = `slot/${slot.id}`;
                    }}
                    >${slot.id}</a
                  >
                </td>
                <td>${slot.project}</td>
                <td>${slot.mode}</td>
                <td>
                  <slot-toggle
                    .configurationReady=${this.configurationCurrent}
                    slotId=${slot.id}
                    .enabled=${slot.enabled !== false}
                    mode=${slot.mode}
                    lifecycle=${this.slotLifecycle(slot.id)}
                  >
                  </slot-toggle>
                </td>
                <td class="cp-resources-cell">
                  ${slot.resources ? Object.keys(slot.resources).join(', ') : '-'}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  /** Same seat data as the fleet map's Setup modal, in the machine's config page. */
  private renderRunnerSeats(machine: string) {
    const snap = providerAccountsStore.get(machine);
    const runners = snap?.runners ?? [];
    const fetching = providerAccountsStore.isFetching(machine);
    return html`
      <div class="cp-pool-info" data-testid="config-runner-seats">
        <div class="cp-info-row">
          <span class="cp-info-label">Runner accounts</span>
          <span class="cp-info-value">
            ${fetching ? 'querying node…' : runners.length ? '' : 'no snapshot'}
            ${snap?.checkedAt && !fetching
              ? html`<span style="opacity:.7"
                  >as of ${new Date(snap.checkedAt).toLocaleTimeString()}</span
                >`
              : nothing}
            <button
              class="cp-action-btn"
              data-testid="config-seats-refresh"
              ?disabled=${fetching}
              @click=${() => void this._fetchSeats(machine, true)}
            >
              Refresh
            </button>
          </span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label"></span
          ><span class="cp-info-value"
            >Default host configuration; running sessions may use other accounts.</span
          >
        </div>
        ${providerAccountsStore.error() && !runners.length
          ? html`<div class="cp-info-row">
              <span class="cp-info-label"></span>
              <span class="cp-info-value">fetch failed: ${providerAccountsStore.error()}</span>
            </div>`
          : nothing}
        ${runners.map(
          (r) => html`
            <div class="cp-info-row" data-runner=${r.runner}>
              <span class="cp-info-label">${r.runner}</span>
              <span class="cp-info-value">
                ${renderRunnerAccountInventory(r)}
                ${r.usage?.remainingPercent != null
                  ? ` · ${Math.round(r.usage.remainingPercent)}% left`
                  : ''}
                ${r.cooling?.length ? ` · cooling: ${r.cooling.length}` : ''}
              </span>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderPoolEditor() {
    return html`
      <div class="cp-pool-header">
        <h3>Edit Pool JSON</h3>
        <div class="cp-editor-actions">
          ${this._editorDirty ? html`<span class="cp-unsaved">Unsaved changes</span>` : nothing}
          <button
            class="cp-action-btn secondary"
            @click=${() => {
              this.leavePoolEditor();
            }}
          >
            Cancel
          </button>
          <button
            class="cp-action-btn"
            ?disabled=${!this.configurationCurrent ||
            !this._poolRawQuery.ready ||
            !!this._editorError ||
            this._saving ||
            !this._editorDirty}
            @click=${() => this.savePoolJson()}
          >
            ${this._saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      ${this._editorError ? html`<div class="cp-editor-error">${this._editorError}</div>` : nothing}
      ${this._poolRawQuery.state.error
        ? html`<div class="cp-editor-error" role="alert">
            ${this._poolRawQuery.state.error.message}<button
              class="cp-action-btn secondary"
              ?disabled=${gateway.connectionState !== 'connected' ||
              !this._poolRawQuery.belongsToWorkspace}
              @click=${() => this._poolRawQuery.retry()}
            >
              Retry pool read
            </button>
          </div>`
        : nothing}
      <textarea
        class="cp-json-editor"
        .value=${this._editorContent}
        @input=${this.onEditorInput}
        spellcheck="false"
      ></textarea>
    `;
  }

  private renderPoolContent(pool: PoolConfig) {
    return this._poolViewMode === 'editor'
      ? this.renderPoolEditor()
      : this.renderPoolStructured(pool);
  }

  private renderProjectContent(project: ProjectConfig) {
    return html`
      <div class="cp-pool-header">
        <h3>${project.name}</h3>
        <div class="tab-group">
          <button
            class="tab-btn ${this._projectTab === 'config' ? 'active' : ''}"
            @click=${() => this.selectProjectTab(project, 'config')}
          >
            Config
          </button>
          <button
            class="tab-btn ${this._projectTab === 'templates' ? 'active' : ''}"
            @click=${() => this.selectProjectTab(project, 'templates')}
          >
            Templates
          </button>
          <button
            class="tab-btn ${this._projectTab === 'learnings' ? 'active' : ''}"
            @click=${() => this.selectProjectTab(project, 'learnings')}
          >
            Learnings
          </button>
        </div>
      </div>
      ${this.renderProjectTabContent(project)}
    `;
  }

  private renderProjectTabContent(project: ProjectConfig) {
    if (this._projectTab === 'config') return this.renderProjectConfig(project);
    if (this._projectTab === 'templates') {
      return html`<div class="cp-template-container">
        <template-viewer project=${project.name}></template-viewer>
      </div>`;
    }
    return this.renderProjectLearnings(project);
  }

  private renderProjectLearnings(project: ProjectConfig) {
    const learnings = this._projectLearnings.get(project.name);
    if (!learnings && !this._projectLearningsLoading && !this._projectLearningsError) {
      void this.loadProjectLearnings(project.name);
    }
    return html`
      <div class="cp-learnings-card">
        <div class="cp-learnings-head">
          <div>
            <div class="cp-learnings-title">Self-improvement loop</div>
            <div class="cp-learnings-subtitle">
              Accepted retros and template/process improvements from
              <code>${learnings?.relativePath ?? pathForProjectLearnings(project.name)}</code>.
            </div>
          </div>
          <button
            class="cp-action-btn secondary"
            ?disabled=${this._projectLearningsLoading}
            @click=${() => this.loadProjectLearnings(project.name, true)}
          >
            ${this._projectLearningsLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        ${this._projectLearningsError
          ? html`<div class="cp-editor-error">${this._projectLearningsError}</div>`
          : this._projectLearningsLoading && !learnings
            ? html`<div class="cp-empty">Loading learnings...</div>`
            : !learnings?.exists
              ? html`<div class="cp-empty">No project LEARNINGS.md yet.</div>`
              : html`
                  <div class="cp-learnings-meta">
                    ${learnings.sizeBytes ?? 0}
                    bytes${learnings.updatedAt
                      ? ` · updated ${new Date(learnings.updatedAt).toLocaleString()}`
                      : ''}
                  </div>
                  <div class="cp-learnings-body">
                    ${gatewayMediaHtml(renderMarkdown(learnings.content))}
                  </div>
                `}
      </div>
    `;
  }

  private renderProjectConfig(project: ProjectConfig) {
    const ar = this.autoRecoveryDraft(project);
    return html`
      <div class="cp-pool-info">
        <div class="cp-info-row">
          <span class="cp-info-label">Repo URL</span
          ><span class="cp-info-value">${project.repoUrl || '-'}</span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label">Default Branch</span
          ><span class="cp-info-value">${project.defaultBranch}</span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label">CI Repo</span
          ><span class="cp-info-value">${project.ci.repo || '-'}</span>
        </div>
        <div class="cp-info-row">
          <span class="cp-info-label">Jira</span
          ><span class="cp-info-value">${project.jira.project || '-'}</span>
        </div>
      </div>
      ${(project.apps?.length ?? 0) > 0
        ? html`
            <div class="cp-section">
              <div class="cp-section-title">Apps</div>
              <div class="cp-ci-checks">
                ${project.apps!.map((app) => html`<span class="cp-ci-check">${app}</span>`)}
              </div>
            </div>
          `
        : nothing}
      ${Object.keys(project.hooks).length > 0
        ? html`
            <div class="cp-section">
              <div class="cp-section-title">Hooks</div>
              <div class="cp-pool-info">
                ${Object.entries(project.hooks).map(
                  ([key, val]) => html`
                    <div class="cp-info-row">
                      <span class="cp-info-label">${key}</span>
                      <span class="cp-info-value cp-hook-value"
                        >${typeof val === 'string' ? val : JSON.stringify(val)}</span
                      >
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}
      ${Object.keys(project.health).length > 0
        ? html`
            <div class="cp-section">
              <div class="cp-section-title">Health Indicators</div>
              <div class="cp-pool-info">
                ${Object.entries(project.health).map(
                  ([key, val]) => html`
                    <div class="cp-info-row">
                      <span class="cp-info-label">${key}</span>
                      <span class="cp-info-value cp-hook-value">${val}</span>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}
      ${(project.ci.watchChecks?.length ?? 0) > 0
        ? html`
            <div class="cp-section">
              <div class="cp-section-title">CI Watch Checks</div>
              <div class="cp-ci-checks">
                ${project.ci.watchChecks.map((c) => html`<span class="cp-ci-check">${c}</span>`)}
              </div>
            </div>
          `
        : nothing}
      <div class="cp-section cp-auto-recovery-section">
        <div class="cp-section-title">Gateway Intelligence Policy</div>
        <div class="cp-auto-card">
          <div class="cp-auto-card-head">
            <div>
              <div class="cp-auto-title">Project auto-recovery permissions</div>
              <div class="cp-auto-subtitle">
                Gateway Intelligence is shared globally; this project policy grants the bounded
                authority to replay eligible failed steps, use LLM refinement, and audit every
                decision.
              </div>
            </div>
            <label class="cp-switch-row">
              <input
                type="checkbox"
                .checked=${ar.enabled}
                @change=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    enabled: (e.target as HTMLInputElement).checked,
                  })}
              />
              Enabled
            </label>
          </div>
          <div class="cp-auto-summary">
            <div class="cp-auto-summary-title">${this.autoRecoveryModeLabel(ar)}</div>
            <div class="cp-auto-summary-detail">${this.autoRecoveryModeDetail(ar)}</div>
          </div>
          <div class="cp-auto-summary">
            <div class="cp-auto-summary-title">
              Backlog auto-dispatch:
              ${project.backlog?.autoDispatch?.enabled ? 'enabled' : 'disabled'}
            </div>
            <div class="cp-auto-summary-detail">
              Ready backlog items still require valid dispatch fields and explicit allowed slots
              before Gateway Intelligence can enqueue them.
            </div>
          </div>
          <div class="cp-preset-row" aria-label="Auto-recovery presets">
            <button
              class="cp-preset-btn"
              @click=${() => this.applyAutoRecoveryPreset(project, 'safe-retry')}
            >
              Safe retry <span>recommended</span>
            </button>
            <button
              class="cp-preset-btn"
              @click=${() => this.applyAutoRecoveryPreset(project, 'llm-assisted')}
            >
              Intelligence assisted <span>bounded LLM</span>
            </button>
            <button
              class="cp-preset-btn muted"
              @click=${() => this.applyAutoRecoveryPreset(project, 'off')}
            >
              Off <span>project disabled</span>
            </button>
          </div>
          <div class="cp-form-grid">
            <label>
              Max attempts per step
              <input
                class="cp-input"
                type="number"
                min="0"
                .value=${String(ar.maxAttempts)}
                @input=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    maxAttempts: Number((e.target as HTMLInputElement).value),
                  })}
              />
              <span class="cp-field-hint"
                >Per-step cap. 1 means one automatic replay per failed step.</span
              >
            </label>
            <label>
              LLM daily cap (USD)
              <input
                class="cp-input"
                type="number"
                min="0"
                step="0.01"
                .value=${String(ar.llmDailyUsdCap)}
                @input=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    llmDailyUsdCap: Number((e.target as HTMLInputElement).value),
                  })}
              />
              <span class="cp-field-hint"
                >Project spend guard for Gateway Intelligence LLM refinement.</span
              >
            </label>
            <label class="cp-wide">
              Allowed steps
              <input
                class="cp-input"
                .value=${ar.allowedStepsText}
                @input=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    allowedStepsText: (e.target as HTMLInputElement).value,
                  })}
              />
              <span class="cp-field-hint"
                >Comma-separated pipeline steps where Gateway Intelligence may auto-replay. Empty
                means no auto-replay steps.</span
              >
            </label>
            <label class="cp-wide">
              Allowed policy buckets
              <input
                class="cp-input"
                .value=${ar.allowedCategoriesText}
                @input=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    allowedCategoriesText: (e.target as HTMLInputElement).value,
                  })}
              />
              <span class="cp-field-hint"
                >Seed policy buckets: infra, timeout, env-drift, flake.</span
              >
            </label>
            <label class="cp-wide">
              Disabled patterns
              <input
                class="cp-input"
                placeholder="pattern ids, comma-separated"
                .value=${ar.disabledPatternsText}
                @input=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    disabledPatternsText: (e.target as HTMLInputElement).value,
                  })}
              />
              <span class="cp-field-hint">Optional pattern IDs to suppress for this project.</span>
            </label>
            <label class="cp-switch-row">
              <input
                type="checkbox"
                .checked=${ar.llmEnabled}
                @change=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    llmEnabled: (e.target as HTMLInputElement).checked,
                  })}
              />
              Allow Gateway Intelligence LLM refinement
            </label>
            <label>
              LLM timeout (ms)
              <input
                class="cp-input"
                type="number"
                min="0"
                .value=${String(ar.llmTimeoutMs)}
                @input=${(e: Event) =>
                  this.updateAutoRecoveryDraft(project, {
                    llmTimeoutMs: Number((e.target as HTMLInputElement).value),
                  })}
              />
              <span class="cp-field-hint"
                >How long this project waits for Gateway Intelligence LLM analysis before falling
                back to deterministic handling.</span
              >
            </label>
          </div>
          <div class="cp-auto-actions">
            ${this._autoRecoveryDirty
              ? html`<span class="cp-unsaved">Unsaved auto-recovery changes</span>`
              : nothing}
            ${this._autoRecoveryError
              ? html`<span class="cp-editor-error">${this._autoRecoveryError}</span>`
              : nothing}
            <button
              class="cp-action-btn"
              ?disabled=${!this.configurationCurrent ||
              !this._autoRecoveryDirty ||
              this._autoRecoverySaving}
              @click=${() => this.saveAutoRecovery(project)}
            >
              ${this._autoRecoverySaving ? 'Saving...' : 'Save Auto-Recovery'}
            </button>
          </div>
        </div>
      </div>
      ${Object.keys(project.defaults).length > 0
        ? html`
            <div class="cp-section">
              <div class="cp-section-title">Defaults</div>
              <div class="cp-pool-info">
                ${Object.entries(project.defaults).map(
                  ([key, val]) => html`
                    <div class="cp-info-row">
                      <span class="cp-info-label">${key}</span>
                      <span class="cp-info-value">${val.runner}/${val.model}</span>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private renderFlowsContent() {
    const { flowType, mode, laneMode, project } = this._flowsState;
    // If global filter has exactly one project, prefer it
    const effectiveProject =
      this._filters.projects.length === 1 ? this._filters.projects[0] : project;
    return html` <div style="height:100%; overflow:hidden">
      <flow-graph
        showSelector
        .flowType=${flowType}
        .mode=${mode}
        .laneMode=${laneMode}
        .project=${effectiveProject}
        @fg-state-change=${this._onFlowsStateChange}
      >
      </flow-graph>
    </div>`;
  }

  private renderSettingsContent() {
    return html`
      <div class="cp-section">
        <div class="cp-section-title">Attention alerts</div>
        <div class="cp-auto-card">
          <div class="cp-auto-card-head">
            <div>
              <div class="cp-auto-title">Human action required</div>
              <div class="cp-auto-subtitle">
                Alert this browser when a new decision or monitor violation needs operator action.
              </div>
            </div>
            ${this.renderAttentionToggle('attentionEnabled', 'Enabled')}
          </div>
          <div class="cp-auto-card-head">
            <div>
              <div class="cp-auto-title">Sound</div>
              <div class="cp-auto-subtitle">
                Play a short two-tone alert even while this tab is focused.
              </div>
            </div>
            ${this.renderAttentionToggle('sound', 'Sound')}
          </div>
          <div class="cp-auto-card-head">
            <div>
              <div class="cp-auto-title">Background notifications</div>
              <div class="cp-auto-subtitle">
                Show all browser notifications, including dispatch completion, while Command Center
                is in the background.
              </div>
            </div>
            ${this.renderAttentionToggle('backgroundNotifications', 'Background')}
          </div>
        </div>
      </div>
      <div class="cp-section">
        <div class="cp-section-title">Alpha Features</div>
        <div class="cp-auto-card">
          <div class="cp-auto-card-head">
            <div>
              <div class="cp-auto-title">Show alpha features</div>
              <div class="cp-auto-subtitle">
                Gateway Intelligence and Evals are alpha — early, under-tested, and subject to
                change. They're hidden from the nav and their routes redirect to Fleet by default;
                flip this on to reveal and use them.
              </div>
            </div>
            <label class="cp-switch-row">
              <input
                type="checkbox"
                .checked=${this._alphaFeaturesEnabled}
                @change=${(e: Event) => {
                  const enabled = (e.target as HTMLInputElement).checked;
                  this._alphaFeaturesEnabled = enabled;
                  setAlphaFeaturesEnabled(enabled);
                }}
              />
              Enabled
            </label>
          </div>
        </div>
      </div>
    `;
  }

  private renderAttentionToggle(key: keyof AttentionAlertPreferences, label: string) {
    return html`<label class="cp-switch-row">
      <input
        type="checkbox"
        .checked=${this._attentionAlerts[key]}
        ?disabled=${key !== 'attentionEnabled' && !this._attentionAlerts.attentionEnabled}
        @change=${(event: Event) => {
          this._attentionAlerts = {
            ...this._attentionAlerts,
            [key]: (event.target as HTMLInputElement).checked,
          };
          setAttentionAlertPreferences(this._attentionAlerts);
        }}
      />
      ${label}
    </label>`;
  }

  private renderContent() {
    if (!this._selection) return html`<div class="cp-empty">Select a pool or project</div>`;

    if (this._selection.kind === 'llm') return html`<llm-config></llm-config>`;

    if (this._selection.kind === 'settings') return this.renderSettingsContent();

    if (this._selection.kind === 'flows') return this.renderFlowsContent();

    if (this._selection.kind === 'pool') {
      const pool = this.getSelectedPool();
      if (!pool) return html`<div class="cp-empty">Pool not found</div>`;
      return this.renderPoolContent(pool);
    }

    const project = this.getSelectedProject();
    if (!project) return html`<div class="cp-empty">Project not found</div>`;
    return this.renderProjectContent(project);
  }

  private renderSources() {
    return this._selection?.kind !== 'flows'
      ? html`<source-status-panel
          .context=${{
            target:
              this._selection?.kind === 'pool'
                ? { scope: 'node', targetId: this._selection.machine }
                : { scope: 'farm', targetId: 'farm' },
            actions: ['sync', 'pin', 'unpin'],
          }}
        ></source-status-panel>`
      : nothing;
  }

  render() {
    return html`
      ${renderConfigPanelStyles()} ${this._loading ? nothing : this.renderSidebar()}
      <div
        class="cp-content"
        style="${this._selection?.kind === 'flows' ? 'padding:0; overflow:hidden;' : ''}"
      >
        ${this.configurationAge
          ? html`<p data-configuration-stale>${this.configurationAge}</p>`
          : nothing}
        ${this._configurationError
          ? html`<p role="alert">${this._configurationError}</p>`
          : nothing}
        ${this._loading
          ? html`<div class="cp-empty" style=${configPanelLoadingStyle}>Loading config...</div>`
          : this.renderContent()}
        ${this.renderSources()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'config-panel': ConfigPanel;
  }
}
