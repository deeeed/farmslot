import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  PoolConfig,
  ScriptComplete,
  ScriptOutput,
  SlotHealth,
  SlotStatus,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import '../terminal/terminal-view.js';
import '../workspace/slot-workspace.js';

import { gateway } from '../../gateway-client.js';
import { getState, subscribe } from '../../state.js';
import { colors, lifecycleColor } from '../../styles/theme-tokens.js';
import { ConfirmActionTimer } from '../shared/confirm-action-model.js';

import { slotDetailStyles } from './slot-detail-styles.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

interface TaskStep {
  text: string;
  checked: boolean;
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
  @state() private _taskSteps: TaskStep[] = [];
  @state() private _taskProgress = 0;
  @state() private _repoPath = '';
  @state() private _editor: EditorId = 'cursor';
  @state() private _viewTab: 'detail' | 'workspace' = 'detail';
  @state() private _terminalOpen = true;

  private _unsubSlot?: () => void;
  private _unsubOutput?: () => void;
  private _unsubComplete?: () => void;
  private _unsubState?: () => void;
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
    if (this.slotId) this._loadSlot();

    // Re-load slot when fleet data arrives or updates (e.g., after page refresh or reconnect)
    this._unsubState = subscribe((s) => {
      if (s.fleet && this.slotId) {
        const fresh = s.fleet.slots.find((sl) => sl.slot === this.slotId);
        if (fresh) this._slot = fresh;
        if (!this._slot) this._loadSlot();
      }
    });

    this._unsubSlot = gateway.subscribe(Events.SLOT_CHANGED, (payload: unknown) => {
      const slot = payload as SlotStatus;
      if (slot.slot === this.slotId) {
        this._slot = slot;
      }
    });

    this._unsubOutput = gateway.subscribe(Events.SCRIPT_OUTPUT, (payload: unknown) => {
      const data = payload as ScriptOutput;
      if (data.requestId === this._actionRequestId) {
        this._actionOutput = [...this._actionOutput, data.data];
      }
    });

    this._unsubComplete = gateway.subscribe(Events.SCRIPT_COMPLETE, (payload: unknown) => {
      const data = payload as ScriptComplete;
      if (data.requestId === this._actionRequestId) {
        this._actionRunning = false;
        this._actionExitCode = data.exitCode;
        // Refresh slot status after action completes
        this._loadSlot();
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubSlot?.();
    this._unsubOutput?.();
    this._unsubComplete?.();
    this._unsubState?.();
    this._confirmTimer.clear();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('slotId') && this.slotId) {
      this._loadSlot();
    }
  }

  private _loadSlot() {
    // Load slot data from fleet store (instant, no RPC needed)
    const fleet = getState().fleet;
    if (!fleet) return; // Fleet not loaded yet — keep _loading true, subscription will retry
    const stored = fleet.slots.find((s) => s.slot === this.slotId);
    if (stored) {
      this._slot = stored;
      if (stored.lifecycle === 'busy' && stored.taskFile) {
        this._parseTaskSteps(stored.taskFile);
      }
      this._fetchRepoPath(stored.machine);
    }
    this._loading = false;
  }

  private async _fetchRepoPath(machine: string) {
    try {
      const res = await gateway.request<{ pool: PoolConfig }>(Methods.CONFIG_POOL, { machine });
      const slotCfg = res.pool.slots.find((s) => s.id === this.slotId);
      if (slotCfg) this._repoPath = slotCfg.repo;
    } catch {
      /* pool config unavailable */
    }
  }

  private async _parseTaskSteps(_taskFile: string) {
    try {
      const result = await gateway.request<import('@farmslot/protocol').TaskProgressResult>(
        Methods.TASK_PROGRESS,
        { slotId: this.slotId },
      );
      if (result.structured) {
        const steps: TaskStep[] = [];
        for (const phase of result.structured.phases) {
          for (const step of phase.steps) {
            steps.push({ text: step.name, checked: step.status === 'done' });
          }
        }
        this._taskSteps = steps;
        this._taskProgress =
          result.structured.totalSteps > 0
            ? result.structured.completedSteps / result.structured.totalSteps
            : 0;
      }
    } catch {
      /* ignore — slot may not have a parseable task file */
    }
  }

  private async _runAction(method: string, params: Record<string, unknown>) {
    const requestId = `slot-action-${crypto.randomUUID()}`;
    this._actionOutput = [];
    this._actionRunning = true;
    this._actionExitCode = null;
    this._actionRequestId = requestId;

    // Slot operations (prepare, release, recycle) can take minutes on remote machines
    const SLOT_TIMEOUT = 5 * 60_000;
    try {
      await gateway.request(method, { ...params, requestId }, SLOT_TIMEOUT);
      // Some slot methods stream script.complete; others complete only via the
      // RPC response. Treat the response as the fallback completion signal so
      // the older slot-detail action panel does not spin forever.
      if (this._actionRunning) {
        this._actionRunning = false;
        this._actionExitCode = 0;
        this._loadSlot();
      }
    } catch (err: unknown) {
      this._actionRunning = false;
      const msg = err instanceof Error ? err.message : 'Action failed';
      this._actionOutput = [`ERROR: ${msg}`];
    }
  }

  private _confirmAction(actionId: string, fn: () => void) {
    this._confirmTimer.confirm(actionId, fn);
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
              ?disabled=${this._actionRunning}
              @click=${this._prepare}
            >
              ${this._pendingConfirm === 'prepare' ? 'Confirm Prepare?' : 'Prepare'}
            </button>
            <button
              class="action-btn ${this._pendingConfirm === 'release' ? 'confirming' : ''}"
              ?disabled=${this._actionRunning}
              @click=${() => this._release(false)}
            >
              ${this._pendingConfirm === 'release' ? 'Confirm Release?' : 'Release'}
            </button>
            <button
              class="action-btn ${this._pendingConfirm === 'release-warm' ? 'confirming' : ''}"
              ?disabled=${this._actionRunning}
              @click=${() => this._release(true)}
            >
              ${this._pendingConfirm === 'release-warm' ? 'Confirm?' : 'Release --keep-warm'}
            </button>
            <button
              class="action-btn ${this._pendingConfirm === 'recycle' ? 'confirming' : 'danger'}"
              ?disabled=${this._actionRunning}
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

        <!-- Task progress section (if working) -->
        ${slot.lifecycle === 'busy' && this._taskSteps.length > 0
          ? html`
              <div class="section">
                <div class="section-title">
                  Task Progress ${Math.round(this._taskProgress * 100)}%
                </div>
                <div class="progress-bar-container">
                  <div class="progress-bar-fill" style="width:${this._taskProgress * 100}%"></div>
                </div>
                ${this._taskSteps.map(
                  (step) => html`
                    <div class="task-step">
                      <div class="task-checkbox ${step.checked ? 'checked' : ''}">
                        ${step.checked ? '\u2713' : ''}
                      </div>
                      <span class="task-text ${step.checked ? 'checked' : ''}">${step.text}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : ''}
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
