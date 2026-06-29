import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  canActivateRunOnSlot,
  Methods,
  type SlotRunHistoryEntry,
  type SlotRunHistoryResult,
} from '@farmslot/protocol';

import '../shared/slot-prepare-popover.js';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { formatCreatedAt, formatDuration, routeForRun, runStatusColor } from '../runs/run-utils.js';
import { CopyFeedbackTimer } from '../shared/copy-feedback-model.js';

const DEFAULT_LIMIT = 25;

@customElement('slot-history-modal')
export class SlotHistoryModal extends LitElement {
  @property({ attribute: 'slot-id' }) slotId = '';
  @property() project = '';
  @property({ attribute: 'slot-branch' }) slotBranch = '';
  @property({ attribute: false }) slotHealth: import('@farmslot/protocol').SlotHealth | null = null;
  @property({ type: Boolean }) open = false;
  /** When set, the modal expands this run row + scrolls it into view on open. */
  @property({ attribute: 'selected-run-id' }) selectedRunId = '';
  /** Dev harness escape hatch: when provided, no gateway call is made. */
  @property({ attribute: false }) historyEntries?: SlotRunHistoryEntry[];

  @state() private _loading = false;
  @state() private _error = '';
  @state() private _runs: SlotRunHistoryEntry[] = [];
  @state() private _totalCount = 0;
  @state() private _expanded = new Set<string>();
  @state() private _copiedKey = '';
  @state() private _copyError = '';
  @state() private _slotExists = true;
  private _loadToken = Symbol('slot-history-load');
  private readonly _copyFeedback = new CopyFeedbackTimer({
    copiedKey: () => this._copiedKey,
    setCopiedKey: (key) => {
      this._copiedKey = key;
    },
  });

