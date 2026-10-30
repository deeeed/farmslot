import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  ConfigPoolResult,
  ScriptComplete,
  ScriptOutput,
  SlotHealth,
  SlotStatus,
  TaskProgressResult,
  TaskProgressStructured,
} from '@farmslot/protocol';
import { Events, Methods, sourceObservationAge } from '@farmslot/protocol';
import { resourceQuery, type ResourceQueryState } from '@farmslot/protocol/client-cache';

import '../terminal/terminal-view.js';
import '../progress-tracker/progress-tracker.js';
import '../workspace/slot-workspace.js';

import { readConfiguration } from '../../configuration-resources.js';
import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import {
  getState,
  isFleetCurrent,
  onWorkspaceOwnerChange,
  requireCurrentFleet,
  subscribe,
} from '../../state.js';
import { colors, lifecycleColor } from '../../styles/theme-tokens.js';
import { SLOT_OPERATION_TIMEOUT_MS } from '../../utils/resource-operation-timeout.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import {
  heldDataIsSaved,
  isSupersededRead,
  readKeepsFailing,
  ResourceQueryController,
} from '../shared/resource-query-controller.js';

import { slotDetailStyles } from './slot-detail-styles.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

type EditorId = 'cursor' | 'vscode';
interface EditorOption {
  id: EditorId;
  label: string;
  scheme: string;
}

const EDITORS: EditorOption[] = [
  { id: 'cursor', label: 'Cursor', scheme: 'cursor' },
  { id: 'vscode', label: 'VS Code', scheme: 'vscode' },
];

const EDITOR_PREF_KEY = 'farmslot:preferred-editor';

type SlotDetailActionMethod =
  | typeof Methods.SLOT_PREPARE
  | typeof Methods.SLOT_RELEASE
  | typeof Methods.SLOT_RECYCLE;

@customElement('slot-detail')
export class SlotDetail extends LitElement {
  @property({ type: String }) slotId = '';
  @property({ type: String }) initialTab: 'detail' | 'workspace' = 'detail';

  @state() private _slot: SlotStatus | null = null;
  @state() private _checks: CheckResult[] = [];
  @state() private _loading = false;
  @state() private _actionOutput: string[] = [];
  @state() private _actionRunning = false;
  @state() private _actionRequestId = '';
  @state() private _actionExitCode: number | null = null;
  @state() private _pendingConfirm: string | null = null;
  @state() private _structuredProgress?: TaskProgressStructured;
  @state() private progressObservation: ResourceQueryState<TaskProgressResult> = {
    status: 'loading',
  };
  private progressAgeTimer?: ReturnType<typeof setInterval>;
  private readonly progressQuery = new ResourceQueryController<TaskProgressResult>(
    this,
    (state) => {
      this.progressObservation = state;
      if (state.data && state.status !== 'ready' && !this.progressAgeTimer)
        this.progressAgeTimer = setInterval(() => this.requestUpdate(), 60_000);
      else if (!state.data || state.status === 'ready') {
        clearInterval(this.progressAgeTimer);
        this.progressAgeTimer = undefined;
      }
      this._structuredProgress = state.data?.structured;
    },
  );
  @state() private _repoPath = '';
  @state() private _editor: EditorId = 'cursor';
  @state() private _viewTab: 'detail' | 'workspace' = 'detail';
  @state() private _terminalOpen = true;

