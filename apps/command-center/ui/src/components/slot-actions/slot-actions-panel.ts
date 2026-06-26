// slot-actions-panel.ts — Shared lifecycle action surface.
//
// Renders the built-in slot actions (Prepare, Release, Refresh, Recycle,
// Cleanup) plus any project-configured slot_actions, with a live output
// panel that streams script.output / script.complete events from the
// gateway. Used by:
//
//   - slot-view sidebar Actions section (inline)
//   - slot-actions-modal (fleet-view "···" menu)
//   - slot-detail (older single-slot view) — migrated separately
//
// Owns its own state + subscriptions. Drop in with `<slot-actions-panel
// slot-id="…"></slot-actions-panel>` and it self-loads.

import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  ScriptComplete,
  ScriptOutput,
  SlotActionListResult,
  SlotActionRunResult,
  SlotActionSummary,
  SlotRefreshResult,
  SlotStatus,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

import { ConfirmActionTimer } from '../shared/confirm-action-model.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';
import { SLOT_PREPARE_TIMEOUT_MS } from '../shared/slot-prepare-client.js';
import '../shared/slot-prepare-options.js';
import type { SlotPrepareOptionsChangeDetail } from '../shared/slot-prepare-options.js';

const SLOT_ACTION_TIMEOUT = 5 * 60_000;