  static override styles = css`
    .shm-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1100;
      background: rgba(0, 0, 0, 0.62);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 56px 16px 16px;
    }
    .shm-panel {
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
    .shm-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      border-bottom: 1px solid #2a2a44;
    }
    .shm-title {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
    }
    .shm-subtitle {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      margin-top: 2px;
    }
    .shm-close,
    .shm-retry,
    .shm-copy,
    .shm-link {
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
    .shm-close:hover,
    .shm-retry:hover,
    .shm-copy:hover,
    .shm-link:hover {
      color: ${unsafeCSS(colors.textPrimary)};
      border-color: ${unsafeCSS(colors.accent)};
    }
    .shm-body {
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.md)};
    }
    .shm-note {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      margin-bottom: ${unsafeCSS(spacing.md)};
      line-height: 1.5;
    }
    .shm-state {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      padding: ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
    }
    .shm-state.error {
      color: ${unsafeCSS(colors.statusWarn)};
    }
    .shm-list {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.md)};
    }
    .shm-family {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.xs)};
      padding: ${unsafeCSS(spacing.xs)} 0 ${unsafeCSS(spacing.sm)};
      border-top: 1px dashed ${unsafeCSS(colors.textMuted)}33;
    }
    .shm-family:first-child {
      border-top: none;
      padding-top: 0;
    }
    .shm-family-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
      flex-wrap: wrap;
      padding: 4px ${unsafeCSS(spacing.xs)};
    }
    .shm-family-title {
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 700;
    }
    .shm-family-meta {
      font-size: 11px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .shm-row {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      overflow: hidden;
    }
    .shm-row.current {
      border-color: ${unsafeCSS(colors.accent)}88;
      box-shadow: inset 3px 0 0 ${unsafeCSS(colors.accent)};
    }
    .shm-row.selected {
      border-color: ${unsafeCSS(colors.statusOk)};
      box-shadow: 0 0 0 2px ${unsafeCSS(colors.statusOk)}55;
    }
    .shm-row-main {
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      display: grid;
      grid-template-columns: 108px 96px minmax(0, 1fr);
      gap: ${unsafeCSS(spacing.sm)};
      align-items: start;
      text-align: left;
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .shm-row-main:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .shm-cell {
      min-width: 0;
    }
    .shm-compact-cell {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .shm-run-info {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .shm-run-title {
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      font-weight: 700;
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .shm-run-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 11px;
      line-height: 1.35;
    }
    .shm-meta-item {
      overflow-wrap: anywhere;
    }
    .shm-meta-strong {
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .shm-id {
      color: ${unsafeCSS(colors.accent)};
      font-weight: 700;
    }
    .shm-muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .shm-status {
      width: fit-content;
      padding: 2px 7px;
      border-radius: ${unsafeCSS(radii.sm)};
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .shm-current {
      margin-left: 6px;
      color: ${unsafeCSS(colors.accent)};
      font-size: 10px;
      font-weight: 700;
    }
    .shm-detail {
      border-top: 1px solid #2a2a44;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.md)};
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      background: ${unsafeCSS(colors.bgSurface)};
    }
    .shm-field {
      min-width: 0;
    }
    .shm-label {
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 3px;
    }
    .shm-value-row {
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .shm-value {
      color: ${unsafeCSS(colors.textSecondary)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .shm-copy {
      padding: 2px 6px;
      flex: 0 0 auto;
    }
    .shm-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      align-items: center;
    }
    @media (max-width: 860px) {
      .shm-row-main {
        grid-template-columns: 90px 82px minmax(0, 1fr);
      }
      .shm-detail {
        grid-template-columns: 1fr;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._onKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._onKeydown);
    this._copyFeedback.clear();
  }

  override updated(changed: Map<string, unknown>) {
    if (
      (changed.has('open') || changed.has('slotId') || changed.has('historyEntries')) &&
      this.open
    ) {
      void this._load();
    }
    // Auto-expand + scroll the URL-pinned run into view once the row is in
    // the DOM. Triggered when the selection arrives (deep-link), when the
    // modal opens, or when _runs first populates after a fresh load.
    if (
      this.open &&
      this.selectedRunId &&
      (changed.has('selectedRunId') || changed.has('open') || changed.has('_runs'))
    ) {
      const target = this._runs.find((run) => run.runId === this.selectedRunId);
      if (target && !this._expanded.has(target.runId)) {
        const next = new Set(this._expanded);
        next.add(target.runId);
        this._expanded = next;
      }
      if (target) {
        // Wait for the DOM to reflect the expand, then scroll the row in.
        void this.updateComplete.then(() => {
          this.renderRoot
            .querySelector<HTMLElement>(`[data-run-id="${target.runId}"]`)
            ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
    }
  }

  private _onKeydown = (event: KeyboardEvent) => {
    if (this.open && event.key === 'Escape') this._close();
  };

  private _close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async _load() {
    const token = Symbol('slot-history-load');
    this._loadToken = token;
    this._error = '';

    if (this.historyEntries) {
      this._runs = this.historyEntries;
      this._totalCount = this.historyEntries.length;
      this._slotExists = true;
      this._loading = false;
      return;
    }

    if (!this.slotId) return;
    this._loading = true;
    try {
      const result = await gateway.request<SlotRunHistoryResult>(Methods.RUN_SLOT_HISTORY, {
        slotId: this.slotId,
        limit: DEFAULT_LIMIT,
      });
      if (token !== this._loadToken) return;
      this._runs = result.runs;
      this._totalCount = result.totalCount;
      this._slotExists = result.slotExists;
    } catch (error) {
      if (token !== this._loadToken) return;
      this._error = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === this._loadToken) this._loading = false;
    }
  }

  private _toggle(runId: string) {
    const next = new Set(this._expanded);
    if (next.has(runId)) next.delete(runId);
    else next.add(runId);
    this._expanded = next;
  }

  private async _copy(key: string, value: string | null | undefined) {
    if (!value) return;
    this._copyError = '';
    try {
      await this._writeClipboard(value);
    } catch (error) {
      this._copyError = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this._copyFeedback.show(key, 1600);
  }

  private async _writeClipboard(value: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    this._copyWithTextarea(value);
  }

  private _copyWithTextarea(value: string) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    textarea.remove();
    if (!ok) throw new Error("document.execCommand('copy') returned false");
  }

  private _short(id: string): string {
    return id.slice(0, 8);
  }

  private _renderCopyField(label: string, key: string, value: string | null | undefined) {
    return html`
      <div class="shm-field">
        <div class="shm-label">${label}</div>
        <div class="shm-value-row">
          <span class="shm-value" title=${value ?? '-'}>${value ?? '-'}</span>
          ${value
            ? html`<button class="shm-copy" @click=${() => this._copy(key, value)}>
                ${this._copiedKey === key ? 'Copied' : 'Copy'}
              </button>`
            : nothing}
        </div>
      </div>
    `;
  }

  /**
   * Group _runs by familyId so the modal mirrors the runs-list family layout.
   * Within each group, runs stay newest-first (the gateway already orders the
   * input list this way). Group order: by the freshest run inside each
   * family, descending — so the most-recently-active family floats to the top
   * even if older runs from a different family preceded the gateway query.
   */
  private _familyGroups(): Array<{
    familyId: string;
    familyRootTicketOrPr: string;
    runs: SlotRunHistoryEntry[];
  }> {
    const groups = new Map<
      string,
      {
        familyId: string;
        familyRootTicketOrPr: string;
        runs: SlotRunHistoryEntry[];
        freshest: string;
        rootSeen: boolean;
      }
    >();
    for (const run of this._runs) {
      const familyId = run.familyId || run.runId;
      const isRoot = run.runId === familyId;
      const existing = groups.get(familyId);
      if (existing) {
        existing.runs.push(run);
        if (run.createdAt > existing.freshest) existing.freshest = run.createdAt;
        // Prefer the family-root run's ticket as the group label so a fix-bug
        // that later spawned pr-complete runs still shows the original ticket
        // rather than the latest activity's title.
        if (isRoot && run.ticketOrPr) {
          existing.familyRootTicketOrPr = run.ticketOrPr;
          existing.rootSeen = true;
        }
      } else {
        groups.set(familyId, {
          familyId,
          familyRootTicketOrPr: run.ticketOrPr || familyId.slice(0, 8),
          runs: [run],
          freshest: run.createdAt,
          rootSeen: isRoot,
        });
      }
    }
    return [...groups.values()]
      .sort((a, b) => (a.freshest < b.freshest ? 1 : a.freshest > b.freshest ? -1 : 0))
      .map(({ familyId, familyRootTicketOrPr, runs }) => ({
        familyId,
        familyRootTicketOrPr,
        runs,
      }));
  }

  private _renderRow(run: SlotRunHistoryEntry) {
    const expanded = this._expanded.has(run.runId);
    const isSelected = this.selectedRunId === run.runId;
    const statusColor = runStatusColor(run.status);
    const modelText =
      run.actualModel && run.actualModel !== run.model
        ? `${run.model ?? '-'} → ${run.actualModel}`
        : (run.model ?? '-');
    return html`
      <div
        class="shm-row ${run.currentForSlot ? 'current' : ''} ${isSelected ? 'selected' : ''}"
        data-run-id=${run.runId}
      >
        <button
          class="shm-row-main"
          @click=${() => this._toggle(run.runId)}
          aria-expanded=${expanded ? 'true' : 'false'}
          aria-controls=${`slot-history-detail-${run.runId}`}
        >
          <span class="shm-cell shm-compact-cell shm-id"
            >${this._short(run.runId)}${run.currentForSlot
              ? html`<span class="shm-current">CURRENT</span>`
              : nothing}</span
          >
          <span class="shm-cell shm-compact-cell"
            ><span class="shm-status" style="background:${statusColor}22;color:${statusColor}"
              >${run.status}</span
            ></span
          >
          <span class="shm-run-info">
            <span class="shm-run-title" title=${run.summary ?? run.ticketOrPr}
              >${run.flowType} · ${run.summary ?? run.ticketOrPr}</span
            >
            <span class="shm-run-meta">
              <span class="shm-meta-item shm-meta-strong">${run.ticketOrPr}</span>
              <span class="shm-meta-item">${run.branch ?? 'no branch'}</span>
              <span class="shm-meta-item">${run.runner ?? '-'} / ${modelText}</span>
              <span class="shm-meta-item"
                >${formatDuration(run.durationMs) || 'duration unknown'}</span
              >
              <span class="shm-meta-item">updated ${formatCreatedAt(run.updatedAt)}</span>
            </span>
          </span>
        </button>
        ${expanded
          ? html`
              <div id=${`slot-history-detail-${run.runId}`} class="shm-detail">
                ${this._renderCopyField('Run id', `${run.runId}:run`, run.runId)}
                ${this._renderCopyField('Family id', `${run.runId}:family`, run.familyId)}
                ${this._renderCopyField(
                  'Runner session id',
                  `${run.runId}:session-id`,
                  run.runnerSessionId,
                )}
                ${this._renderCopyField(
                  'Runner session path',
                  `${run.runId}:session-path`,
                  run.runnerSessionPath,
                )}
                ${this._renderCopyField('Task file', `${run.runId}:task-file`, run.taskFile)}
                ${this._renderCopyField('Task dir', `${run.runId}:task-dir`, run.taskDir)}
                ${this._renderCopyField(
                  'Artifact dir (recorded)',
                  `${run.runId}:artifact-dir`,
                  run.artifactDir,
                )}
                ${this._renderCopyField('Run record', `${run.runId}:record`, run.runRecordPath)}
                <div class="shm-field">
                  <div class="shm-label">Timestamps</div>
                  <div class="shm-value">
                    created ${formatCreatedAt(run.createdAt)} · updated
                    ${formatCreatedAt(run.updatedAt)}${run.completedAt
                      ? ` · completed ${formatCreatedAt(run.completedAt)}`
                      : ''}
                  </div>
                </div>
                <div class="shm-actions">
                  <a class="shm-link" href=${`#${routeForRun({ id: run.runId })}`}>Open run</a>
                  ${this.slotId && run.branch && canActivateRunOnSlot(run.status)
                    ? html`
                        <slot-prepare-popover
                          slot-id=${this.slotId}
                          slot-branch=${this.slotBranch}
                          project=${run.project || this.project}
                          run-id=${run.runId}
                          run-branch=${run.branch}
                          button-label="Load this slot with run →"
                          button-class="shm-retry"
                          .slotHealth=${this.slotHealth}
                          rebind
                        ></slot-prepare-popover>
                      `
                    : nothing}
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  override render() {
    if (!this.open) return nothing;
    return html`
      <div
        class="shm-backdrop"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this._close();
        }}
      >
        <div class="shm-panel" role="dialog" aria-modal="true" aria-label="Slot history">
          <div class="shm-header">
            <div>
              <div class="shm-title">Slot history · ${this.slotId || 'unknown slot'}</div>
              <div class="shm-subtitle">
                Recent retained runs with recovery paths and runner session metadata.
              </div>
            </div>
            <button class="shm-close" @click=${this._close}>Close (Esc)</button>
          </div>
          <div class="shm-body">
            <div class="shm-note">
              Retained run records for this slot. "Reload on this slot" re-binds a run and re-drives
              prepare+dispatch with the cheapest warm profile (no new run); recorded task/artifact
              paths may be stale if files were cleaned. It does not delete, archive, or change
              retention.
            </div>
            ${!this._slotExists
              ? html`<div class="shm-state error">
                  Slot ${this.slotId} is not present in the current fleet snapshot. History rows are
                  retained records only, so no row can be marked current.
                </div>`
              : nothing}
            ${this._copyError
              ? html`<div class="shm-state error">${this._copyError}</div>`
              : nothing}
            ${this._loading
              ? html`<div class="shm-state">Loading slot history…</div>`
              : this._error
                ? html`
                    <div class="shm-state error">
                      Failed to load slot history: ${this._error}
                      <div style="margin-top:${spacing.sm};">
                        <button class="shm-retry" @click=${() => this._load()}>Retry</button>
                      </div>
                    </div>
                  `
                : this._runs.length === 0
                  ? html` <div class="shm-state">No retained runs found for this slot.</div> `
                  : html`
                      <div class="shm-note">
                        Showing
                        ${this._runs.length}${this._totalCount > this._runs.length
                          ? ` of ${this._totalCount}`
                          : ''}
                        run(s) across ${this._familyGroups().length} family group(s), newest first.
                        Expand a row to copy recovery fields.
                      </div>
                      <div class="shm-list">
                        ${this._familyGroups().map(
                          (group) => html`
                            <section class="shm-family">
                              <header class="shm-family-header">
                                <span class="shm-family-title">${group.familyRootTicketOrPr}</span>
                                <span class="shm-family-meta"
                                  >family ${group.familyId.slice(0, 8)} · ${group.runs.length}
                                  run${group.runs.length === 1 ? '' : 's'}</span
                                >
                              </header>
                              ${group.runs.map((run) => this._renderRow(run))}
                            </section>
                          `,
                        )}
                      </div>
                    `}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'slot-history-modal': SlotHistoryModal;
  }
}
