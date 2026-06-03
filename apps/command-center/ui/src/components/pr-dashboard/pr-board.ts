import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { PRStatus } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './pr-card.js';
import '../shared/hydrating-placeholder.js';

import { gateway } from '../../gateway-client.js';
import {
  type AppState,
  getState,
  type GlobalFilters,
  isHydrating,
  markPRsRefreshFailed,
  PR_LIST_TIMEOUT_MS,
  subscribe,
  updatePRs,
} from '../../state.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { safeLsGet, safeLsSet } from '../../utils/storage.js';

import {
  matchesPrKey,
  prBoardUrlStateFromHash,
  prBoardUrlStateHash,
  prCompleteDispatchHash,
  type PRKey,
  prKeyEqual,
  type PRLayout,
} from './pr-board-url-state.js';
import { buildPRDashboardScopeSummary, filterDashboardPRs } from './pr-filters.js';

type PRSortMode = 'group' | 'date';
const PR_LAYOUT_KEY = 'farmslot:pr-layout';
const PR_SORT_KEY = 'farmslot:pr-list-sort';

function latestActivityTs(pr: PRStatus): number {
  if (pr.botComments?.length) {
    const newest = pr.botComments.reduce(
      (max, c) => Math.max(max, Date.parse(c.createdAt) || 0),
      0,
    );
    if (newest > 0) return newest;
  }
  // Fallback: PR number as a weak proxy (higher number = more recent).
  return pr.pr;
}

interface KanbanColumn {
  id: string;
  label: string;
  color: string;
  filter: (pr: PRStatus) => boolean;
}

const RECOMMENDATION_LABEL: Record<string, string> = {
  WORKING: 'Working',
  NEEDS_ATTENTION: 'Needs Attn',
  IN_REVIEW: 'In Review',
  READY: 'Ready',
  WAITING_FOR_MERGE: 'Wait Merge',
  MERGED: 'Merged',
  CLOSED_WITHOUT_MERGE: 'Closed',
};

function recommendationColor(rec: string | undefined): string {
  switch (rec) {
    case 'WORKING':
      return colors.accent;
    case 'NEEDS_ATTENTION':
      return colors.statusFail;
    case 'IN_REVIEW':
      return colors.statusWarn;
    case 'READY':
    case 'MERGED':
      return colors.statusOk;
    case 'WAITING_FOR_MERGE':
      return '#818cf8';
    default:
      return colors.textMuted;
  }
}

const COLUMNS: KanbanColumn[] = [
  {
    id: 'working',
    label: 'Working',
    color: colors.accent,
    filter: (pr) => pr.recommendation === 'WORKING',
  },
  {
    id: 'needs-attention',
    label: 'Needs Attention',
    color: colors.statusFail,
    filter: (pr) => pr.recommendation === 'NEEDS_ATTENTION',
  },
  {
    id: 'in-review',
    label: 'In Review',
    color: colors.statusWarn,
    filter: (pr) => pr.recommendation === 'IN_REVIEW',
  },
  {
    id: 'ready',
    label: 'Ready to Merge',
    color: colors.statusOk,
    filter: (pr) => pr.recommendation === 'READY',
  },
  {
    id: 'waiting-for-merge',
    label: 'Waiting for Merge',
    color: '#818cf8',
    filter: (pr) => pr.recommendation === 'WAITING_FOR_MERGE',
  },
  {
    id: 'merged',
    label: 'Merged',
    color: colors.statusOk,
    filter: (pr) => pr.recommendation === 'MERGED',
  },
  {
    id: 'closed-without-merge',
    label: 'Closed w/o Merge',
    color: colors.textMuted,
    filter: (pr) => pr.recommendation === 'CLOSED_WITHOUT_MERGE',
  },
];

@customElement('pr-board')
export class PRBoard extends LitElement {
  @state() private _prs: PRStatus[] = [];
  @state() private _loading = false;
  @state() private _lastRefreshed = 0;
  @state() private _globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private _hydrating = false;
  @state() private _bootstrapFailed = false;
  @state() private _lastRefreshError: string | null = null;
  @state() private _layout: PRLayout = safeLsGet(PR_LAYOUT_KEY) === 'list' ? 'list' : 'board';
  @state() private _sortMode: PRSortMode = safeLsGet(PR_SORT_KEY) === 'date' ? 'date' : 'group';
  // Keyed by repo+pr because PR numbers are per-repo — a multi-repo dashboard
  // can show #123 from two different repos at once. Keying on number alone
  // would misroute selection/modal state after a reload or filter change.
  @state() private _selectedPr: PRKey | null = null;
  @state() private _modalPr: PRKey | null = null;