@customElement('slot-actions-panel')
export class SlotActionsPanel extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ attribute: 'slot-id' }) slotId = '';
  /** Hide the output panel when an embedding view (e.g. slot-view) renders its own. */
  @property({ type: Boolean }) hideOutput = false;
  /**
   * Override the slot status snapshot. When set, the panel skips its
   * `fleet.status` fetch and uses this directly. Used by the dev harness to
   * showcase visibility logic across lifecycle states without hitting the
   * gateway. Live event subscriptions still apply.
   */
  @property({ attribute: false }) slotOverride: SlotStatus | null = null;

  @state() private _slot: SlotStatus | null = null;
  @state() private _slotActions: SlotActionSummary[] = [];
  @state() private _runningSlotActionIds: string[] = [];
  @state() private _output: string[] = [];
  @state() private _running = false;
  @state() private _requestId = '';
  @state() private _exitCode: number | null = null;
  @state() private _pendingConfirm: string | null = null;
  @state() private _copiedSlotActionId = '';
  /** Which action ID was the user's most recent click — used to spin only that button. */
  @state() private _activeActionId = '';
  /** Captured from a safe-mode refresh that aborted; gates the inline Force Refresh button. */
  @state() private _lastRefreshReason: 'dirty' | 'stale' | undefined = undefined;
  /** Branch the "switch branch (warm)" form targets. Empty until the user types
   * or the form is opened (prefilled from the slot's current branch). */
  @state() private _switchBranch = '';
  /** Prepare profile for the warm branch switch — defaults to the cheapest
   * (`attach`: checkout-only, no rebuild, devserver stays warm). */
  @state() private _switchProfile = 'attach';
  @state() private _switchStrictProfile = true;
  @state() private _switchForcePrepare = false;
  /** Whether the switch-branch form is expanded. */
  @state() private _switchOpen = false;


  private readonly _confirmTimer = new ConfirmActionTimer({
    pendingConfirm: () => this._pendingConfirm,
    setPendingConfirm: (pending) => {
      this._pendingConfirm = pending;
    },
  });
  private readonly _copyFeedback = new CopyFeedbackTimer({
    copiedKey: () => this._copiedSlotActionId,
    setCopiedKey: (key) => {
      this._copiedSlotActionId = key;
    },
  });
  private _unsubs: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    if (!this.slotId) return;
    void this._loadSlot();
    void this._loadActions();

    this._unsubs.push(
      gateway.subscribe(Events.SLOT_CHANGED, (payload: unknown) => {
        const s = payload as SlotStatus;
        if (s.slot === this.slotId) this._slot = s;
      }),
    );

    // Strict requestId match. The UI pre-allocates the requestId in
    // `_runAction` and sets `_requestId` BEFORE issuing the request, so
    // the server's emit window is fully covered by a known id. Loose
    // acceptance (matching by `_running` alone) was prone to absorbing
    // unrelated streams from other actions firing on the same WS.
    this._unsubs.push(
      gateway.subscribe(Events.SCRIPT_OUTPUT, (payload: unknown) => {
        const data = payload as ScriptOutput;
        if (!this._requestId || data.requestId !== this._requestId) return;
        this._output = [...this._output, data.data];
      }),
    );

    this._unsubs.push(
      gateway.subscribe(Events.SCRIPT_COMPLETE, (payload: unknown) => {
        const data = payload as ScriptComplete;
        if (!this._requestId || data.requestId !== this._requestId) return;
        this._running = false;
        this._exitCode = data.exitCode;
        this._activeActionId = '';
        void this._loadSlot();
      }),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    this._confirmTimer.clear();
    this._copyFeedback.clear();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('slotOverride') && this.slotOverride) {
      this._slot = this.slotOverride;
    }
    if (changed.has('slotId') && this.slotId) {
      void this._loadSlot();
      void this._loadActions();
    }
  }

  private async _loadSlot() {
    if (this.slotOverride) {
      this._slot = this.slotOverride;
      return;
    }
    try {
      const fleet = await gateway.request<{ fleet: { slots: SlotStatus[] } }>(
        Methods.FLEET_STATUS,
        {},
      );
      this._slot = fleet.fleet.slots.find((s) => s.slot === this.slotId) ?? null;
    } catch (err) {
      console.warn('[slot-actions-panel] fleet.status failed:', err);
    }
  }

  private async _loadActions() {
    try {
      const result = await gateway.request<SlotActionListResult>(Methods.SLOT_ACTION_LIST, {
        slotId: this.slotId,
      });
      this._slotActions = result.actions ?? [];
    } catch (err) {
      // Project may not declare any slot_actions — that's not an error.
      this._slotActions = [];
      void err;
    }
  }

  // ── Built-in actions ──

  private async _runAction<T extends { requestId?: string }>(
    method: string,
    params: Record<string, unknown>,
    actionId: string,
    timeoutMs = SLOT_ACTION_TIMEOUT,
  ): Promise<T | null> {
    // Pre-allocate the requestId UI-side so the strict event matchers in
    // connectedCallback know the key BEFORE any script.output frames arrive.
    // Methods that recognise `requestId` in their params (slot.refresh)
    // honour it; methods that don't simply ignore the extra field.
    const reqId = `${actionId}-${crypto.randomUUID()}`;
    this._output = [];
    this._running = true;
    this._exitCode = null;
    this._requestId = reqId;
    this._activeActionId = actionId;
    this._lastRefreshReason = undefined;
    try {
      const result = await gateway.request<T>(method, { ...params, requestId: reqId }, timeoutMs);
      // Methods that short-circuit before emitting script.complete (e.g.
      // safe-mode refresh on dirty tree, or any synchronous slot action)
      // leave `_running` true at this point. Their response itself is the
      // completion signal — flip the spinner off here.
      if (this._running) {
        this._running = false;
        this._exitCode = 0;
        this._activeActionId = '';
        void this._loadSlot();
      }
      return result;
    } catch (err) {
      this._running = false;
      this._activeActionId = '';
      this._output = [`ERROR: ${err instanceof Error ? err.message : 'Action failed'}`];
      return null;
    }
  }

  private _confirm(actionId: string, fn: () => void) {
    this._confirmTimer.confirm(actionId, fn);
  }

  private _prepare = () =>
    this._confirm('prepare', () =>
      this._runAction(
        Methods.SLOT_PREPARE,
        { slotId: this.slotId },
        'prepare',
        SLOT_PREPARE_TIMEOUT_MS,
      ),
    );
  private _release = (keepWarm: boolean) =>
    this._confirm(keepWarm ? 'release-warm' : 'release', () =>
      this._runAction(
        Methods.SLOT_RELEASE,
        { slotId: this.slotId, keepWarm },
        keepWarm ? 'release-warm' : 'release',
      ),
    );
  private _recycle = (forceReset = false) =>
    this._confirm(forceReset ? 'force-recycle' : 'recycle', () =>
      this._runAction(Methods.SLOT_RECYCLE, { slotId: this.slotId, forceReset }, 'recycle'),
    );
  private _refresh = (force = false) =>
    this._confirm(force ? 'refresh-force' : 'refresh', async () => {
      const result = await this._runAction<SlotRefreshResult>(
        Methods.SLOT_REFRESH,
        { slotId: this.slotId, mode: force ? 'force' : 'safe' },
        force ? 'refresh-force' : 'refresh',
      );
      if (result && !result.refreshed) {
        this._lastRefreshReason = result.reason;
      }
    });
  private _cleanup = () =>
    this._confirm('cleanup', () =>
      this._runAction(Methods.SLOT_CLEANUP, { slotId: this.slotId, reason: 'manual' }, 'cleanup'),
    );

  private _toggleSwitchForm = () => {
    this._switchOpen = !this._switchOpen;
    // Prefill the branch input from the slot's current branch on first open.
    if (this._switchOpen && !this._switchBranch) {
      this._switchBranch = this._slot?.branch ?? '';
    }
  };

  // Warm branch switch: re-uses slot.prepare with a chosen branch + the cheap
  // `attach` profile (checkout-only, no merge-main, no rebuild, devserver stays
  // up so Metro/webpack hot-reload). Lets a limited-slot node serve several
  // branches in turn without a full prepare.
  private _runBranchSwitch = () => {
    const branch = this._switchBranch.trim();
    if (!branch) return;
    this._confirm('switch-branch', () =>
      this._runAction(
        Methods.SLOT_PREPARE,
        {
          slotId: this.slotId,
          branch,
          prepareProfile: this._switchProfile || 'attach',
          strictProfile: this._switchStrictProfile,
        },
        'switch-branch',
        SLOT_PREPARE_TIMEOUT_MS,
      ),
    );
  };

  // ── Configured project.json slot_actions ──

  private _runConfiguredAction(actionId: string) {
    const action = this._slotActions.find((a) => a.id === actionId);
    if (!action || this._runningSlotActionIds.includes(actionId)) return;
    const exec = () => {
      void this._executeConfigured(action);
    };
    if (action.confirm) this._confirm(`slot-action:${actionId}`, exec);
    else exec();
  }

  private async _executeConfigured(action: SlotActionSummary) {
    this._runningSlotActionIds = [...this._runningSlotActionIds, action.id];
    // Clear stale refresh reason so the Force Refresh button doesn't linger
    // alongside an unrelated configured action's output. _runAction clears
    // this for built-in actions; configured actions take a separate path.
    this._lastRefreshReason = undefined;
    try {
      const result = await gateway.request<SlotActionRunResult>(
        Methods.SLOT_ACTION_RUN,
        { slotId: this.slotId, actionId: action.id },
        SLOT_ACTION_TIMEOUT,
      );
      if (action.mode === 'copy' && result.command) {
        await this._copyText(result.command);
        this._output = [`Copied: ${action.label}`];
        this._copyFeedback.show(action.id);
      }
      if (!result.ok) {
        this._output = [`ERROR: ${result.detail ?? `Slot action ${action.label} failed`}`];
      }
      const refresh = result.refresh ?? action.refresh;
      if (refresh.includes('fleet')) {
        await gateway.request(Methods.FLEET_REFRESH, {});
      }
      if (refresh.includes('fleet') || refresh.includes('slot')) {
        void this._loadSlot();
      }
    } catch (err) {
      this._output = [
        `ERROR: ${err instanceof Error ? err.message : `Slot action ${action.label} failed`}`,
      ];
    } finally {
      this._runningSlotActionIds = this._runningSlotActionIds.filter((id) => id !== action.id);
    }
  }

  private async _copyText(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  private _showCleanup(): boolean {
    const slot = this._slot;
    if (!slot) return false;
    if (slot.lifecycle === 'ready' || slot.lifecycle === 'manual') {
      const r = slot.resourceRollup;
      return r === 'coherent' || r === 'partial' || r === 'stale';
    }
    if (slot.lifecycle === 'held') return slot.resourceRollup === 'stale';
    return false;
  }

  // Per-action visibility & reason. The lifecycle dictates which set of
  // operations make sense — a busy slot must not get Prepare/Refresh
  // (would interrupt the worker mid-flight), an idle slot must not get
  // Release (nothing to release). Returning `available: false` removes
  // the button entirely; `disabled` keeps it visible but greyed out so
  // the user can read the reason. The `_running` global guard is layered
  // on top in _isDisabled().
  private _actionAvailability(
    id: 'prepare' | 'release' | 'release-warm' | 'refresh' | 'recycle' | 'cleanup',
  ): { available: boolean; reason?: string } {
    const slot = this._slot;
    if (!slot) return { available: false, reason: 'Loading slot status...' };
    const lc = slot.lifecycle;
    const busy = lc === 'busy';
    const held = lc === 'held';
    const hasWork = !!slot.currentRunId || busy || held;
    if (lc === 'disabled') return { available: false, reason: 'Slot is disabled' };

    switch (id) {
      case 'prepare':
        if (busy)
          return {
            available: false,
            reason: 'Slot is working — release first to avoid interrupting the worker',
          };
        if (held)
          return {
            available: false,
            reason: `Slot is held in ${slot.phase ?? 'watch'} — release to free it first`,
          };
        return { available: true };

      case 'refresh':
        if (busy)
          return {
            available: false,
            reason: "Slot is working — refresh would discard worker's branch state",
          };
        if (held) return { available: false, reason: `Slot is held in ${slot.phase ?? 'watch'}` };
        return { available: true };

      case 'release':
      case 'release-warm':
        if (!hasWork)
          return { available: false, reason: 'Nothing to release — slot is already idle' };
        return { available: true };

      case 'recycle':
        if (lc === 'ready' && !hasWork)
          return { available: false, reason: 'Already idle — use Refresh or Prepare instead' };
        return { available: true };

      case 'cleanup':
        return this._showCleanup()
          ? { available: true }
          : { available: false, reason: 'No lingering resources to clean' };
    }
  }

  private _isDisabled(id: string): boolean {
    if (this._running) return true;
    const a = this._actionAvailability(id as Parameters<typeof this._actionAvailability>[0]);
    return !a.available;
  }

  private _btnClass(id: string, base = ''): string {
    return `sap-btn ${this._pendingConfirm === id ? 'confirming' : base}`.trim();
  }

  private _label(id: string, normal: string, pending: string): string {
    return this._pendingConfirm === id ? pending : normal;
  }

  private _renderStatusBanner() {
    const slot = this._slot;
    if (!slot) return html`<div class="sap-status sap-status-loading">Loading slot status...</div>`;
    const lc = slot.lifecycle;
    const phase = slot.phase ? ` (${slot.phase})` : '';
    const lcColor =
      lc === 'busy'
        ? colors.statusWarn
        : lc === 'held'
          ? colors.accent
          : lc === 'disabled'
            ? colors.textMuted
            : colors.statusOk;
    const branch = slot.branch ?? '';
    const project = slot.project ?? '';
    const machine = slot.machine ?? '';
    const runner = slot.runner ?? '';
    const hasRun = !!slot.currentRunId;

    return html`
      <div class="sap-status">
        <div class="sap-status-row">
          <span class="sap-status-label">Status</span>
          <span
            class="sap-status-pill"
            style="background:${lcColor}22; color:${lcColor}; border-color:${lcColor}55"
          >
            ${lc}${phase}
          </span>
          <span class="sap-status-meta">agent: ${slot.agent ?? '-'}</span>
          ${slot.warm ? html`<span class="sap-status-meta">warm</span>` : ''}
        </div>
        <div class="sap-status-row">
          <span class="sap-status-label">Slot</span>
          <span>${this.slotId}</span>
          ${machine ? html`<span class="sap-status-meta">${machine}</span>` : ''}
          ${project ? html`<span class="sap-status-meta">${project}</span>` : ''}
        </div>
        ${branch
          ? html`
              <div class="sap-status-row">
                <span class="sap-status-label">Branch</span>
                <span>${branch}</span>
              </div>
            `
          : ''}
        ${hasRun
          ? html`
              <div class="sap-status-row">
                <span class="sap-status-label">Run</span>
                <span>${slot.currentRunId?.slice(0, 8)}</span>
                ${slot.currentFlowType
                  ? html`<span class="sap-status-meta">${slot.currentFlowType}</span>`
                  : ''}
                ${runner
                  ? html`<span class="sap-status-meta"
                      >${runner}${slot.model ? `/${slot.model}` : ''}</span
                    >`
                  : ''}
                ${slot.currentTicketOrPr
                  ? html`<span class="sap-status-meta">${slot.currentTicketOrPr}</span>`
                  : ''}
              </div>
            `
          : ''}
      </div>
    `;
  }

  // Action catalog. Each entry pairs the button with a one-line "what it
  // does" so users don't need to ask. Order matters — listed top-to-bottom
  // in the modal.
  private _actionCatalog(): Array<{
    id: 'prepare' | 'release' | 'release-warm' | 'refresh' | 'recycle' | 'cleanup';
    label: string;
    desc: string;
    style: '' | 'primary' | 'danger';
    confirmLabel: string;
    onClick: () => void;
  }> {
    return [
      {
        id: 'refresh',
        label: 'Refresh main',
        style: 'primary',
        desc: 'fetch latest main, then reset main to origin. No deps install. Idle slot ends up dispatch-ready on latest.',
        confirmLabel: 'Confirm Refresh?',
        onClick: () => this._refresh(false),
      },
      {
        id: 'prepare',
        label: 'Prepare',
        style: '',
        desc: 'Full prepare: deps install, preflight, dev-server, health check.',
        confirmLabel: 'Confirm Prepare?',
        onClick: () => this._prepare(),
      },
      {
        id: 'release',
        label: 'Release',
        style: '',
        desc: 'Stop work, save artifacts, free the slot.',
        confirmLabel: 'Confirm Release?',
        onClick: () => this._release(false),
      },
      {
        id: 'release-warm',
        label: 'Release --keep-warm',
        style: '',
        desc: 'Release then auto re-prepare so the next dispatch starts warm.',
        confirmLabel: 'Confirm?',
        onClick: () => this._release(true),
      },
      {
        id: 'recycle',
        label: 'Recycle',
        style: 'danger',
        desc: 'Release + immediate re-prepare. Use to abort a stuck or wrong run.',
        confirmLabel: 'Confirm Recycle?',
        onClick: () => this._recycle(),
      },
      {
        id: 'cleanup',
        label: 'Clean up resources',
        style: '',
        desc: 'Shut down lingering simulator/dev-server/browser without recycling the slot.',
        confirmLabel: 'Confirm Clean up?',
        onClick: () => this._cleanup(),
      },
    ];
  }

  private _renderSwitchBranchForm() {
    // Only meaningful when the slot can be prepared (idle/ready). A busy/held
    // slot is gated out exactly like the Prepare action.
    if (!this._actionAvailability('prepare').available) return nothing;
    const running = this._running && this._activeActionId === 'switch-branch';
    const confirming = this._pendingConfirm === 'switch-branch';
    return html`
      <div class="sap-section-label">
        <button class="sap-switch-toggle" @click=${this._toggleSwitchForm}>
          ${this._switchOpen ? '▾' : '▸'} Switch branch (warm)
        </button>
      </div>
      ${this._switchOpen
        ? html`
            <div class="sap-switch-form">
              <div class="sap-switch-row">
                <input
                  class="sap-switch-input"
                  .value=${this._switchBranch}
                  placeholder="branch to check out"
                  ?disabled=${this._running}
                  @input=${(e: Event) =>
                    (this._switchBranch = (e.target as HTMLInputElement).value)}
                />
                <button
                  class="sap-btn ${confirming ? 'confirming' : ''} ${running ? 'running' : ''}"
                  ?disabled=${this._running || !this._switchBranch.trim()}
                  @click=${this._runBranchSwitch}
                >
                  ${running ? 'Switching…' : confirming ? 'Confirm switch?' : 'Switch branch'}
                </button>
              </div>
              <slot-prepare-options
                .project=${this._slot?.project ?? ''}
                .prepareProfile=${this._switchProfile}
                .strictProfile=${this._switchStrictProfile}
                .forcePrepare=${this._switchForcePrepare}
                .runBranch=${this._switchBranch}
                .slotBranch=${this._slot?.branch ?? ''}
                .slotHealth=${this._slot?.health ?? null}
                .disabled=${this._running}
                compact
                @prepare-options-change=${(event: CustomEvent<SlotPrepareOptionsChangeDetail>) => {
                  this._switchProfile = event.detail.prepareProfile;
                  this._switchStrictProfile = event.detail.strictProfile;
                  this._switchForcePrepare = event.detail.forcePrepare;
                }}
              ></slot-prepare-options>
              ${this._slot?.currentRunId
                ? html`<div class="sap-switch-warn">
                    ⚠ Slot is bound to run ${this._slot.currentRunId.slice(0, 8)} — switching
                    changes its checked-out branch.
                  </div>`
                : nothing}
              <div class="sap-action-desc">
                Uses the chosen profile in strict mode — attach will not silently escalate to a
                heavier profile when preconditions fail. Dev server stays warm and hot-reloads.
              </div>
            </div>
          `
        : nothing}
    `;
  }

  override render() {
    const headerActions = this._slotActions.filter((a) => a.placement.includes('slot-header'));
    const catalog = this._actionCatalog();
    const available = catalog.filter((a) => this._actionAvailability(a.id).available);
    const unavailable = catalog
      .map((a) => ({ ...a, reason: this._actionAvailability(a.id).reason ?? '' }))
      .filter((a) => a.reason);

    return html`
      <style>
        slot-actions-panel {
          display: block;
        }
        slot-actions-panel .sap-status {
          padding: ${spacing.sm} ${spacing.md};
          border-bottom: 1px solid #2a2a44;
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
        }
        slot-actions-panel .sap-status-loading {
          color: ${colors.textMuted};
        }
        slot-actions-panel .sap-status-row {
          display: flex;
          gap: ${spacing.sm};
          align-items: center;
          flex-wrap: wrap;
        }
        slot-actions-panel .sap-status-label {
          color: ${colors.textMuted};
          width: 56px;
          text-transform: uppercase;
          font-size: 10px;
          letter-spacing: 0.04em;
        }
        slot-actions-panel .sap-status-pill {
          padding: 1px 8px;
          border-radius: ${radii.sm};
          border: 1px solid;
          text-transform: uppercase;
          font-weight: 600;
          font-size: 10px;
          letter-spacing: 0.04em;
        }
        slot-actions-panel .sap-status-meta {
          color: ${colors.textMuted};
          font-size: 11px;
        }
        slot-actions-panel .sap-section-label {
          padding: ${spacing.sm} ${spacing.md} 4px;
          color: ${colors.textMuted};
          font-family: ${fonts.mono};
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        slot-actions-panel .sap-action-list {
          display: grid;
          grid-template-columns: minmax(180px, max-content) 1fr;
          gap: 6px ${spacing.md};
          padding: 4px ${spacing.md} ${spacing.sm};
          align-items: center;
        }
        slot-actions-panel .sap-action-desc {
          color: ${colors.textMuted};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          line-height: 1.4;
        }
        slot-actions-panel .sap-unavailable {
          padding: 4px ${spacing.md} ${spacing.sm};
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        slot-actions-panel .sap-unavailable-row {
          color: ${colors.textMuted};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          line-height: 1.4;
        }
        slot-actions-panel .sap-unavailable-row strong {
          color: ${colors.textPrimary}99;
          font-weight: 600;
          margin-right: 6px;
        }
        slot-actions-panel .sap-btn {
          background: ${colors.bgCard};
          color: ${colors.textPrimary};
          border: 1px solid #2a2a44;
          border-radius: ${radii.sm};
          padding: 6px 10px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          cursor: pointer;
          transition: background 0.1s;
          text-align: left;
          width: 100%;
        }
        slot-actions-panel .sap-btn:hover:not(:disabled) {
          background: ${colors.bgSurface};
          border-color: ${colors.accent}55;
        }
        slot-actions-panel .sap-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        slot-actions-panel .sap-btn.primary {
          border-color: ${colors.accent}88;
          color: ${colors.accent};
        }
        slot-actions-panel .sap-btn.danger {
          border-color: ${colors.statusFail}66;
          color: ${colors.statusFail};
        }
        slot-actions-panel .sap-btn.confirming {
          background: ${colors.statusWarn}22;
          border-color: ${colors.statusWarn};
          color: ${colors.statusWarn};
        }
        slot-actions-panel .sap-btn.running {
          background: ${colors.accent}1a;
          border-color: ${colors.accent};
          color: ${colors.accent};
          animation: sap-btn-pulse 1.2s ease-in-out infinite;
        }
        @keyframes sap-btn-pulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.55;
          }
        }
        slot-actions-panel .sap-custom-row {
          display: flex;
          flex-wrap: wrap;
          gap: ${spacing.xs};
          padding: 4px ${spacing.md} ${spacing.sm};
        }
        slot-actions-panel .sap-custom-row .sap-btn {
          width: auto;
        }
        slot-actions-panel .sap-switch-toggle {
          background: none;
          border: none;
          padding: 0;
          color: ${colors.textMuted};
          font-family: ${fonts.mono};
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          cursor: pointer;
        }
        slot-actions-panel .sap-switch-toggle:hover {
          color: ${colors.accent};
        }
        slot-actions-panel .sap-switch-form {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 0 ${spacing.md} ${spacing.sm};
        }
        slot-actions-panel .sap-switch-row {
          display: flex;
          gap: ${spacing.xs};
          align-items: center;
          flex-wrap: wrap;
        }
        slot-actions-panel .sap-switch-input,
        slot-actions-panel .sap-switch-select {
          background: ${colors.bgCard};
          color: ${colors.textPrimary};
          border: 1px solid #2a2a44;
          border-radius: ${radii.sm};
          padding: 6px 8px;
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
        }
        slot-actions-panel .sap-switch-input {
          flex: 1 1 160px;
          min-width: 120px;
        }
        slot-actions-panel .sap-switch-row .sap-btn {
          width: auto;
          flex: 0 0 auto;
        }
        slot-actions-panel .sap-switch-warn {
          color: ${colors.statusWarn};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          line-height: 1.4;
        }
        slot-actions-panel .sap-output {
          margin: ${spacing.sm} ${spacing.md};
          padding: ${spacing.sm};
          background: #000;
          color: ${colors.textPrimary};
          border-radius: ${radii.sm};
          font-family: ${fonts.mono};
          font-size: ${fonts.sizeXs};
          white-space: pre-wrap;
          max-height: 320px;
          overflow-y: auto;
          line-height: 1.4;
        }
        slot-actions-panel .sap-exit-badge {
          display: inline-block;
          margin-top: ${spacing.xs};
          padding: 2px 8px;
          border-radius: ${radii.sm};
          font-weight: 600;
          font-size: ${fonts.sizeXs};
        }
      </style>

      ${this._renderStatusBanner()} ${this._renderSwitchBranchForm()}
      ${available.length > 0
        ? html`
            <div class="sap-section-label">Available actions</div>
            <div class="sap-action-list">
              ${available.map((a) => {
                const isActive = this._running && this._activeActionId === a.id;
                const label = isActive ? `${a.label}…` : this._label(a.id, a.label, a.confirmLabel);
                return html`
                  <button
                    class="${this._btnClass(a.id, a.style)} ${isActive ? 'running' : ''}"
                    ?disabled=${this._isDisabled(a.id)}
                    @click=${a.onClick}
                  >
                    ${label}
                  </button>
                  <div class="sap-action-desc">${a.desc}</div>
                `;
              })}
            </div>
          `
        : nothing}
      ${unavailable.length > 0
        ? html`
            <div class="sap-section-label">Not available right now</div>
            <div class="sap-unavailable">
              ${unavailable.map(
                (a) => html`
                  <div class="sap-unavailable-row"><strong>${a.label}</strong>${a.reason}</div>
                `,
              )}
            </div>
          `
        : nothing}
      ${headerActions.length > 0
        ? html`
            <div class="sap-section-label">Project actions</div>
            <div class="sap-custom-row">
              ${headerActions.map(
                (action) => html`
                  <button
                    class=${`sap-btn ${this._copiedSlotActionId === action.id ? 'confirming' : (action.style ?? '')}`}
                    ?disabled=${this._runningSlotActionIds.includes(action.id) || this._running}
                    title=${action.description ?? ''}
                    @click=${() => this._runConfiguredAction(action.id)}
                  >
                    ${this._copiedSlotActionId === action.id ? 'Copied!' : action.label}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
      ${!this.hideOutput && (this._running || this._output.length > 0)
        ? html`
            <div class="sap-output">
              ${this._output.map((line) => html`<div>${line}</div>`)}
              ${this._running
                ? html`<div style="color:${colors.accent}">
                    ${this._output.length === 0 ? 'Starting...' : 'Running...'}
                  </div>`
                : nothing}
              ${!this._running && this._output.some((l) => l.includes('UNMERGED_WORK:'))
                ? html`
                    <button
                      class="sap-btn danger"
                      style="margin-top:8px"
                      @click=${() => this._recycle(true)}
                    >
                      Force Reset
                    </button>
                  `
                : nothing}
              ${!this._running &&
              (this._lastRefreshReason === 'dirty' || this._lastRefreshReason === 'stale')
                ? html`
                    <button
                      class=${this._btnClass('refresh-force', 'danger')}
                      style="margin-top:8px"
                      title="Discard local changes and reset to default @ origin"
                      @click=${() => this._refresh(true)}
                    >
                      ${this._label('refresh-force', 'Force Refresh', 'Confirm Force Refresh?')}
                    </button>
                  `
                : nothing}
              ${this._exitCode !== null
                ? html`
                    <div
                      class="sap-exit-badge"
                      style="background:${this._exitCode === 0
                        ? colors.statusOk + '22'
                        : colors.statusFail + '22'};
                     color:${this._exitCode === 0 ? colors.statusOk : colors.statusFail}"
                    >
                      Exit ${this._exitCode}
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-actions-panel': SlotActionsPanel;
  }
}
