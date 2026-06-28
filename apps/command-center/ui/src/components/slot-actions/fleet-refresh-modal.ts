// fleet-refresh-modal.ts — Bulk "Refresh idle slots" modal.
//
// Operator clicks "Refresh idle" in the fleet toolbar → modal opens →
// reviews two sections (Safe / Force-required) → confirms selection →
// watches per-slot live progress complete in place. Operator-initiated
// only — no timer or auto-trigger anywhere.
//
// Reuses gateway/<slot-actions-panel> patterns:
//   - pre-allocate bulk requestId UI-side so strict event matchers are
//     primed before any frame can arrive
//   - per-slot script.output / script.complete events are routed by each
//     slot's own requestId (echoed back via fleet.refresh.scheduled)
//   - re-uses the slot.refresh result.reason field for the per-row Force
//     button gating (no substring grep)

import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import type {
  ConfigProjectsResult,
  FleetPrSummaryResult,
  FleetRefreshScheduledEvent,
  FleetRefreshSlotsResult,
  FleetRefreshSlotUpdateEvent,
  FleetRefreshSummaryEvent,
  FleetStatusResult,
  ScriptComplete,
  ScriptOutput,
  SlotRefreshResult,
} from '@farmslot/protocol';
import { Events, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getState } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';

import {
  appendFleetRefreshRowLog,
  buildFleetRefreshReviewRows,
  deselectFleetRefreshDangerousRows,
  findFleetRefreshRowByRequestId,
  type FleetRefreshProjectConfig,
  type FleetRefreshRowState,
  fleetRefreshRunningProgress,
  groupFleetRefreshRows,
  selectedFleetRefreshDangerousRowCount,
  selectedFleetRefreshRowCount,
  setFleetRefreshRowsSelected,
  toggleFleetRefreshRowExpanded,
  updateFleetRefreshRowSelection,
} from './fleet-refresh-modal-model.js';
import {
  CONFIRM_ALLOW_DANGEROUS,
  CONFIRM_SELECT_ALL_FORCE,
  FleetRefreshModalState,
} from './fleet-refresh-modal-state.js';
import { fleetRefreshModalStyles } from './fleet-refresh-modal-styles.js';

const FLEET_REFRESH_TIMEOUT = 30 * 60_000; // 30min ceiling for the bulk method
const LOG_TAIL_TRUNCATE = 80;
const MAX_LOG_LINES = 500;