  private _unsubOutput?: () => void;
  private _unsubComplete?: () => void;
  private _unsubState?: () => void;
  private _unsubOwner?: () => void;
  private _slotScope = '';
  private _scopeVersion = 0;
  private readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });

  static styles = slotDetailStyles;

  connectedCallback() {
    super.connectedCallback();
    const saved = localStorage.getItem(EDITOR_PREF_KEY);
    if (saved && EDITORS.some((e) => e.id === saved)) this._editor = saved as EditorId;
    if (this.initialTab) this._viewTab = this.initialTab;
    this._loadSlot();
    this._unsubState = subscribe(() => {
      this._loadSlot();
      this.requestUpdate();
    });
    this._unsubOwner = onWorkspaceOwnerChange(() => this._applySlot(null));

    this._unsubOutput = gateway.subscribe(Events.SCRIPT_OUTPUT, (payload: unknown) => {
      const data = payload as ScriptOutput;
      if (this._actionRequestId && data.requestId === this._actionRequestId) {
        this._actionOutput = [...this._actionOutput, data.data];
      }
    });

    this._unsubComplete = gateway.subscribe(Events.SCRIPT_COMPLETE, (payload: unknown) => {
      const data = payload as ScriptComplete;
      if (this._actionRequestId && data.requestId === this._actionRequestId) {
        this._actionRunning = false;
        this._actionExitCode = data.exitCode;
        // Refresh slot status after action completes
        this._loadSlot();
      }
    });
  }

  disconnectedCallback() {
    this._scopeVersion++;
    this._actionRequestId = '';
    clearInterval(this.progressAgeTimer);
    this.progressAgeTimer = undefined;
    super.disconnectedCallback();
    this._unsubOutput?.();
    this._unsubComplete?.();
    this._unsubState?.();
    this._unsubOwner?.();
    this._confirmTimer.clear();
  }

  protected override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('slotId')) this._loadSlot();
    if (changed.has('slotId') || changed.has('_slot')) {
      const slot = this._slot?.slot === this.slotId ? this._slot : null;
      this.progressQuery.setQuery(
        slot?.taskFile
          ? resourceQuery<TaskProgressResult>(Methods.TASK_PROGRESS, {
              slotId: this.slotId,
              ...(slot.currentRunId ? { runId: slot.currentRunId } : {}),
            })
          : undefined,
      );
      this._structuredProgress = this.progressQuery.belongsToWorkspace
        ? this.progressQuery.state.data?.structured
        : undefined;
    }
  }

  private _loadSlot() {
    const stored = getState().fleet?.slots.find((slot) => slot.slot === this.slotId) ?? null;
    const previousScope = this._slotScope;
    this._applySlot(stored);
    if (stored && previousScope !== this._slotScope) void this._fetchRepoPath(stored.machine);
    this._loading = false;
  }

  private _applySlot(slot: SlotStatus | null): void {
    const scope = JSON.stringify([
      getResourceWorkspaceKey(),
      gateway.resourceConnectionId,
      this.slotId,
      slot?.currentRunId,
      slot?.taskFile,
    ]);
    if (scope !== this._slotScope) {
      this._slotScope = scope;
      this._scopeVersion++;
      this._confirmTimer.clear();
      this._actionRequestId = '';
      this._actionRunning = false;
      this._actionOutput = [];
      this._actionExitCode = null;
      this._checks = [];
      this._repoPath = '';
    }
    this._slot = slot;
    if (!slot) {
      this.progressQuery.setQuery(undefined);
      this._structuredProgress = undefined;
    }
  }

  private _captureScope(): () => boolean {
    const version = this._scopeVersion;
    const slotId = this.slotId;
    const owner = getResourceWorkspaceKey();
    const connection = gateway.resourceConnectionId;
    return () =>
      this.isConnected &&
      this._scopeVersion === version &&
      this.slotId === slotId &&
      getResourceWorkspaceKey() === owner &&
      gateway.resourceConnectionId === connection;
  }

  private async _fetchRepoPath(machine: string) {
    const current = this._captureScope();
    const slotId = this.slotId;
    try {
      const res = await readConfiguration<ConfigPoolResult>(Methods.CONFIG_POOL, { machine });
      if (!current()) return;
      const slotCfg = res.pool.slots.find((s) => s.id === slotId);
      if (slotCfg) this._repoPath = slotCfg.repo;
    } catch {
      // Without pool configuration there is no path to offer the editor.
      if (current()) this._repoPath = '';
    }
  }

  private async _runAction(method: SlotDetailActionMethod, params: Record<string, unknown>) {
    const current = this._captureScope();
    const requestId = `slot-action-${crypto.randomUUID()}`;
    this._actionOutput = [];
    this._actionRunning = true;
    this._actionExitCode = null;
    this._actionRequestId = requestId;

    try {
      this._requireCurrentSlot();
      if (params.slotId !== this.slotId) throw new Error('The selected slot changed.');
      await gateway.request(method, { ...params, requestId }, SLOT_OPERATION_TIMEOUT_MS);
      if (!current() || this._actionRequestId !== requestId) return;
      // Some slot methods stream script.complete; others complete only via the
      // RPC response. Treat the response as the fallback completion signal so
      // the older slot-detail action panel does not spin forever.
      if (this._actionRunning) {
        this._actionRunning = false;
        this._actionExitCode = 0;
        this._loadSlot();
      }
    } catch (err: unknown) {
      if (!current() || this._actionRequestId !== requestId) return;
      this._actionRunning = false;
      const msg = err instanceof Error ? err.message : 'Action failed';
      this._actionOutput = [`ERROR: ${msg}`];
    }
  }

  private _confirmAction(actionId: string, fn: () => void) {
    try {
      this._applySlot(this._requireCurrentSlot());
      this._confirmTimer.confirm(actionId, fn);
    } catch (error) {
      this._confirmTimer.clear();
      this._actionOutput = [`ERROR: ${(error as Error).message}`];
    }
  }

  private _requireCurrentSlot(): SlotStatus {
    const slot = requireCurrentFleet().slots.find((row) => row.slot === this.slotId);
    if (!slot) throw new Error('The slot is no longer in the current fleet.');
    return slot;
  }

  private _prepare() {
    this._confirmAction('prepare', () =>
      this._runAction(Methods.SLOT_PREPARE, { slotId: this.slotId }),
    );
  }

  private _release(keepWarm = false) {
    const id = keepWarm ? 'release-warm' : 'release';
    this._confirmAction(id, () =>
      this._runAction(Methods.SLOT_RELEASE, { slotId: this.slotId, keepWarm }),
    );
  }

  private _recycle(forceReset = false) {
    this._confirmAction(forceReset ? 'force-recycle' : 'recycle', () =>
      this._runAction(Methods.SLOT_RECYCLE, { slotId: this.slotId, forceReset }),
    );
  }

  private _resourceHealthItems(slot: SlotStatus): Array<[string, string]> {
    const RESOURCE_HEALTH: Record<string, { label: string; field: keyof SlotHealth }> = {
      'ios-sim': { label: 'iOS Sim', field: 'device' },
      'ios-device': { label: 'iOS Dev', field: 'device' },
      'android-emu': { label: 'Android', field: 'device' },
      'android-device': { label: 'Android', field: 'device' },
      'dev-server': { label: 'DevSrv', field: 'devserver' },
      browser: { label: 'Browser', field: 'cdp' },
    };
    if (slot.resources && Object.keys(slot.resources).length > 0) {
      const items: Array<[string, string]> = [];
      for (const key of Object.keys(slot.resources)) {
        const mapping = RESOURCE_HEALTH[key];
        if (mapping) {
          const val = slot.health[mapping.field];
          if (val && val !== '-') items.push([mapping.label, val]);
        }
      }
      if (!slot.resources['browser'] && slot.health.cdp && slot.health.cdp !== '-') {
        items.push(['CDP', slot.health.cdp]);
      }
      return items;
    }
    return (['device', 'devserver', 'cdp'] as const)
      .filter((k) => slot.health[k] && slot.health[k] !== '-')
      .map((k) => [
        k === 'device' ? 'Device' : k === 'devserver' ? 'DevSrv' : 'CDP',
        slot.health[k],
      ]);
  }

  private _handleBack() {
    this.dispatchEvent(new CustomEvent('slot-back', { bubbles: true, composed: true }));
  }

  private async _openEditor() {
    try {
      await gateway.request(Methods.SLOT_OPEN_EDITOR, {
        slotId: this.slotId,
        editor: this._editor,
      });
    } catch (err) {
      console.error('[slot-detail] openEditor failed:', err);
    }
  }

  private async _revealArtifacts() {
    const slot = this._slot;
    if (!slot?.taskFile) return;
    // For local slots: reveal worker-side artifacts
    // For remote slots: FS_REVEAL won't work (open -R is local-only),
    // so we still try — gateway will fail gracefully
    try {
      await gateway.request(Methods.FS_REVEAL, {
        slotId: this.slotId,
        path: `temp/.task/${slot.taskFile}/artifacts`,
      });
    } catch (err) {
      console.error('[slot-detail] revealArtifacts failed:', err);
    }
  }

  private _setEditor(id: EditorId) {
    this._editor = id;
    localStorage.setItem(EDITOR_PREF_KEY, id);
  }

  private get _isLocal(): boolean {
    return this._slot?.health.ssh === 'LOCAL';
  }

  private _renderProgressStatus() {
    const observation = this.progressObservation;
    if (!(this.progressQuery.belongsToWorkspace && Boolean(this._slot?.taskFile))) return nothing;
    const failure =
      observation.error && !isSupersededRead(observation.error) ? observation.error : undefined;
    const notRead = readKeepsFailing(this.progressQuery);
    if (
      observation.status !== 'unsupported' &&
      !failure &&
      !notRead &&
      !heldDataIsSaved(observation)
    )
      return nothing;
    return html`<div class="progress-strip" data-slot-detail-progress=${observation.status}>
      ${observation.data
        ? html`Saved progress, ${sourceObservationAge(observation.observedAt)}.`
        : notRead
          ? 'Progress not read yet.'
          : nothing}
      ${observation.status === 'unsupported'
        ? 'Progress updates are unavailable on this gateway.'
        : nothing}
      ${failure
        ? html`<span role="alert">Progress read failed: ${failure.message}</span>`
        : nothing}
      ${observation.error || notRead
        ? html`<button
            ?disabled=${gateway.connectionState !== 'connected'}
            @click=${() => this.progressQuery.retry()}
          >
            Retry reading progress
          </button>`
        : nothing}
    </div>`;
  }

  private _renderDetail() {
    const slot = this._slot!;
    return html`
      <div class="detail-body">
        <!-- Info section -->
        <div class="section">
          <div class="section-title">Slot Info</div>
          <div class="info-grid">
            <span class="info-key">Machine</span>
            <span class="info-val">${slot.machine}</span>
            <span class="info-key">Platform</span>
            <span class="info-val">${slot.platform}</span>
            <span class="info-key">Project</span>
            <span class="info-val">${slot.project}</span>
            <span class="info-key">Branch</span>
            <span class="info-val">${slot.branch || 'main'}</span>
            <span class="info-key">Agent</span>
            <span class="info-val">${slot.agent}</span>
            <span class="info-key">Runner</span>
            <span class="info-val">${slot.runner || '-'}</span>
            <span class="info-key">Model</span>
            <span class="info-val">${slot.model || '-'}</span>
            ${slot.health.devserver && slot.health.devserver !== '-'
              ? html`
                  <span class="info-key">DevServer</span>
                  <span class="info-val">${slot.health.devserver}</span>
                `
              : ''}
            ${slot.deviceName
              ? html`
                  <span class="info-key">Device</span>
                  <span class="info-val">${slot.deviceName}</span>
                `
              : ''}
            ${slot.taskId
              ? html`
                  <span class="info-key">Task</span>
                  <span class="info-val">${slot.taskId}</span>
                `
              : ''}
            ${slot.dispatchedAt
              ? html`
                  <span class="info-key">Dispatched</span>
                  <span class="info-val">${new Date(slot.dispatchedAt).toLocaleString()}</span>
                `
              : ''}
          </div>
        </div>

        <!-- Health checks section -->
        <div class="section">
          <div class="section-title">Health Checks</div>
          ${this._checks.length > 0
            ? html`
                <ul class="check-list">
                  ${this._checks.map(
                    (c) => html`
                      <li class="check-item">
                        <span
                          class="check-dot"
                          style="background:${c.status === 'pass'
                            ? colors.statusOk
                            : colors.statusFail}"
                        ></span>
                        <span class="check-name">${c.name}</span>
                        <span class="check-detail">${c.detail}</span>
                      </li>
                    `,
                  )}
                </ul>
              `
            : html`
                <div class="info-grid">
                  <span class="info-key">SSH</span>
                  <span class="info-val">${slot.health.ssh}</span>
                  ${this._resourceHealthItems(slot).map(
                    ([label, val]) => html`
                      <span class="info-key">${label}</span>
                      <span class="info-val">${val}</span>
                    `,
                  )}
                  <span class="info-key">Fixtures</span>
                  <span class="info-val">${slot.health.fixtures}</span>
                </div>
              `}
        </div>

        <!-- Actions section -->
        <div class="section">
          <div class="section-title">Lifecycle Actions</div>
          <div class="actions-row">
            <button
              class="action-btn ${this._pendingConfirm === 'prepare' ? 'confirming' : 'primary'}"
              ?disabled=${this._actionRunning || !isFleetCurrent()}
              @click=${this._prepare}
            >
              ${this._pendingConfirm === 'prepare' ? 'Confirm Prepare?' : 'Prepare'}
            </button>
            <button
              class="action-btn ${this._pendingConfirm === 'release' ? 'confirming' : ''}"
              ?disabled=${this._actionRunning || !isFleetCurrent()}
              @click=${() => this._release(false)}
            >
              ${this._pendingConfirm === 'release' ? 'Confirm Release?' : 'Release'}
            </button>
            <button
              class="action-btn ${this._pendingConfirm === 'release-warm' ? 'confirming' : ''}"
              ?disabled=${this._actionRunning || !isFleetCurrent()}
              @click=${() => this._release(true)}
            >
              ${this._pendingConfirm === 'release-warm' ? 'Confirm?' : 'Release --keep-warm'}
            </button>
            <button
              class="action-btn ${this._pendingConfirm === 'recycle' ? 'confirming' : 'danger'}"
              ?disabled=${this._actionRunning || !isFleetCurrent()}
              @click=${this._recycle}
            >
              ${this._pendingConfirm === 'recycle' ? 'Confirm Recycle?' : 'Recycle'}
            </button>
          </div>

          ${this._actionOutput.length > 0
            ? html`
                <div class="output-panel" style="margin-top:12px">
                  ${this._actionOutput.map((line) => html`<div>${line}</div>`)}
                  ${this._actionRunning
                    ? html`<div style="color:${colors.accent}">Running...</div>`
                    : ''}
                  ${!this._actionRunning &&
                  this._actionOutput.some((l) => l.includes('UNMERGED_WORK:'))
                    ? html`
                        <button
                          class="action-btn danger"
                          style="margin-top:8px"
                          ?disabled=${this._actionRunning || !isFleetCurrent()}
                          @click=${() => this._recycle(true)}
                        >
                          Force Reset
                        </button>
                      `
                    : ''}
                  ${this._actionExitCode !== null
                    ? html`
                        <div
                          class="exit-badge"
                          style="background:${this._actionExitCode === 0
                            ? colors.statusOk + '22'
                            : colors.statusFail + '22'}; color:${this._actionExitCode === 0
                            ? colors.statusOk
                            : colors.statusFail}"
                        >
                          Exit ${this._actionExitCode}
                        </div>
                      `
                    : ''}
                </div>
              `
            : ''}
        </div>

        ${this._renderProgressStatus()}
        ${slot.lifecycle === 'busy' && this._structuredProgress?.totalSteps
          ? html`<div class="section">
              <progress-tracker
                .structured=${this._structuredProgress}
                .runId=${slot.currentRunId ?? undefined}
                .runActive=${true}
              ></progress-tracker>
            </div>`
          : nothing}
      </div>
    `;
  }

  private _renderWorkspace() {
    return html`<slot-workspace .slotId=${this.slotId}></slot-workspace>`;
  }

  render() {
    const slot = this._slot;
    if (this._loading && !slot) {
      return html`<div style="padding:24px; color:${colors.textMuted}">Loading...</div>`;
    }
    if (!slot) {
      return html`<div style="padding:24px; color:${colors.textMuted}">Slot not found</div>`;
    }

    const lcColor = lifecycleColor(slot.lifecycle);

    return html`
      <div class="detail-header">
        <button class="back-btn" @click=${this._handleBack}>&larr;</button>
        <span class="slot-title">${slot.slot}</span>
        <span class="lifecycle-badge" style="background:${lcColor}22; color:${lcColor}">
          ${slot.lifecycle}
        </span>
        <div class="view-tabs">
          <button
            class="view-tab ${this._viewTab === 'detail' ? 'active' : ''}"
            @click=${() => {
              this._viewTab = 'detail';
              location.hash = `slot/${this.slotId}`;
            }}
          >
            Detail
          </button>
          <button
            class="view-tab ${this._viewTab === 'workspace' ? 'active' : ''}"
            @click=${() => {
              this._viewTab = 'workspace';
              location.hash = `slot/${this.slotId}/workspace`;
            }}
          >
            Workspace
          </button>
        </div>
        <div class="header-actions">
          ${this._isLocal && this._slot?.taskFile
            ? html` <button class="header-link" @click=${this._revealArtifacts}>Artifacts</button> `
            : ''}
          ${this._repoPath
            ? html`
                <button class="header-link" @click=${this._openEditor}>
                  Open in ${EDITORS.find((e) => e.id === this._editor)!.label}
                </button>
                <div class="editor-group">
                  ${EDITORS.map(
                    (e) => html`
                      <button
                        class="editor-btn ${this._editor === e.id ? 'active' : ''}"
                        @click=${() => this._setEditor(e.id)}
                      >
                        ${e.label}
                      </button>
                    `,
                  )}
                </div>
              `
            : ''}
        </div>
      </div>

      <div class="tab-content">
        ${this._viewTab === 'detail' ? this._renderDetail() : this._renderWorkspace()}
      </div>

      <div class="terminal-panel">
        <div
          class="terminal-toggle"
          @click=${() => {
            this._terminalOpen = !this._terminalOpen;
          }}
        >
          <span>${this._terminalOpen ? '\u25BE' : '\u25B8'} Terminal</span>
        </div>
        ${this._terminalOpen
          ? html`
              <div class="terminal-body">
                <terminal-view
                  .slotId=${this.slotId}
                  .runId=${this._slot?.currentRunId ?? ''}
                ></terminal-view>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-detail': SlotDetail;
  }
}
