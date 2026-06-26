import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { canActivateRunOnSlot, Methods, type Run, type RunListResult } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  type PrepareProfileOption,
  projectPrepareProfiles,
} from '../dispatch/dispatch-wizard-draft.js';
import { requestProjectConfigs } from '../dispatch/dispatch-wizard-loaders.js';
import '../shared/prepare-progress-panel.js';
import type { PrepareProgressState } from '../shared/prepare-progress-model.js';
import {
  runSlotPrepare,
  shouldBindOnlyForLoadRun,
} from '../shared/slot-prepare-client.js';
import {
  activeSlotPrepare,
  subscribeSlotPrepareTracker,
} from '../shared/slot-prepare-tracker.js';
import { formatCreatedAt, routeForRun, runStatusColor } from '../runs/run-utils.js';

const DEFAULT_LIMIT = 200;

@customElement('slot-load-run-modal')
export class SlotLoadRunModal extends LitElement {
  @property({ attribute: 'slot-id' }) slotId = '';
  /** Slot's project — the loader only lists runs from this project, because a
   * slot can only check out branches for its own repo (a mobile slot can't run
   * an extension branch). */
  @property() project = '';
  /** Slot's current checked-out branch — enables bind-only when it matches the run. */
  @property({ attribute: 'slot-branch' }) slotBranch = '';
  @property({ type: Boolean }) open = false;
  /** Dev harness escape hatch: when provided, no gateway call is made. */
  @property({ attribute: false }) runsOverride?: Run[];

  @state() private _loading = false;
  @state() private _error = '';
  @state() private _runs: Run[] = [];
  @state() private _totalCount = 0;
  @state() private _search = '';
  @state() private _statusFilter = '';
  @state() private _pendingConfirm = '';
  /** In-flight + error state for a "Load onto slot" action, shown inline (no
   * browser alert) so a failed load is explained right in the modal. */
  @state() private _actionBusy = false;
  @state() private _actionError = '';
  @state() private _prepareProfile = 'attach';
  @state() private _prepareProfiles: PrepareProfileOption[] = [];
  @state() private _prepareState: PrepareProgressState | null = null;
  private _loadToken = Symbol('slot-load-run-load');
  private _confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private _profilesLoadedFor = '';
  private _unsubPrepare?: () => void;