@customElement('fleet-refresh-modal')
export class FleetRefreshModal extends FleetRefreshModalState {
  static override styles = fleetRefreshModalStyles;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onKeydown);
    this._teardown();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('open')) {
      if (this.open) {
        void this._loadEligible();
      } else {
        this._teardown();
      }
    }
  }

  private _onKeydown = (e: KeyboardEvent) => {
    if (!this.open) return;
    if (e.key === 'Escape') this._tryClose();
  };

  private _close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private _tryClose() {
    // While running, leave in-flight slots running in the background per spec.
    // Close UX is the same regardless.
    this._close();
  }

  private _teardown() {
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    this._confirmTimer.clear();
  }

  private async _loadEligible() {
    this._phase = 'loading';
    this._error = '';
    this._rows = new Map();
    this._hidden = [];
    this._summary = null;
    this._bulkRequestId = '';
    // Invalidate any in-flight PR-summary request from a prior modal session up front so its
    // late `.then`/`.finally` can't mutate this fresh session's loading/override state.
    this._prAnnotationsRequestId += 1;
    this._prAnnotationsLoading = false;
    // Snapshot the global filter at open time. Empty arrays mean "no filter" — preserve
    // the legacy behavior of showing the entire fleet when the user hasn't narrowed.
    const filters = getState().globalFilters;
    this._filterSnapshot = { projects: [...filters.projects], machines: [...filters.machines] };
    this._filteredOutCount = 0;

    let fleet: FleetStatusResult;
    let projectConfigs: Record<string, FleetRefreshProjectConfig> = {};
    try {
      const [fleetResult, projectsResult] = await Promise.all([
        gateway.request<FleetStatusResult>(Methods.FLEET_STATUS, {}),
        gateway.request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {}).catch(() => ({
          projects: [],
        })),
      ]);
      fleet = fleetResult;
      projectConfigs = Object.fromEntries(
        (projectsResult.projects ?? []).map((project) => [
          project.name,
          {
            defaultBranch: project.defaultBranch,
            slotTrackingBranch: project.slotTrackingBranch,
          },
        ]),
      );
    } catch (err) {
      this._phase = 'error';
      this._error = `Fleet load failed: ${err instanceof Error ? err.message : 'unknown'}`;
      return;
    }

    const { rows, hidden, staleSlotIds, filteredOutCount } = buildFleetRefreshReviewRows(
      fleet.fleet.slots,
      this._filterSnapshot,
      projectConfigs,
    );

    this._rows = rows;
    this._hidden = hidden;
    this._filteredOutCount = filteredOutCount;
    this._phase = 'review';

    // Best-effort PR annotation in parallel with the rest of the modal. The danger
    // section's override toggle stays disabled while this is pending so operators can't
    // opt into open-PR slots before we know which rows actually have an open PR.
    if (staleSlotIds.length > 0) {
      const reqId = ++this._prAnnotationsRequestId;
      this._prAnnotationsLoading = true;
      gateway
        .request<FleetPrSummaryResult>(Methods.FLEET_PR_SUMMARY, { slotIds: staleSlotIds })
        .then((result) => {
          if (reqId !== this._prAnnotationsRequestId) return;
          const next = new Map(this._rows);
          for (const [slotId, entry] of Object.entries(result.entries ?? {})) {
            const row = next.get(slotId);
            if (row) row.prAnnotation = entry;
          }
          this._rows = next;
        })
        .catch((err) => {
          // Best-effort enrichment — rows stay marked "PR state unknown" so the operator can
          // still proceed. Log so a sustained gh outage is visible in the browser console.
          console.warn('[fleet-refresh-modal] PR annotation fetch failed:', err);
        })
        .finally(() => {
          if (reqId !== this._prAnnotationsRequestId) return;
          this._prAnnotationsLoading = false;
          this.requestUpdate();
        });
    }
  }

  private _toggleRow(slotId: string, selected: boolean) {
    this._rows = updateFleetRefreshRowSelection(this._rows, slotId, selected, this._allowDangerous);
  }

  /** Toggle the "show open-PR slots" override. */
  private _toggleAllowDangerous() {
    if (!this._allowDangerous) {
      // Enabling = destructive, require 2-click confirm.
      this._confirmTimer.confirm(CONFIRM_ALLOW_DANGEROUS, () => {
        this._allowDangerous = true;
      });
      return;
    }
    // Disabling — auto-deselect any currently-selected dangerous rows so
    // they don't sneak into a refresh after the operator changes their mind.
    this._allowDangerous = false;
    this._rows = deselectFleetRefreshDangerousRows(this._rows);
  }

  private _selectAllSafe(selected: boolean) {
    this._rows = setFleetRefreshRowsSelected(this._rows, selected, 'safe');
  }

  /**
   * Select-all only applies to the SAFE Force subsection (PR merged/closed
   * or no-PR). Dangerous rows (open / unknown PR) always require a
   * per-row click — there is no bulk select for them by design.
   */
  private _selectAllForce(selected: boolean) {
    if (!selected) {
      this._rows = setFleetRefreshRowsSelected(this._rows, selected, 'force-safe');
      return;
    }
    // Destructive — require 2-click confirm.
    this._confirmTimer.confirm(CONFIRM_SELECT_ALL_FORCE, () => {
      this._rows = setFleetRefreshRowsSelected(this._rows, selected, 'force-safe');
    });
  }

  private _toggleExpand(slotId: string) {
    this._rows = toggleFleetRefreshRowExpanded(this._rows, slotId);
  }

  private async _refresh() {
    const selected = Array.from(this._rows.values()).filter((r) => r.selected);
    if (selected.length === 0) return;

    this._phase = 'running';
    this._summary = null;

    // Pre-allocate the bulk requestId so strict event matchers know the key
    // before any frame can arrive (mirrors slot.refresh client-id pattern).
    const bulkRequestId = `fleet-refresh-${crypto.randomUUID()}`;
    this._bulkRequestId = bulkRequestId;

    // Wire subscriptions BEFORE the request so we never miss the
    // fleet.refresh.scheduled echo.
    this._wireBulkSubscribers(bulkRequestId);

    // Mark every selected row as pending until scheduled echoes back.
    {
      const next = new Map(this._rows);
      for (const [id, row] of next) {
        if (row.selected) {
          next.set(id, {
            ...row,
            status: 'pending',
            detail: '',
            sha: '',
            lastLogLine: '',
            log: [],
            forceRecoverable: false,
          });
        }
      }
      this._rows = next;
    }

    try {
      const slots = selected.map((r) => ({ slotId: r.slotId, mode: r.mode }));
      await gateway.request<FleetRefreshSlotsResult>(
        Methods.FLEET_REFRESH_SLOTS,
        { slots, requestId: bulkRequestId },
        FLEET_REFRESH_TIMEOUT,
      );
      // The response (perSlotRequestIds) is delivered via the
      // fleet.refresh.scheduled event subscription, so nothing to do here.
    } catch (err) {
      this._phase = 'error';
      this._error = `fleet.refreshSlots failed: ${err instanceof Error ? err.message : 'unknown'}`;
      this._teardown();
    }
  }

  private _wireBulkSubscribers(bulkRequestId: string) {
    // Captured set of per-slot requestIds for THIS bulk, so script.output /
    // script.complete subscribers can hard-filter unrelated streams (e.g.
    // a parallel slot.refresh fired from another surface, or a stale
    // subscriber from a previous bulk that hadn't torn down yet).
    const expectedPerSlotIds = new Set<string>();

    const onScheduled = (payload: unknown) => {
      const data = payload as FleetRefreshScheduledEvent;
      if (data.requestId !== bulkRequestId) return;
      const next = new Map(this._rows);
      for (const [slotId, requestId] of Object.entries(data.perSlotRequestIds ?? {})) {
        expectedPerSlotIds.add(requestId);
        const row = next.get(slotId);
        if (row) next.set(slotId, { ...row, requestId });
      }
      this._rows = next;
    };

    const onSlotUpdate = (payload: unknown) => {
      const data = payload as FleetRefreshSlotUpdateEvent;
      if (data.requestId !== bulkRequestId) return;
      const row = this._rows.get(data.slotId);
      if (!row) return;
      const updated: FleetRefreshRowState = {
        ...row,
        status: data.status,
        detail: data.detail ?? '',
        sha: data.sha ?? row.sha,
      };
      // Surface inline Force button on safe-mode dirty/stale aborts. Gated
      // on the typed `recoverableViaForce` flag from the event so UI never
      // string-matches against the free-form detail field.
      if (data.status === 'failed' && data.recoverableViaForce) {
        updated.forceRecoverable = true;
      } else if (data.status === 'running') {
        updated.forceRecoverable = false;
      }
      const next = new Map(this._rows);
      next.set(data.slotId, updated);
      this._rows = next;
    };

    const onSummary = (payload: unknown) => {
      const data = payload as FleetRefreshSummaryEvent;
      if (data.requestId !== bulkRequestId) return;
      this._summary = data;
      this._phase = 'done';
    };

    const onScriptOutput = (payload: unknown) => {
      const data = payload as ScriptOutput;
      // Hard scope: only events for THIS bulk's per-slot ids. Cheap defense
      // against multi-bulk overlap and stale subscribers.
      if (!expectedPerSlotIds.has(data.requestId)) return;
      const row = this._findRowByPerSlotRequestId(data.requestId);
      if (!row) return;
      const updatedRow = appendFleetRefreshRowLog(row, data.data, {
        maxLines: MAX_LOG_LINES,
        tailTruncate: LOG_TAIL_TRUNCATE,
      });
      if (!updatedRow) return;
      const next = new Map(this._rows);
      next.set(row.slotId, updatedRow);
      this._rows = next;
    };

    const onScriptComplete = (payload: unknown) => {
      // No-op for fleet flow — slot-update event carries the terminal state.
      // Subscribed only so it tears down with the rest on _teardown.
      void payload;
    };

    this._unsubs.push(gateway.subscribe(Events.FLEET_REFRESH_SCHEDULED, onScheduled));
    this._unsubs.push(gateway.subscribe(Events.FLEET_REFRESH_SLOT_UPDATE, onSlotUpdate));
    this._unsubs.push(gateway.subscribe(Events.FLEET_REFRESH_SUMMARY, onSummary));
    this._unsubs.push(gateway.subscribe(Events.SCRIPT_OUTPUT, onScriptOutput));
    this._unsubs.push(gateway.subscribe(Events.SCRIPT_COMPLETE, onScriptComplete));
  }

  private _findRowByPerSlotRequestId(perSlotId: string): FleetRefreshRowState | undefined {
    return findFleetRefreshRowByRequestId(this._rows.values(), perSlotId);
  }

  private async _cancel() {
    if (!this._bulkRequestId) return;
    try {
      await gateway.request(Methods.FLEET_REFRESH_SLOTS_CANCEL, { requestId: this._bulkRequestId });
    } catch (err) {
      this._error = `Cancel failed: ${err instanceof Error ? err.message : 'unknown'}`;
    }
  }

  private async _forceRow(slotId: string) {
    const row = this._rows.get(slotId);
    if (!row) return;
    // Issue an isolated slot.refresh in force mode and thread the events
    // back into the row's log via the same subscribers (we register a fresh
    // requestId for this call).
    const reqId = `refresh-${crypto.randomUUID()}`;
    const next = new Map(this._rows);
    next.set(slotId, {
      ...row,
      status: 'running',
      detail: 'force',
      mode: 'force',
      forceRecoverable: false,
      requestId: reqId,
      log: [],
      lastLogLine: '',
    });
    this._rows = next;

    // Per-call subscribers (separate from the bulk subscribers; cleaned up
    // when this row's complete event fires).
    const cleanup: Array<() => void> = [];
    const onOutput = (payload: unknown) => {
      const data = payload as ScriptOutput;
      if (data.requestId !== reqId) return;
      const r = this._rows.get(slotId);
      if (!r) return;
      const updatedRow = appendFleetRefreshRowLog(r, data.data, {
        maxLines: MAX_LOG_LINES,
        tailTruncate: LOG_TAIL_TRUNCATE,
      });
      if (!updatedRow) return;
      const updated = new Map(this._rows);
      updated.set(slotId, updatedRow);
      this._rows = updated;
    };
    const onComplete = (payload: unknown) => {
      const data = payload as ScriptComplete;
      if (data.requestId !== reqId) return;
      cleanup.forEach((fn) => fn());
    };
    cleanup.push(gateway.subscribe(Events.SCRIPT_OUTPUT, onOutput));
    cleanup.push(gateway.subscribe(Events.SCRIPT_COMPLETE, onComplete));

    try {
      const result = await gateway.request<SlotRefreshResult>(
        Methods.SLOT_REFRESH,
        { slotId, mode: 'force', requestId: reqId },
        FLEET_REFRESH_TIMEOUT,
      );
      const r = this._rows.get(slotId);
      if (!r) return;
      const updated = new Map(this._rows);
      if (result.refreshed) {
        updated.set(slotId, {
          ...r,
          status: 'refreshed',
          detail: result.advanced ? 'advanced' : 'already up-to-date',
          mode: 'force',
        });
      } else {
        updated.set(slotId, {
          ...r,
          status: 'failed',
          detail: result.reason ?? 'force aborted',
          mode: 'force',
          forceRecoverable: false,
        });
      }
      this._rows = updated;
    } catch (err) {
      const r = this._rows.get(slotId);
      if (!r) return;
      const updated = new Map(this._rows);
      updated.set(slotId, {
        ...r,
        status: 'failed',
        detail: err instanceof Error ? err.message : 'force failed',
        mode: 'force',
      });
      this._rows = updated;
    }
  }

  private _renderRow(row: FleetRefreshRowState, sectionStyle: 'safe' | 'force' | 'danger') {
    const status = row.status;
    const branchClass = `branch ${row.isStale ? 'stale' : ''}`;
    const isDangerous = sectionStyle === 'danger';
    const showCheckbox = this._phase === 'review';
    const checkboxDisabled = this._phase !== 'review' || (isDangerous && !this._allowDangerous);
    const showForceBtn = row.forceRecoverable && this._phase !== 'running';
    const prState = row.prAnnotation?.state ?? null;
    const prLabel = (() => {
      if (!row.prAnnotation) return isDangerous ? 'PR state unknown' : '';
      if (row.prAnnotation.prNumber !== null) {
        return `PR #${row.prAnnotation.prNumber} ${prState ?? ''}`.trim();
      }
      return sectionStyle !== 'safe' ? 'no PR found' : '';
    })();
    const reviewBadge =
      sectionStyle === 'safe'
        ? 'clean'
        : sectionStyle === 'danger'
          ? prState === 'open'
            ? 'PR OPEN'
            : row.prAnnotation === null
              ? 'loading'
              : 'unknown'
          : 'stale';

    const onRowClick = () => {
      if (this._phase === 'review') {
        if (checkboxDisabled) return;
        this._toggleRow(row.slotId, !row.selected);
      } else {
        this._toggleExpand(row.slotId);
      }
    };
    return html`
      <div
        class="frm-row ${row.expanded ? 'expanded' : ''} ${status} ${isDangerous &&
        this._phase === 'review'
          ? 'danger'
          : ''}"
        @click=${onRowClick}
      >
        <input
          type="checkbox"
          ?disabled=${checkboxDisabled}
          ?checked=${row.selected}
          aria-label="Refresh slot ${row.slotId}${isDangerous
            ? ' (open or unknown PR — destructive)'
            : ''}"
          @click=${(e: Event) => e.stopPropagation()}
          @change=${(e: Event) =>
            this._toggleRow(row.slotId, (e.target as HTMLInputElement).checked)}
          style="visibility: ${showCheckbox ? 'visible' : 'hidden'}"
        />
        <span class="slot-id">${row.slotId}</span>
        <span class="${branchClass}">${row.branch || '(no branch)'}</span>
        <span class="meta">
          ${this._phase === 'review'
            ? html`
                ${row.machine}
                ${prLabel
                  ? html`<span class="pr-state ${prState ?? ''}"> · ${prLabel}</span>`
                  : nothing}
              `
            : html`
                ${status === 'failed' ||
                status === 'skipped' ||
                status === 'cancelled' ||
                status === 'refreshed'
                  ? row.detail || row.lastLogLine || ''
                  : row.lastLogLine || row.detail || (status === 'pending' ? 'pending' : '')}
              `}
        </span>
        <span class="status-badge ${status}">
          ${this._phase === 'review' ? reviewBadge : status}
          ${status === 'refreshed' && row.sha ? ` @ ${row.sha.slice(0, 7)}` : ''}
        </span>
        ${showForceBtn
          ? html`
              <button
                class="force-btn"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  void this._forceRow(row.slotId);
                }}
              >
                Force this
              </button>
            `
          : nothing}
        ${row.expanded && row.log.length > 0
          ? html` <pre class="frm-log-full">${row.log.join('\n')}</pre> `
          : nothing}
      </div>
    `;
  }

  private _renderFilterBadge() {
    const { projects, machines } = this._filterSnapshot;
    if (projects.length === 0 && machines.length === 0) return nothing;
    const parts: string[] = [];
    if (projects.length > 0) parts.push(`projects: ${projects.join(', ')}`);
    if (machines.length > 0) parts.push(`machines: ${machines.join(', ')}`);
    return html`<div class="frm-filter-badge">Scoped to global filter — ${parts.join(' · ')}</div>`;
  }

  private _renderReview() {
    const { safe, forceSafe, forceDanger } = groupFleetRefreshRows(this._rows.values());
    if (safe.length === 0 && forceSafe.length === 0 && forceDanger.length === 0) {
      return html`<div class="frm-empty">All slots busy or disabled — nothing to refresh.</div>`;
    }
    return html`
      ${safe.length > 0
        ? html`
            <div class="frm-section">
              <div
                class="frm-section-header safe"
                @click=${() => {
                  this._expandSafe = !this._expandSafe;
                }}
              >
                <span class="frm-section-arrow ${this._expandSafe ? 'open' : ''}">▶</span>
                <span>Safe to refresh <span class="frm-section-count">(${safe.length})</span></span>
                ${this._phase === 'review'
                  ? html`
                      <button
                        class="frm-select-all"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          const allSelected = safe.every((r) => r.selected);
                          this._selectAllSafe(!allSelected);
                        }}
                      >
                        ${safe.every((r) => r.selected) ? 'deselect all' : 'select all'}
                      </button>
                    `
                  : nothing}
              </div>
              ${this._expandSafe ? safe.map((r) => this._renderRow(r, 'safe')) : nothing}
            </div>
          `
        : nothing}
      ${forceSafe.length > 0
        ? html`
            <div class="frm-section">
              <div
                class="frm-section-header force"
                @click=${() => {
                  this._expandForce = !this._expandForce;
                }}
              >
                <span class="frm-section-arrow ${this._expandForce ? 'open' : ''}">▶</span>
                <span
                  >Force required
                  <span class="frm-section-count"
                    >(${forceSafe.length} · PR merged or no PR)</span
                  ></span
                >
                ${this._phase === 'review'
                  ? html`
                      <button
                        class="frm-select-all ${this._pendingSelectAllForce ? 'confirming' : ''}"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          const allSelected = forceSafe.every((r) => r.selected);
                          this._selectAllForce(!allSelected);
                        }}
                      >
                        ${forceSafe.every((r) => r.selected)
                          ? 'deselect all'
                          : this._pendingSelectAllForce
                            ? 'confirm select all?'
                            : 'select all'}
                      </button>
                    `
                  : nothing}
              </div>
              ${this._expandForce
                ? html`
                    <div class="frm-warn">
                      Force discards local branch state. Opt in per slot — destructive.
                    </div>
                    ${forceSafe.map((r) => this._renderRow(r, 'force'))}
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${forceDanger.length > 0
        ? html`
            <div class="frm-section">
              <div
                class="frm-section-header danger"
                @click=${() => {
                  this._expandForce = !this._expandForce;
                }}
              >
                <span class="frm-section-arrow ${this._expandForce ? 'open' : ''}">▶</span>
                <span
                  >Force required — DANGEROUS
                  <span class="frm-section-count"
                    >(${forceDanger.length} · open or unknown PR)</span
                  >
                </span>
              </div>
              ${this._expandForce
                ? html`
                    <div class="frm-warn danger">
                      These slots have an OPEN PR or unverified PR state. Force-refreshing will
                      discard branch state that may contain active review work. Each slot must be
                      opted in individually — there is no select-all.
                    </div>
                    ${this._prAnnotationsLoading
                      ? html`
                          <div class="frm-pr-loading">
                            <span class="frm-pr-loading-dot"></span>
                            Loading PR states for ${forceDanger.length}
                            slot${forceDanger.length === 1 ? '' : 's'}… opt-in stays disabled until
                            done.
                          </div>
                        `
                      : nothing}
                    ${this._phase === 'review'
                      ? html`
                          <div class="frm-allow-toggle">
                            <span
                              >${this._allowDangerous
                                ? 'Override active — open-PR slots can be selected per-row.'
                                : 'Open-PR slots are blocked. Override only if you know the PR is abandoned.'}</span
                            >
                            <button
                              class="${this._allowDangerous ? 'active' : ''} ${this
                                ._pendingAllowDangerous
                                ? 'confirming'
                                : ''}"
                              ?disabled=${this._prAnnotationsLoading && !this._allowDangerous}
                              @click=${() => this._toggleAllowDangerous()}
                            >
                              ${this._allowDangerous
                                ? 'Disable override'
                                : this._pendingAllowDangerous
                                  ? 'Confirm override?'
                                  : this._prAnnotationsLoading
                                    ? 'Loading PR states…'
                                    : 'I understand — allow open-PR slots'}
                            </button>
                          </div>
                        `
                      : nothing}
                    ${forceDanger.map((r) => this._renderRow(r, 'danger'))}
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${this._hidden.length > 0
        ? html`
            <div class="frm-section">
              <div
                class="frm-section-header hidden"
                @click=${() => {
                  this._expandHidden = !this._expandHidden;
                }}
              >
                <span class="frm-section-arrow ${this._expandHidden ? 'open' : ''}">▶</span>
                <span
                  >Skipping <span class="frm-section-count">(${this._hidden.length})</span></span
                >
              </div>
              ${this._expandHidden
                ? html`
                    ${this._hidden.map(
                      (h) => html`
                        <div class="frm-row" style="opacity:0.65; cursor:default">
                          <span></span>
                          <span class="slot-id">${h.slotId}</span>
                          <span class="meta" style="grid-column: 3 / 5">${h.reason}</span>
                          <span class="status-badge skipped">skipped</span>
                        </div>
                      `,
                    )}
                  `
                : nothing}
            </div>
          `
        : nothing}
    `;
  }

  private _renderFooter() {
    const phase = this._phase;
    if (phase === 'review') {
      const total = selectedFleetRefreshRowCount(this._rows.values());
      const force = selectedFleetRefreshRowCount(this._rows.values(), 'force');
      const dangerSelected = selectedFleetRefreshDangerousRowCount(this._rows.values());
      return html`
        <div class="progress">
          ${total > 0
            ? html`<strong>${total}</strong> slot${total === 1 ? '' : 's'}
                selected${force > 0
                  ? html` · <span style="color:${colors.statusWarn}">${force} force</span>`
                  : ''}${dangerSelected > 0
                  ? html` ·
                      <span style="color:${colors.statusFail}">[!] ${dangerSelected} open-PR</span>`
                  : ''}`
            : 'No slots selected'}
        </div>
        <button class="frm-action-btn" @click=${() => this._tryClose()}>Close</button>
        <button
          class="frm-action-btn ${dangerSelected > 0 ? 'danger' : 'primary'}"
          ?disabled=${total === 0}
          @click=${() => this._refresh()}
        >
          Refresh ${total > 0 ? total : ''}
        </button>
      `;
    }
    if (phase === 'running') {
      const { total, done, failed } = fleetRefreshRunningProgress(this._rows.values());
      return html`
        <div class="progress">
          <strong>${done}</strong>/${total}
          done${failed > 0
            ? html` · <span style="color:${colors.statusFail}">${failed} failed</span>`
            : nothing}
        </div>
        <button class="frm-action-btn danger" @click=${() => this._cancel()}>Cancel</button>
        <button class="frm-action-btn" @click=${() => this._tryClose()}>Close</button>
      `;
    }
    if (phase === 'done' && this._summary) {
      const s = this._summary;
      return html`
        <div class="progress">
          <strong>Done</strong> ·
          <span style="color:${colors.statusOk}">${s.refreshed} refreshed</span> · ${s.skipped}
          skipped ·
          <span style="color:${colors.statusFail}">${s.failed} failed</span>
          ${s.cancelled > 0 ? html` · ${s.cancelled} cancelled` : nothing} ·
          ${(s.durationMs / 1000).toFixed(1)}s
        </div>
        <button class="frm-action-btn primary" @click=${() => this._tryClose()}>Close</button>
      `;
    }
    if (phase === 'error') {
      return html`
        <div class="progress" style="color:${colors.statusFail}">${this._error}</div>
        <button class="frm-action-btn" @click=${() => this._tryClose()}>Close</button>
      `;
    }
    return html`
      <div class="progress">Loading fleet...</div>
      <button class="frm-action-btn" @click=${() => this._tryClose()}>Cancel</button>
    `;
  }

  override render() {
    if (!this.open) return null;
    const eligibleCount = this._rows.size;
    return html`
      <div
        class="frm-backdrop"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this._tryClose();
        }}
      >
        <div class="frm-panel" role="dialog" aria-label="Refresh idle slots">
          <div class="frm-header">
            <div>
              <span class="frm-title">Refresh idle slots</span>
              ${this._phase === 'review' && eligibleCount > 0
                ? html`<span class="frm-title-meta"
                    >${eligibleCount} eligible · ${this._hidden.length}
                    skipped${this._filteredOutCount > 0
                      ? html` · ${this._filteredOutCount} hidden by filter`
                      : nothing}</span
                  >`
                : nothing}
              ${this._renderFilterBadge()}
            </div>
            <button class="frm-close" @click=${this._tryClose}>Close (Esc)</button>
          </div>
          <div class="frm-body">
            ${this._phase === 'loading'
              ? html`<div class="frm-empty">Loading fleet…</div>`
              : nothing}
            ${this._phase === 'error' ? html`<div class="frm-error">${this._error}</div>` : nothing}
            ${this._phase === 'review' || this._phase === 'running' || this._phase === 'done'
              ? this._renderReview()
              : nothing}
          </div>
          <div class="frm-footer">${this._renderFooter()}</div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fleet-refresh-modal': FleetRefreshModal;
  }
}