  private _unsubState?: () => void;
  private _refreshInterval?: number;
  private _tickInterval?: number;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: ${unsafeCSS(colors.bgBase)};
    }

    .board-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.lg)};
      padding: ${unsafeCSS(spacing.lg)} ${unsafeCSS(spacing.xl)};
      background: ${unsafeCSS(colors.bgSurface)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .board-title {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeLg)};
      font-weight: 600;
      color: ${unsafeCSS(colors.textPrimary)};
    }

    .pr-count {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .pr-scope {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      white-space: nowrap;
    }

    .refresh-btn {
      margin-left: auto;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }

    .refresh-btn:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .refresh-btn.loading {
      opacity: 0.5;
      cursor: wait;
    }

    .refresh-ago {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
    }

    .rehydrating-banner {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.statusWarn)};
    }

    .kanban {
      display: flex;
      flex: 1;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)};
      overflow-x: auto;
      min-height: 0;
    }

    .column {
      flex: 1;
      min-width: 220px;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      background: ${unsafeCSS(colors.bgSurface)};
      border-radius: ${unsafeCSS(radii.md)};
      border: 1px solid #1e1e36;
      overflow: hidden;
    }

    .column-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      border-bottom: 1px solid #1e1e36;
      flex-shrink: 0;
    }

    .column-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .column-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }

    .column-count {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: auto;
    }

    .column-body {
      flex: 1;
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.md)};
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSS(spacing.md)};
    }

    .column-body::-webkit-scrollbar {
      width: 4px;
    }
    .column-body::-webkit-scrollbar-thumb {
      background: ${unsafeCSS(colors.textMuted)};
      border-radius: 2px;
    }

    .empty-col {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      text-align: center;
      padding: ${unsafeCSS(spacing.xl)};
    }

    /* ── Layout toggle ── */
    .layout-toggle {
      display: flex;
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      overflow: hidden;
    }
    .layout-toggle button {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textMuted)};
      border: none;
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.md)};
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }
    .layout-toggle button.active {
      background: ${unsafeCSS(colors.accent)}22;
      color: ${unsafeCSS(colors.accent)};
    }

    /* ── List + detail split ── */
    .split {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .split-list {
      width: 420px;
      flex-shrink: 0;
      overflow-y: auto;
      border-right: 1px solid #1e1e36;
      background: ${unsafeCSS(colors.bgSurface)};
    }
    .split-detail {
      flex: 1;
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgBase)};
    }
    .split-detail .empty-detail {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textMuted)};
      text-align: center;
      padding-top: ${unsafeCSS(spacing.xl)};
    }

    .list-row {
      display: grid;
      grid-template-columns: 60px 1fr auto auto;
      gap: ${unsafeCSS(spacing.md)};
      align-items: center;
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      border-bottom: 1px solid #1e1e36;
      cursor: pointer;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textSecondary)};
    }
    .list-row:hover {
      background: ${unsafeCSS(colors.bgCardHover)};
    }
    .list-row.selected {
      background: ${unsafeCSS(colors.accent)}14;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    .list-row .pr-num {
      color: ${unsafeCSS(colors.textMuted)};
      font-weight: 600;
    }
    .list-row .pr-title {
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .list-row .pr-slot {
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
    }
    .rec-chip {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: ${unsafeCSS(radii.sm)};
      border: 1px solid;
    }

    /* ── List toolbar (sort toggle) ── */
    .list-toolbar {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.lg)};
      border-bottom: 1px solid #1e1e36;
      background: ${unsafeCSS(colors.bgBase)};
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .list-toolbar-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: 10px;
      color: ${unsafeCSS(colors.textMuted)};
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    /* ── Group header (by-type sort mode) ── */
    .list-group-header {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.md)};
      padding: ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
      background: ${unsafeCSS(colors.bgBase)};
      border-bottom: 1px solid #2a2a44;
      border-top: 1px solid #1e1e36;
    }
    .list-group-label {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeSm)};
      color: ${unsafeCSS(colors.textPrimary)};
      font-weight: 600;
    }
    .list-group-count {
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      color: ${unsafeCSS(colors.textMuted)};
      margin-left: auto;
    }

    /* ── Modal overlay ── */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 16px;
      z-index: 1000;
    }
    .modal-panel {
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.md)};
      width: min(900px, 100%);
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      padding: ${unsafeCSS(spacing.lg)};
      position: relative;
    }
    .modal-close {
      position: absolute;
      top: ${unsafeCSS(spacing.md)};
      right: ${unsafeCSS(spacing.md)};
      background: transparent;
      border: 1px solid #2a2a44;
      color: ${unsafeCSS(colors.textMuted)};
      border-radius: ${unsafeCSS(radii.sm)};
      padding: 4px 10px;
      font-family: ${unsafeCSS(fonts.mono)};
      font-size: ${unsafeCSS(fonts.sizeXs)};
      cursor: pointer;
    }
    .modal-close:hover {
      color: ${unsafeCSS(colors.textPrimary)};
    }
  `;

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this._modalPr !== null) {
      this._modalPr = null;
    }
  };

  // Keep URL ↔ selection in sync so expanded/modal state is shareable via
  // the address bar and survives reload. Writes use history.replaceState,
  // which doesn't fire hashchange, so there is nothing to suppress here —
  // the handler only runs for genuine outside navigations.
  private _onHashChange = () => {
    this._readUrl();
  };

  private _readUrl(): void {
    const next = prBoardUrlStateFromHash(this._prs);
    if (!next) return;
    if (next.layout && this._layout !== next.layout) {
      this._layout = next.layout;
      safeLsSet(PR_LAYOUT_KEY, next.layout);
    }
    if (!prKeyEqual(this._selectedPr, next.selectedPr)) this._selectedPr = next.selectedPr;
    if (!prKeyEqual(this._modalPr, next.modalPr)) this._modalPr = next.modalPr;
  }

  private _gotoDispatchComplete(detail: { pr: number; repo?: string; project?: string }): void {
    // Intentionally no slot= hint — the ranker's targetBranch bonus picks
    // the correct slot. pr.slot is the slot currently associated with the
    // PR via run history, which is not necessarily the slot sitting on
    // the PR's branch, so emitting it here would override the ranker.
    // Preserve global filters so the wizard's fleet-filtered slot list keeps
    // the same scope the user chose on the board.
    location.hash = prCompleteDispatchHash(detail);
  }

  private _writeUrl(): void {
    const next = prBoardUrlStateHash({
      selectedPr: this._selectedPr,
      modalPr: this._modalPr,
      layout: this._layout,
    });
    if (!next || location.hash === next) return;
    history.replaceState(null, '', next);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('hashchange', this._onHashChange);
    this._readUrl();
    const initial = getState();
    this._syncState(initial);
    this._unsubState = subscribe((s) => this._syncState(s));
    // Remounting the board after a successful shared bootstrap should reuse
    // the cached prs slice rather than fan out another full PR_LIST. Only
    // self-heal immediately when the shared bootstrap for this connection
    // actually failed; otherwise freshness comes from the existing 60s poll
    // cadence or an explicit manual refresh.
    if (initial.connection === 'connected' && !this._hydrating && initial.bootstrapFailed.prs) {
      this._fetchPRs();
    }
    this._refreshInterval = window.setInterval(() => this._fetchPRs(), 60_000);
    this._tickInterval = window.setInterval(() => this.requestUpdate(), 15_000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('hashchange', this._onHashChange);
    this._unsubState?.();
    if (this._refreshInterval) window.clearInterval(this._refreshInterval);
    if (this._tickInterval) window.clearInterval(this._tickInterval);
  }

  updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (changed.has('_selectedPr') || changed.has('_modalPr')) {
      this._writeUrl();
    }
  }

  private _syncState(s: AppState) {
    const wasHydrating = this._hydrating;
    const hadPrs = this._prs.length > 0;
    this._prs = s.prs;
    this._globalFilters = s.globalFilters;
    this._hydrating = isHydrating(s, 'prs');
    this._bootstrapFailed = s.bootstrapFailed.prs;
    if (s.prsUpdatedAt > this._lastRefreshed) this._lastRefreshed = s.prsUpdatedAt;
    // Legacy URLs (bare `pr=123` without repo) can't be resolved until the
    // PR list lands. Re-run _readUrl once PRs arrive so a cold-reload on a
    // shared link still hydrates the selection.
    if (!hadPrs && this._prs.length > 0 && this._selectedPr === null) {
      this._readUrl();
    }
    // Recover from a failed bootstrap PR_LIST without waiting for the 60s
    // poll. Only fetch when the slice's bootstrap actually rejected — a
    // successful bootstrap (even one that returned zero PRs) already wrote
    // authoritative data, so skipping avoids a duplicate fan-out to GitHub.
    if (wasHydrating && !this._hydrating && s.bootstrapFailed.prs) {
      this._fetchPRs();
    }
  }

  private async _fetchPRs() {
    // Never race the shared bootstrap PR_LIST. This single gate covers
    // every caller: mount-time, hydration-complete transition, 60s poll,
    // and the manual Refresh button. `state.ts#fetchInitialState` owns
    // PR_LIST during the hydrating window and will update shared state.
    if (this._hydrating) return;
    this._loading = true;
    try {
      const result = await gateway.request<{ prs: PRStatus[] }>(
        Methods.PR_LIST,
        {},
        PR_LIST_TIMEOUT_MS,
      );
      updatePRs(result.prs);
      this._lastRefreshError = null;
      this._lastRefreshed = Date.now();
    } catch (err) {
      // Recover explicitly: retain the last known PR list but mark the slice
      // failed so the board shows the stale-data banner and retries on the
      // next poll/manual refresh instead of silently presenting old data.
      markPRsRefreshFailed();
      this._lastRefreshError = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  private _formatAgo(): string {
    if (!this._lastRefreshed) return '';
    const seconds = Math.floor((Date.now() - this._lastRefreshed) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ago`;
  }

  private _handleRefresh() {
    if (!this._loading) this._fetchPRs();
  }

  private get _filteredPRs(): PRStatus[] {
    // Drop review-only PRs (those a farmslot run never produced). The PR page
    // is a farmslot ownership surface — review runs against external PRs are
    // tracked in the run-list, not here. Also honor the global machine filter
    // by deriving the machine from the associated slot id.
    return filterDashboardPRs(this._prs, this._globalFilters);
  }

  private _renderScopeSummary() {
    const scope = buildPRDashboardScopeSummary(this._prs, this._globalFilters);
    const summary = scope.summary;
    return html`<span class="pr-scope" title=${summary}>${summary}</span>`;
  }

  private _setLayout(layout: PRLayout) {
    this._layout = layout;
    safeLsSet(PR_LAYOUT_KEY, layout);
    this._writeUrl();
  }

  private _setSortMode(mode: PRSortMode) {
    this._sortMode = mode;
    safeLsSet(PR_SORT_KEY, mode);
  }

  private _renderListRow(pr: PRStatus) {
    const selected = matchesPrKey(pr, this._selectedPr);
    const color = recommendationColor(pr.recommendation);
    const label = RECOMMENDATION_LABEL[pr.recommendation ?? ''] ?? pr.recommendation ?? '—';
    return html`
      <div
        class="list-row ${selected ? 'selected' : ''}"
        @click=${() => {
          this._selectedPr = { repo: pr.repo, pr: pr.pr };
        }}
      >
        <span class="pr-num">#${pr.pr}</span>
        <span class="pr-title" title=${pr.title ?? ''}>${pr.title ?? '(no title)'}</span>
        <span class="pr-slot">${pr.slot ?? ''}</span>
        <span class="rec-chip" style="color:${color}; border-color:${color}">${label}</span>
      </div>
    `;
  }

  private _renderList(filtered: PRStatus[]) {
    const selectedPr = filtered.find((p) => matchesPrKey(p, this._selectedPr)) ?? null;
    let body;
    if (filtered.length === 0) {
      body = html`<div class="empty-col">No PRs</div>`;
    } else if (this._sortMode === 'date') {
      const sorted = [...filtered].sort((a, b) => latestActivityTs(b) - latestActivityTs(a));
      body = sorted.map((pr) => this._renderListRow(pr));
    } else {
      body = html`${COLUMNS.map((col) => {
        const prs = filtered.filter(col.filter);
        if (prs.length === 0) return nothing;
        return html`
          <div class="list-group-header">
            <span class="column-dot" style="background:${col.color}"></span>
            <span class="list-group-label">${col.label}</span>
            <span class="list-group-count">${prs.length}</span>
          </div>
          ${prs.map((pr) => this._renderListRow(pr))}
        `;
      })}`;
    }
    return html`
      <div class="split">
        <div class="split-list">
          <div class="list-toolbar">
            <span class="list-toolbar-label">Sort:</span>
            <div class="layout-toggle">
              <button
                class="${this._sortMode === 'group' ? 'active' : ''}"
                @click=${() => this._setSortMode('group')}
              >
                By type
              </button>
              <button
                class="${this._sortMode === 'date' ? 'active' : ''}"
                @click=${() => this._setSortMode('date')}
              >
                By date
              </button>
            </div>
          </div>
          ${body}
        </div>
        <div
          class="split-detail"
          @pr-dispatch-fix=${(e: CustomEvent) => this._gotoDispatchComplete(e.detail)}
        >
          ${selectedPr
            ? html`<pr-card .pr=${selectedPr} .forceExpanded=${true}></pr-card>`
            : html`<div class="empty-detail">Select a PR to see details</div>`}
        </div>
      </div>
    `;
  }

  private _renderBoard(filtered: PRStatus[]) {
    return html`
      <div class="kanban">
        ${COLUMNS.map((col) => {
          const prs = filtered.filter(col.filter);
          return html`
            <div class="column">
              <div class="column-header">
                <span class="column-dot" style="background:${col.color}"></span>
                <span class="column-label">${col.label}</span>
                <span class="column-count">${prs.length}</span>
              </div>
              <div
                class="column-body"
                @pr-dispatch-fix=${(e: CustomEvent) => this._gotoDispatchComplete(e.detail)}
              >
                ${prs.length > 0
                  ? prs.map((pr) => html`<pr-card .pr=${pr}></pr-card>`)
                  : html`<div class="empty-col">None</div>`}
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }

  private _renderModal(filtered: PRStatus[]) {
    if (this._modalPr === null) return nothing;
    const pr =
      filtered.find((p) => matchesPrKey(p, this._modalPr)) ??
      this._prs.find((p) => matchesPrKey(p, this._modalPr)) ??
      null;
    if (!pr) return nothing;
    return html`
      <div
        class="modal-backdrop"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this._modalPr = null;
        }}
        @pr-dispatch-fix=${(e: CustomEvent) => {
          this._gotoDispatchComplete(e.detail);
          this._modalPr = null;
        }}
      >
        <div class="modal-panel">
          <button
            class="modal-close"
            @click=${() => {
              this._modalPr = null;
            }}
          >
            Close (Esc)
          </button>
          <pr-card .pr=${pr} .forceExpanded=${true}></pr-card>
        </div>
      </div>
    `;
  }

  render() {
    const filtered = this._filteredPRs;
    const initialLoading = this._hydrating && this._prs.length === 0;
    return html`
      <div class="board-header">
        <span class="board-title">PR Dashboard</span>
        <span class="pr-count">${filtered.length} PR${filtered.length !== 1 ? 's' : ''}</span>
        ${this._renderScopeSummary()}
        ${this._bootstrapFailed && this._prs.length > 0
          ? html`<span
              class="rehydrating-banner"
              title=${this._lastRefreshError ?? 'PR refresh failed'}
              >Refresh failed… showing cached PRs</span
            >`
          : this._hydrating && this._prs.length > 0
            ? html`<span class="rehydrating-banner">Reconnecting… showing last snapshot</span>`
            : ''}
        ${this._lastRefreshed ? html`<span class="refresh-ago">${this._formatAgo()}</span>` : ''}
        <div class="layout-toggle" style="margin-left:auto">
          <button
            class="${this._layout === 'board' ? 'active' : ''}"
            @click=${() => this._setLayout('board')}
          >
            Board
          </button>
          <button
            class="${this._layout === 'list' ? 'active' : ''}"
            @click=${() => this._setLayout('list')}
          >
            List
          </button>
        </div>
        <button class="refresh-btn ${this._loading ? 'loading' : ''}" @click=${this._handleRefresh}>
          ${this._loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      <div
        @pr-open-modal=${(e: CustomEvent) => {
          this._modalPr = { repo: e.detail.repo, pr: e.detail.pr };
        }}
        style="display:contents"
      >
        ${initialLoading
          ? html`<farm-hydrating message="Loading PRs…"></farm-hydrating>`
          : this._bootstrapFailed && this._prs.length === 0
            ? html` <farm-hydrating
                message="PR refresh failed. No cached PRs available."
              ></farm-hydrating>`
            : this._layout === 'list'
              ? this._renderList(filtered)
              : this._renderBoard(filtered)}
      </div>
      ${this._renderModal(filtered)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pr-board': PRBoard;
  }
}