  static override styles = css`
    .slrm-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1100;
      background: rgba(0, 0, 0, 0.62);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 56px 16px 16px;
    }
    .slrm-panel {
      width: min(1280px, calc(100vw - 32px));
      max-height: calc(100vh - 80px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.45);
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .slrm-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid #2a2a44;
    }
    .slrm-title {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
    }
    .slrm-subtitle {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      margin-top: 2px;
    }
    .slrm-close,
    .slrm-retry,
    .slrm-link {
      border: 1px solid #2a2a44;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 4px 9px;
      cursor: pointer;
      text-decoration: none;
    }
    .slrm-close:hover,
    .slrm-retry:hover,
    .slrm-link:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .slrm-body {
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.md)};
    }
    .slrm-note {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      line-height: 1.5;
    }
    .slrm-filters {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.sm)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      align-items: center;
    }
    .slrm-input,
    .slrm-select {
      background: ${unsafeCSS(colors.bgCard)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 5px 8px;
    }
    .slrm-input {
      flex: 1 1 220px;
      min-width: 0;
    }
    .slrm-input:focus,
    .slrm-select:focus {
      outline: none;
      border-color: ${unsafeCSS(colors.accent)};
    }
    .slrm-result-count {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
      margin-left: auto;
    }
    .slrm-profile-row {
      display: flex;
      flex-wrap: wrap;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .slrm-profile-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
    }
    .slrm-profile-hint {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
      line-height: 1.45;
      flex: 1 1 220px;
    }
    .slrm-progress {
      margin-bottom: ${unsafeCSS(spacing.md)};
    }
    .slrm-state {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .slrm-state.error {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .slrm-list {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.xs)};
    }
    .slrm-row {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      display: grid;
      grid-template-columns: 84px 96px minmax(0, 1fr) auto;
      gap: ${unsafeCSS(spacing.sm)};
      align-items: center;
    }
    .slrm-cell {
      min-width: 0;
    }
    .slrm-compact-cell {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slrm-id {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 700;
      font-size: 11px;
    }
    .slrm-status {
      width: fit-content;
      padding: 2px 7px;
      border-radius: ${unsafeCSS(radii.sm)};
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .slrm-run-info {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .slrm-run-title {
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slrm-run-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
      line-height: 1.35;
    }
    .slrm-meta-strong {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .slrm-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      align-items: center;
    }
    .slrm-load {
      border: 1px solid ${unsafeCSS(colors.accent)}44;
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
      border-radius: ${unsafeCSS(radii.sm)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      padding: 4px 9px;
      cursor: pointer;
      white-space: nowrap;
    }
    .slrm-load:hover {
      background: ${unsafeCSS(colors.accent)}33;
    }
    .slrm-load.confirm {
      border-color: ${unsafeCSS(colors.statusWarn)};
      background: ${unsafeCSS(colors.statusWarn)}22;
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .slrm-load[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    @media (max-width: 860px) {
      .slrm-row {
        grid-template-columns: 1fr;
      }
      .slrm-actions {
        justify-content: flex-start;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
    this._unsubPrepare = subscribeSlotPrepareTracker(() => {
      this._prepareState = this.slotId ? activeSlotPrepare(this.slotId) : null;
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onKeydown);
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    this._unsubPrepare?.();
    this._unsubPrepare = undefined;
  }

  override updated(changed: Map<string, unknown>) {
    if ((changed.has('open') || changed.has('runsOverride')) && this.open) {
      void this._load();
    }
    if (changed.has('project') && this.project) {
      void this._loadPrepareProfiles();
    }
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (this.open && event.key === 'Escape') this._close();
  };

  private _close() {
    this._pendingConfirm = '';
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async _loadPrepareProfiles() {
    if (!this.project || this._profilesLoadedFor === this.project) return;
    this._profilesLoadedFor = this.project;
    try {
      this._prepareProfiles = projectPrepareProfiles(await requestProjectConfigs(), this.project);
      const names = this._prepareProfiles.map((p) => p.name);
      if (names.length > 0 && !names.includes(this._prepareProfile)) {
        this._prepareProfile = names.includes('attach')
          ? 'attach'
          : (this._prepareProfiles.find((p) => p.isDefault)?.name ?? names[0]!);
      }
    } catch (err) {
      console.warn('[slot-load-run-modal] prepare profiles load failed:', err);
    }
  }

  private _bindOnlyHint(run: Run): string {
    if (!shouldBindOnlyForLoadRun(run.branch, this.slotBranch)) return '';
    return `Slot is already on ${run.branch} — load will bind only (no checkout).`;
  }

  private async _load() {
    const token = Symbol('slot-load-run-load');
    this._loadToken = token;
    this._error = '';
    // Reset filters + any half-armed confirm/error so each open starts clean.
    this._search = '';
    this._statusFilter = '';
    this._pendingConfirm = '';
    this._actionError = '';

    if (this.runsOverride) {
      this._runs = this.runsOverride;
      this._totalCount = this.runsOverride.length;
      this._loading = false;
      return;
    }

    this._loading = true;
    try {
      // Scope to the slot's project — a slot can only check out branches for its
      // own repo, so loading another project's run could never work.
      const result = await gateway.request<RunListResult>(Methods.RUN_LIST, {
        limit: DEFAULT_LIMIT,
        ...(this.project ? { project: this.project } : {}),
      });
      if (token !== this._loadToken) return;
      this._runs = result.runs;
      this._totalCount = result.totalCount;
    } catch (error) {
      if (token !== this._loadToken) return;
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === this._loadToken) this._loading = false;
    }
  }

  private _statuses(): string[] {
    return [...new Set(this._runs.map((run) => run.status))].sort((a, b) => a.localeCompare(b));
  }

  private _filtered(): Run[] {
    const query = this._search.trim().toLowerCase();
    return this._runs.filter((run) => {
      // Defensive: the fetch is already project-scoped, but guard the override
      // path (dev harness) and any stale data too.
      if (this.project && run.project !== this.project) return false;
      if (this._statusFilter && run.status !== this._statusFilter) return false;
      if (query) {
        const haystack = [run.ticketOrPr, run.summary ?? '', run.branch ?? '']
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  private _short(id: string): string {
    return id.slice(0, 8);
  }

  private _loadReason(run: Run): string {
    if (!run.branch) return 'no-branch';
    if (!canActivateRunOnSlot(run.status)) return 'mid-pipeline';
    return '';
  }

  private async _onLoadClick(run: Run) {
    const reason = this._loadReason(run);
    if (reason || this._actionBusy) return;
    if (this._pendingConfirm === run.id) {
      if (this._confirmTimer) clearTimeout(this._confirmTimer);
      this._actionError = '';
      this._actionBusy = true;
      // Keep _pendingConfirm set during the await so the row shows "Loading…".
      try {
        const bindOnly = shouldBindOnlyForLoadRun(run.branch, this.slotBranch);
        await runSlotPrepare({
          slotId: this.slotId,
          branch: run.branch!,
          prepareProfile: this._prepareProfile || 'attach',
          strictProfile: true,
          bindOnly,
          bindRunId: run.id,
          runId: run.id,
          rebind: true,
          label: bindOnly
            ? `Binding run ${run.id.slice(0, 8)} on ${this.slotId}`
            : `Preparing ${this.slotId} for run ${run.id.slice(0, 8)}`,
        });
        window.location.hash = `#slot/${this.slotId}`;
        this._close();
      } catch (err) {
        // Surface inline (no browser alert); keep the modal open to retry.
        this._actionError = `Load failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        this._actionBusy = false;
        this._pendingConfirm = '';
      }
      return;
    }
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    this._pendingConfirm = run.id;
    this._confirmTimer = setTimeout(() => {
      this._pendingConfirm = '';
    }, 3000);
  }

  private _renderRow(run: Run) {
    const statusColor = runStatusColor(run.status);
    const reason = this._loadReason(run);
    const loadable = !reason;
    const confirming = this._pendingConfirm === run.id;
    const disabledTitle =
      reason === 'no-branch'
        ? 'Run has no branch to check out'
        : reason === 'mid-pipeline'
          ? 'Run is mid-pipeline; only terminal or blocked runs can be loaded'
          : '';
    return html`
      <div class="slrm-row" data-run-id=${run.id}>
        <span class="slrm-cell slrm-compact-cell slrm-id">${this._short(run.id)}</span>
        <span class="slrm-cell slrm-compact-cell">
          <span class="slrm-status" style="background:${statusColor}22;color:${statusColor}"
            >${run.status}</span
          >
        </span>
        <span class="slrm-run-info">
          <span class="slrm-run-title" title=${run.summary ?? run.ticketOrPr}
            >${run.flowType} · ${run.summary ?? run.ticketOrPr}</span
          >
          <span class="slrm-run-meta">
            <span class="slrm-meta-strong">${run.ticketOrPr}</span>
            <span>${run.project}</span>
            <span>${run.branch ?? 'no branch'}</span>
            <span>${run.metrics.runner ?? '-'} / ${run.metrics.model ?? '-'}</span>
            <span>updated ${formatCreatedAt(run.updatedAt)}</span>
          </span>
        </span>
        <span class="slrm-actions">
          <a class="slrm-link" href=${`#${routeForRun({ id: run.id })}`}>Open</a>
          ${loadable
            ? html`<button
                class="slrm-load ${confirming ? 'confirm' : ''}"
                ?disabled=${this._actionBusy}
                title=${this._bindOnlyHint(run) ||
                `Warm-switch ${this.slotId} onto this run's branch and bind the run. No new run is created.`}
                @click=${() => this._onLoadClick(run)}
              >
                ${this._actionBusy && confirming
                  ? 'Loading…'
                  : confirming
                    ? 'Confirm?'
                    : `Load onto ${this.slotId} →`}
              </button>`
            : html`<button class="slrm-load" disabled title=${disabledTitle}>
                Load onto ${this.slotId} →
              </button>`}
        </span>
      </div>
    `;
  }

  override render() {
    if (!this.open) return nothing;
    const filtered = this._filtered();
    return html`
      <div
        class="slrm-backdrop"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this._close();
        }}
      >
        <div class="slrm-panel" role="dialog" aria-modal="true" aria-label="Load run onto slot">
          <div class="slrm-header">
            <div>
              <div class="slrm-title">Load run onto ${this.slotId || 'unknown slot'}</div>
              <div class="slrm-subtitle">
                ${this.project ? `${this.project} runs` : 'Runs'} — warm-switch this slot onto a
                run's branch.
              </div>
            </div>
            <button class="slrm-close" @click=${this._close}>Close (Esc)</button>
          </div>
          <div class="slrm-body">
            <div class="slrm-note">
              Load uses the selected prepare profile in strict mode — if attach preconditions fail
              (e.g. health not ready), prepare fails fast instead of silently escalating to a
              heavier profile. When the slot is already on the run's branch, only binding runs. No
              new run is created and the pipeline is not re-driven.
            </div>
            <div class="slrm-profile-row">
              <span class="slrm-profile-label">Prepare profile</span>
              ${this._prepareProfiles.length > 0
                ? html`
                    <select
                      class="slrm-select"
                      .value=${this._prepareProfile}
                      ?disabled=${this._actionBusy}
                      @change=${(event: Event) => {
                        this._prepareProfile = (event.target as HTMLSelectElement).value;
                      }}
                    >
                      ${this._prepareProfiles.map(
                        (profile) =>
                          html`<option value=${profile.name}>${profile.label}</option>`,
                      )}
                    </select>
                  `
                : html`
                    <select class="slrm-select" ?disabled=${this._actionBusy}>
                      <option value="attach">attach</option>
                    </select>
                  `}
              <span class="slrm-profile-hint">
                attach checks out only when the branch differs; strict mode keeps attach from
                falling back to full deps when health is not ready.
              </span>
            </div>
            ${this._prepareState
              ? html`<div class="slrm-progress">
                  <prepare-progress-panel .state=${this._prepareState} compact></prepare-progress-panel>
                </div>`
              : nothing}
            ${this._actionError
              ? html`<div class="slrm-state error">${this._actionError}</div>`
              : nothing}
            ${this._loading
              ? html`<div class="slrm-state">Loading runs…</div>`
              : this._error
                ? html`
                    <div class="slrm-state error">
                      Failed to load runs: ${this._error}
                      <div style="margin-top:${spacing.sm};">
                        <button class="slrm-retry" @click=${() => this._load()}>Retry</button>
                      </div>
                    </div>
                  `
                : this._runs.length === 0
                  ? html`<div class="slrm-state">No runs found.</div>`
                  : html`
                      <div class="slrm-filters">
                        <input
                          class="slrm-input"
                          type="text"
                          placeholder="Search ticket/PR, summary, branch…"
                          .value=${this._search}
                          @input=${(event: Event) => {
                            this._search = (event.target as HTMLInputElement).value;
                          }}
                        />
                        <select
                          class="slrm-select"
                          @change=${(event: Event) => {
                            this._statusFilter = (event.target as HTMLSelectElement).value;
                          }}
                        >
                          <option value="" ?selected=${this._statusFilter === ''}>
                            All statuses
                          </option>
                          ${this._statuses().map(
                            (status) =>
                              html`<option
                                value=${status}
                                ?selected=${this._statusFilter === status}
                              >
                                ${status}
                              </option>`,
                          )}
                        </select>
                        <span class="slrm-result-count"
                          >Showing ${filtered.length} of
                          ${this._totalCount > this._runs.length
                            ? this._totalCount
                            : this._runs.length}
                          run(s)</span
                        >
                      </div>
                      ${filtered.length === 0
                        ? html`<div class="slrm-state">No runs match the current filters.</div>`
                        : html`<div class="slrm-list">
                            ${filtered.map((run) => this._renderRow(run))}
                          </div>`}
                    `}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-load-run-modal': SlotLoadRunModal;
  }
}
