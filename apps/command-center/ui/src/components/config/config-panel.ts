import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type {
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

import './llm-config.js';
import './template-viewer.js';
import './slot-toggle.js';
import '../flow-graph/flow-graph.js';

import { gateway } from '../../gateway-client.js';
import { getState, type GlobalFilters, subscribe } from '../../state.js';
import { getAlphaFeaturesEnabled, setAlphaFeaturesEnabled } from '../../utils/alpha-features.js';
import { renderMarkdown } from '../../utils/markdown.js';

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

  // Light DOM so Monaco CSS works
  protected override createRenderRoot() {
    return this;
  }

  private _connUnsub?: () => void;
  private _stateUnsub?: () => void;

  connectedCallback() {
    super.connectedCallback();
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
      if (sel) this._selection = sel;
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
    this._loading = true;
    try {
      const [poolsRes, projectsRes] = await Promise.all([
        gateway.request(Methods.CONFIG_POOLS, {}) as Promise<ConfigPoolsResult>,
        gateway.request(Methods.CONFIG_PROJECTS, {}) as Promise<ConfigProjectsResult>,
      ]);
      this._pools = poolsRes.pools;
      this._projects = projectsRes.projects;
      // Pre-select from route param, or auto-select first visible item
      if (this.initialPath) {
        const sel = this._parseInitialPath(this.initialPath);
        if (sel) this._selection = sel;
      } else if (!this._selection) {
        const pools = this.filteredPools;
        const projects = this.filteredProjects;
        if (pools.length > 0) {
          this._selection = { kind: 'pool', machine: pools[0].machine };
        } else if (projects.length > 0) {
          this._selection = { kind: 'project', name: projects[0].name };
        }
      }
    } catch (err) {
      console.error('[config-panel] load error:', (err as Error).message);
    } finally {
      this._loading = false;
    }
  }

  private selectPool(machine: string) {
    this._selection = { kind: 'pool', machine };
    this._poolViewMode = 'structured';
    this._editorDirty = false;
    this._editorError = '';
    this._updateHash();
  }

  private selectProject(name: string) {
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
    if (!force && this._projectLearnings.has(projectName)) return;
    this._projectLearningsLoading = true;
    this._projectLearningsError = '';
    try {
      const result = (await gateway.request(Methods.CONFIG_PROJECT, {
        project: projectName,
      })) as ConfigProjectResult;
      this._projects = this._projects.map((p) => (p.name === projectName ? result.project : p));
      this._projectLearnings = new Map(this._projectLearnings).set(projectName, result.learnings);
    } catch (err) {
      this._projectLearningsError = err instanceof Error ? err.message : String(err);
    } finally {
      this._projectLearningsLoading = false;
    }
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
    try {
      const res = (await gateway.request(Methods.CONFIG_POOL_RAW, { machine: pool.machine })) as {
        raw: string;
      };
      this._editorContent = res.raw;
      this._poolViewMode = 'editor';
      this._editorDirty = false;
      this._editorError = '';
    } catch (err) {
      this._editorError = (err as Error).message;
    }
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
    try {
      const result = (await gateway.request(Methods.CONFIG_POOL_UPDATE, {
        machine: this._selection.machine,
        content: this._editorContent,
      })) as ConfigPoolUpdateResult;
      if (result.ok) {
        this._editorDirty = false;
        this._poolViewMode = 'structured';
        await this.loadData();
      }
    } catch (err) {
      this._editorError = (err as Error).message;
    } finally {
      this._saving = false;
    }
  }

  private draftFromProject(project: ProjectConfig): AutoRecoveryDraft {
    return autoRecoveryDraftFromProject(project);
  }

  private autoRecoveryDraft(project: ProjectConfig): AutoRecoveryDraft {
    if (!this._autoRecoveryDraft || this._autoRecoveryDraft.project !== project.name) {
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

  private renderPoolEditor() {
    return html`
      <div class="cp-pool-header">
        <h3>Edit Pool JSON</h3>
        <div class="cp-editor-actions">
          ${this._editorDirty ? html`<span class="cp-unsaved">Unsaved changes</span>` : nothing}
          <button
            class="cp-action-btn secondary"
            @click=${() => {
              this._poolViewMode = 'structured';
            }}
          >
            Cancel
          </button>
          <button
            class="cp-action-btn"
            ?disabled=${!!this._editorError || this._saving || !this._editorDirty}
            @click=${() => this.savePoolJson()}
          >
            ${this._saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      ${this._editorError ? html`<div class="cp-editor-error">${this._editorError}</div>` : nothing}
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
                    ${unsafeHTML(renderMarkdown(learnings.content))}
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
              ?disabled=${!this._autoRecoveryDirty || this._autoRecoverySaving}
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

  render() {
    if (this._loading)
      return html`<div class="cp-empty" style=${configPanelLoadingStyle}>Loading config...</div>`;

    return html`
      ${renderConfigPanelStyles()} ${this.renderSidebar()}
      <div
        class="cp-content"
        style="${this._selection?.kind === 'flows' ? 'padding:0; overflow:hidden;' : ''}"
      >
        ${this.renderContent()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'config-panel': ConfigPanel;
  }
}
