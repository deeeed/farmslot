import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { PRRulePreview, PRRuleSubject, PRStatus } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import './pr-card.js';
import './pr-automation-panel.js';
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
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import {
  renderWorkInventoryBackButton,
  workInventoryTableStyles,
} from '../shared/work-inventory-table.js';

import type { PRAutomationInventory, PRAutomationPanel } from './pr-automation-panel.js';
import {
  matchesPrKey,
  prBoardUrlStateFromHash,
  prBoardUrlStateHash,
  prCompleteDispatchHash,
  type PRKey,
  prKeyEqual,
  type PRLayout,
} from './pr-board-url-state.js';
import { buildPRDashboardScopeSummary } from './pr-filters.js';
import { prReviewReadiness, reviewRunLabel } from './pr-review-status.js';
import {
  buildPRWorkspaceEntries,
  type PRPane,
  type PRScope,
  type PRSection,
  type PRWorkspaceEntry,
  prWorkspaceKey,
  prWorkspaceNavigation,
} from './pr-workspace.js';
import { prWorkspaceStyles } from './pr-workspace-styles.js';

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
      return colors.accentHover;
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
      return colors.textSecondary;
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
  @state() private _automationEditing = false;
  @state() private _inventory: PRAutomationInventory = {
    monitors: { monitors: [] },
    reviews: { teams: [], rules: [], intents: [] },
    projectConfigs: [],
    error: '',
    loading: true,
  };
  @state() private _section: PRSection = 'prs';
  @state() private _scope: PRScope = 'all';
  @state() private _pane: PRPane = 'overview';
  @state() private _showHistory = false;
  @state() private _details = new Map<string, PRStatus>();
  @state() private _reviewLookups = new Map<
    string,
    { context: string; loading: boolean; subject?: PRRuleSubject; error?: string }
  >();
  @state() private _detailError = '';
  @state() private _detailLoading = false;
  private _detailRequestKey = '';
  private _detailEpoch = gateway.connectionEpoch;
  private _detailSerial = 0;
  private _didInitialUpdate = false;
  @state() private _loading = false;
  @state() private _lastRefreshed = 0;
  @state() private _globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private _hydrating = false;
  @state() private _bootstrapFailed = false;
  @state() private _lastRefreshError: string | null = null;
  @state() private _layout: PRLayout = safeLsGet(PR_LAYOUT_KEY) === 'board' ? 'board' : 'list';
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
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      background: ${unsafeCSS(colors.bgBase)};
    }

    .board-header {
      display: flex;
      flex-wrap: wrap;
      min-width: 0;
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
      white-space: normal;
      overflow-wrap: anywhere;
    }
    pr-automation-panel {
      min-width: 0;
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
    .split-list {
      width: 420px;
      flex-shrink: 0;
      overflow-y: auto;
      border-right: 1px solid #1e1e36;
      background: ${unsafeCSS(colors.bgSurface)};
    }
    .split-detail {
      flex: 1;
      min-width: 0;
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

    ${workInventoryTableStyles}
    ${prWorkspaceStyles}
  `;

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this._modalPr !== null) {
      this._modalPr = null;
    } else if (
      e.key === 'Escape' &&
      !e.defaultPrevented &&
      !this._automationEditing &&
      this._section !== 'automation' &&
      this._selectedPr
    ) {
      this._navigate({ selected: null });
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
    const next = prBoardUrlStateFromHash(this._entries.map((entry) => entry.key));
    if (!next) return;
    const navigation = prWorkspaceNavigation(location.hash);
    this._section = navigation.section;
    this._scope = navigation.scope;
    this._pane = navigation.pane;
    this._showHistory = navigation.history;
    const sort = parseHashRoute().params.get('prSort');
    if (sort === 'date' || sort === 'group') this._sortMode = sort;
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

  private _writeUrl(push = false, closeEditor = false): void {
    const next = prBoardUrlStateHash({
      selectedPr: this._selectedPr,
      modalPr: this._modalPr,
      layout: this._layout,
    });
    if (!next) return;
    const { params } = parseHashRoute(next);
    params.set('prSection', this._section);
    params.set('prScope', this._scope);
    params.set('prPane', this._pane);
    params.set('prSort', this._sortMode);
    params.set('layout', this._layout);
    if (this._showHistory) params.set('prHistory', '1');
    else params.delete('prHistory');
    if (closeEditor) for (const key of ['prEditor', 'prTarget', 'prDraft']) params.delete(key);
    if (
      this._section === 'automation' &&
      !['rules', 'policies', 'attention'].includes(params.get('prTab') ?? '')
    )
      params.set('prTab', 'rules');
    const url = buildHash('prs', params);
    if (location.hash === url) return;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('hashchange', this._onHashChange);
    window.addEventListener('popstate', this._onHashChange);
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
    this._refreshInterval = window.setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        !this._automationEditing &&
        this._section === 'prs' &&
        this._scope === 'all'
      )
        void this._fetchPRs();
    }, 60_000);
    this._tickInterval = window.setInterval(() => this.requestUpdate(), 15_000);
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this._onHashChange);
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('hashchange', this._onHashChange);
    this._unsubState?.();
    if (this._refreshInterval) window.clearInterval(this._refreshInterval);
    if (this._tickInterval) window.clearInterval(this._tickInterval);
  }

  updated(changed: Map<string, unknown>) {
    super.updated(changed);
    const canWrite = this._didInitialUpdate;
    this._didInitialUpdate = true;
    if (
      canWrite &&
      ['_selectedPr', '_modalPr', '_section', '_scope', '_pane', '_showHistory', '_sortMode'].some(
        (key) => changed.has(key),
      )
    ) {
      this._writeUrl();
    }
    void this._ensureSelectedDetails();
    void this._ensureReviewObservation();
    if (this._section === 'reviews' && !this._automationEditing) {
      // Fill legacy rows once, with at most two read-only lookups at a time.
      for (const entry of this._visibleEntries) {
        if ([...this._reviewLookups.values()].filter((item) => item.loading).length >= 2) break;
        if (!entry.reviewObservations.length) void this._ensureReviewObservation(entry);
      }
    }
    if (
      (changed.has('_selectedPr') || changed.has('_automationEditing')) &&
      this._section !== 'automation'
    ) {
      if (this._selectedPr || this._automationEditing) {
        this.renderRoot.querySelector<HTMLElement>('.split-detail')?.focus({ preventScroll: true });
      } else {
        const previous = changed.get('_selectedPr') as PRKey | null;
        const row = [...this.renderRoot.querySelectorAll<HTMLElement>('[data-pr-key]')].find(
          (el) => previous && el.dataset.prKey === prWorkspaceKey(previous),
        );
        const trigger = this.renderRoot.querySelector<HTMLElement>(
          this._section === 'reviews'
            ? '[data-testid="pr-workspace-request-review"]'
            : '[data-testid="pr-workspace-add-monitor"]',
        );
        (row ?? trigger)?.focus({ preventScroll: true });
      }
    }
  }

  private _syncState(s: AppState) {
    if (this._detailEpoch !== gateway.connectionEpoch) {
      this._detailEpoch = gateway.connectionEpoch;
      this._details = new Map();
      this._reviewLookups = new Map();
      this._inventory = {
        monitors: { monitors: [] },
        reviews: { teams: [], rules: [], intents: [] },
        projectConfigs: [],
        error: '',
        loading: true,
      };
      this._detailRequestKey = '';
      this._detailError = '';
      this._detailLoading = false;
      this._detailSerial++;
    }
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
    if (this._hydrating || this._loading) return;
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
    if (!this._loading) {
      this._details = new Map();
      this._detailRequestKey = '';
      this._detailSerial++;
      this._detailLoading = false;
      void this._fetchPRs();
    }
  }

  private _renderScopeSummary() {
    const scope = buildPRDashboardScopeSummary(this._prs, this._globalFilters);
    const summary = scope.scopeLabel;
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

  private get _entries(): PRWorkspaceEntry[] {
    const entries = buildPRWorkspaceEntries(
      this._prs,
      this._inventory.monitors.monitors,
      this._inventory.reviews.intents,
      this._inventory.reviews.submissions ?? [],
      this._inventory.projectConfigs,
      this._globalFilters,
      this._showHistory,
      [...this._details.values()],
    );
    for (const entry of entries) {
      const cached = this._reviewLookups.get(prWorkspaceKey(entry.key));
      if (cached?.context !== this._reviewContext(entry)?.key || !cached?.subject) continue;
      const subject = cached.subject;
      if (
        entry.reviewObservations.some(
          (observation) => Date.parse(observation.observedAt) > Date.parse(subject.observedAt),
        )
      )
        continue;
      entry.title = subject.title;
      const author = subject.facts.author;
      if (author?.state === 'known' && typeof author.value === 'string')
        entry.author = author.value;
      if (subject.reviewObservation) entry.reviewObservations.push(subject.reviewObservation);
    }
    return entries;
  }
  private get _visibleEntries() {
    return this._entries.filter((entry) =>
      this._section === 'reviews'
        ? entry.reviews.length || entry.requests.length
        : this._scope === 'monitored'
          ? entry.monitors.length
          : true,
    );
  }
  private get _selectedEntry() {
    return this._visibleEntries.find((entry) => prKeyEqual(entry.key, this._selectedPr));
  }
  private _navigate(patch: {
    section?: PRSection;
    scope?: PRScope;
    pane?: PRPane;
    history?: boolean;
    selected?: PRKey | null;
  }) {
    this.renderRoot.querySelector<PRAutomationPanel>('pr-automation-panel')?.closeEditor();
    if (patch.section !== undefined && patch.section !== this._section) this._selectedPr = null;
    if (patch.section !== undefined) this._section = patch.section;
    if (patch.scope !== undefined) this._scope = patch.scope;
    if (patch.pane !== undefined) this._pane = patch.pane;
    else if (patch.section === 'reviews') this._pane = 'review';
    else if (patch.section === 'prs')
      this._pane = this._scope === 'monitored' ? 'monitoring' : 'overview';
    else if (patch.scope === 'monitored') this._pane = 'monitoring';
    else if (patch.scope === 'all') this._pane = 'overview';
    if (patch.history !== undefined) this._showHistory = patch.history;
    if (patch.selected !== undefined) this._selectedPr = patch.selected;
    if ((patch.scope !== undefined || patch.history !== undefined) && !this._selectedEntry)
      this._selectedPr = null;
    this._modalPr = null;
    this._detailError = '';
    this._writeUrl(true, true);
    void this.updateComplete.then(() => {
      const pane = this.renderRoot.querySelector('.split-detail');
      if (pane) pane.scrollTop = 0;
    });
  }
  private _receiveInventory(inventory: PRAutomationInventory) {
    this._inventory = inventory;
    if (!this._selectedPr) {
      const params = parseHashRoute().params;
      const monitor = ['monitor', 'repair'].includes(params.get('prEditor') ?? '')
        ? inventory.monitors.monitors.find((m) => m.id === params.get('prTarget'))
        : undefined;
      if (monitor)
        this._selectedPr = {
          repo: monitor.config.pr.repo,
          pr: monitor.config.pr.number,
          host: monitor.config.pr.host,
        };
      else this._readUrl();
    }
  }
  private _automationNavigation() {
    this._showHistory = parseHashRoute().params.get('prHistory') === '1';
    this._writeUrl();
    this._readUrl();
  }
  private _reviewContext(entry: PRWorkspaceEntry) {
    const review = entry.reviews.find((review) =>
      review.contributions.some((source) => source.ruleId),
    );
    const contribution = review?.contributions.find((source) => source.ruleId);
    const rule = this._inventory.reviews.rules.find((rule) => rule.id === contribution?.ruleId);
    const team = this._inventory.reviews.teams.find((team) => team.id === rule?.config.teamId);
    return rule && team
      ? { rule, key: `${rule.id}:${rule.revision}:${team.revision}:${review?.headSha}` }
      : undefined;
  }
  private _reviewLoading(entry: PRWorkspaceEntry) {
    const context = this._reviewContext(entry);
    const lookup = this._reviewLookups.get(prWorkspaceKey(entry.key));
    return !!context && (lookup?.context !== context.key || lookup.loading);
  }
  private async _ensureReviewObservation(entry = this._selectedEntry) {
    if (
      !entry ||
      (this._section !== 'reviews' && this._pane !== 'review') ||
      this._automationEditing ||
      gateway.connectionState !== 'connected'
    )
      return;
    const context = this._reviewContext(entry);
    if (!context) return;
    const key = prWorkspaceKey(entry.key);
    if (this._reviewLookups.get(key)?.context === context.key) return;
    if ([...this._reviewLookups.values()].filter((item) => item.loading).length >= 2) return;
    const pending = { context: context.key, loading: true };
    const epoch = gateway.connectionEpoch;
    this._reviewLookups = new Map(this._reviewLookups).set(key, pending);
    try {
      const result = await gateway.request<{ preview: PRRulePreview }>(
        Methods.PR_RULE_PREVIEW,
        {
          id: context.rule.id,
          pr: { host: entry.key.host ?? 'github.com', repo: entry.key.repo, number: entry.key.pr },
        },
        PR_LIST_TIMEOUT_MS,
      );
      if (epoch !== gateway.connectionEpoch || this._reviewLookups.get(key) !== pending) return;
      const subject = result.preview.items.find(
        (item) =>
          prWorkspaceKey({
            host: item.subject.pr.host,
            repo: item.subject.pr.repo,
            pr: item.subject.pr.number,
          }) === key,
      )?.subject;
      if (!subject?.reviewObservation)
        throw new Error(
          result.preview.sourceErrors.join('; ') || 'GitHub review status is unavailable.',
        );
      this._reviewLookups = new Map(this._reviewLookups).set(key, {
        context: context.key,
        loading: false,
        subject,
      });
    } catch (error) {
      if (epoch !== gateway.connectionEpoch || this._reviewLookups.get(key) !== pending) return;
      this._reviewLookups = new Map(this._reviewLookups).set(key, {
        context: context.key,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private _renderReviewStatus(entry: PRWorkspaceEntry) {
    const status = prReviewReadiness(entry);
    const lookup = this._reviewLookups.get(prWorkspaceKey(entry.key));
    const pending = this._reviewLoading(entry);
    return html`<div
      class="review-status-summary"
      data-testid="pr-review-readiness"
      data-review-group=${status.group}
    >
      <strong class=${`review-tone-${status.tone}`}>${status.label}</strong>
      <span>${status.personal}</span>
      <p>${status.detail}</p>
      ${status.observation
        ? html`<span class="pr-author"
            >Checked ${new Date(status.observation.observedAt).toLocaleString()}</span
          >`
        : nothing}
      ${lookup?.error ? html`<p class="pr-author">Could not refresh: ${lookup.error}</p>` : nothing}
      ${this._reviewContext(entry)
        ? html`<button
            data-testid="pr-review-status-refresh"
            ?disabled=${pending}
            @click=${() => {
              const next = new Map(this._reviewLookups);
              next.delete(prWorkspaceKey(entry.key));
              this._reviewLookups = next;
              void this._ensureReviewObservation();
            }}
          >
            ${pending ? 'Checking review status…' : 'Refresh review status'}
          </button>`
        : nothing}
    </div>`;
  }
  private async _ensureSelectedDetails() {
    const entry = this._selectedEntry;
    if (
      this._section === 'automation' ||
      (this._pane !== 'overview' && !!entry?.author) ||
      !entry ||
      entry.status ||
      this._hydrating ||
      this._loading ||
      gateway.connectionState !== 'connected'
    )
      return;
    const key = prWorkspaceKey(entry.key);
    if (this._detailRequestKey === key && (this._detailLoading || this._detailError)) return;
    this._detailRequestKey = key;
    this._detailError = '';
    const project = this._inventory.projectConfigs.find(
      (p) => p.name === entry.project && p.ci.repo?.toLowerCase() === entry.key.repo.toLowerCase(),
    );
    if (!project || (entry.key.host ?? 'github.com').toLowerCase() !== 'github.com') {
      this._detailLoading = false;
      this._detailError =
        'The full viewer needs a matching Farmslot project. Monitoring and review controls are available in their tabs.';
      return;
    }
    const serial = ++this._detailSerial;
    const epoch = gateway.connectionEpoch;
    this._detailLoading = true;
    try {
      const result = await gateway.request<{ pr: PRStatus }>(
        Methods.PR_STATUS,
        { pr: entry.key.pr, project: project.name },
        PR_LIST_TIMEOUT_MS,
      );
      if (epoch !== gateway.connectionEpoch || serial !== this._detailSerial) return;
      if (!matchesPrKey(result.pr, entry.key))
        throw new Error('The gateway returned a different PR; its details were not displayed.');
      this._details = new Map(this._details).set(key, result.pr);
    } catch (error) {
      if (
        epoch === gateway.connectionEpoch &&
        serial === this._detailSerial &&
        this._selectedPr &&
        prWorkspaceKey(this._selectedPr) === key
      )
        this._detailError = error instanceof Error ? error.message : String(error);
    } finally {
      if (serial === this._detailSerial) this._detailLoading = false;
    }
  }
  private _renderListRow(entry: PRWorkspaceEntry) {
    const selected = prKeyEqual(entry.key, this._selectedPr);
    const monitor = entry.monitors.find((item) => item.lifecycle === 'active') ?? entry.monitors[0];
    const review = entry.reviews[0];
    const working = entry.monitors.some((m) => m.activeRuns?.length);
    const issues = new Set(
      entry.monitors.flatMap((m) => m.incidents.filter((i) => !i.resolvedAt).map((i) => i.id)),
    ).size;
    const readiness = prReviewReadiness(entry);
    const label =
      this._section === 'reviews'
        ? `Run: ${readiness.blockedReason && !review?.runId ? 'Not needed' : reviewRunLabel(review?.status)}`
        : working
          ? 'Work ongoing'
          : monitor
            ? monitor.lifecycle !== 'active'
              ? monitor.lifecycle
              : issues
                ? `${issues} issues`
                : 'Monitored'
            : (RECOMMENDATION_LABEL[entry.status?.recommendation ?? ''] ?? 'Tracked');
    const color =
      this._section === 'reviews'
        ? colors.textSecondary
        : working
          ? colors.statusWarn
          : monitor
            ? colors.accentHover
            : recommendationColor(entry.status?.recommendation);
    return html`<button
      class="list-row ${selected ? 'selected' : ''}"
      data-testid="pr-workspace-row"
      data-pr-key=${prWorkspaceKey(entry.key)}
      data-monitor-ids=${entry.monitors.map((monitor) => monitor.id).join(' ')}
      data-review-ids=${entry.reviews.map((review) => review.id).join(' ')}
      aria-pressed=${String(selected)}
      @click=${() => this._navigate({ selected: selected ? null : entry.key })}
    >
      <span class="list-row-main"
        ><span class="pr-num">${entry.key.repo}#${entry.key.pr}</span
        ><span class="pr-title">${entry.title}</span
        ><span class="pr-author" data-testid="pr-row-author"
          >${entry.author ? `by @${entry.author}` : 'Author unavailable'}</span
        ></span
      >
      <span class="pr-row-statuses">
        ${this._section === 'reviews'
          ? html`<span
                class=${`review-badge review-tone-${readiness.tone}`}
                data-testid="pr-row-review-status"
                title=${readiness.detail}
                >${readiness.label}</span
              ><span class="pr-author">${readiness.personal}</span>`
          : nothing}
        <span class="rec-chip" style="color:${color};border-color:${color}">${label}</span>
      </span>
    </button>`;
  }
  private _renderListContent(entries: PRWorkspaceEntry[]) {
    if (!entries.length)
      return html`<p class="empty-col">
        ${this._inventory.loading ? 'Loading PRs…' : 'No PRs match this view.'}
      </p>`;
    if (this._section === 'reviews' && this._sortMode === 'group') {
      return (
        [
          'Needs review',
          'Changes requested',
          'Approved',
          'Not ready for review',
          'Review status unknown',
        ] as const
      ).map((group) => {
        const rows = entries.filter((entry) => prReviewReadiness(entry).group === group);
        return rows.length
          ? html`<div class="list-group-header">
                <span>${group}</span><span class="list-group-count">${rows.length}</span>
              </div>
              ${rows.map((entry) => this._renderListRow(entry))}`
          : nothing;
      });
    }
    if (this._sortMode === 'date')
      return [...entries]
        .sort((a, b) => {
          const activity = (entry: PRWorkspaceEntry) =>
            entry.status
              ? latestActivityTs(entry.status)
              : Date.parse(
                  entry.reviews[0]?.updatedAt ?? entry.monitors[0]?.observation?.checkedAt ?? '',
                ) || entry.key.pr;
          return activity(b) - activity(a);
        })
        .map((entry) => this._renderListRow(entry));
    const other = entries.filter(
      (entry) => !entry.status || !COLUMNS.some((col) => col.filter(entry.status!)),
    );
    return html`${COLUMNS.map((col) => {
      const rows = entries.filter((entry) => entry.status && col.filter(entry.status));
      return rows.length
        ? html`<div class="list-group-header">
              <span class="column-dot" style="background:${col.color}"></span
              ><span class="list-group-label">${col.label}</span
              ><span class="list-group-count">${rows.length}</span>
            </div>
            ${rows.map((entry) => this._renderListRow(entry))}`
        : nothing;
    })}${other.length
      ? html`<div class="list-group-header">Other tracked PRs</div>
          ${other.map((entry) => this._renderListRow(entry))}`
      : nothing}`;
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
    const entries = this._visibleEntries;
    const selected = this._selectedEntry;
    const management = this._section === 'automation';
    return html`
      <header class="board-header">
        <span class="board-title">Pull requests</span>
        <span class="pr-count">${entries.length} PRs</span>${this._renderScopeSummary()}${this
          ._lastRefreshed
          ? html`<span class="refresh-ago">${this._formatAgo()}</span>`
          : nothing}
        ${this._bootstrapFailed
          ? html`<span class="rehydrating-banner"
              >${this._lastRefreshError ?? 'PR refresh unavailable'} · showing available data</span
            >`
          : nothing}
        ${this._inventory.error
          ? html`<span class="rehydrating-banner">${this._inventory.error}</span>`
          : nothing}
        ${management
          ? nothing
          : html`<button
              class="refresh-btn ${this._loading ? 'loading' : ''}"
              @click=${this._handleRefresh}
            >
              ${this._loading ? 'Refreshing…' : 'Refresh PRs'}
            </button>`}
      </header>
      <nav class="workspace-nav" aria-label="PR sections">
        <button
          data-testid="pr-workspace-prs"
          aria-current=${this._section === 'prs' ? 'page' : nothing}
          @click=${() => this._navigate({ section: 'prs' })}
        >
          PRs
        </button>
        <button
          data-testid="pr-automation-tab-reviews"
          aria-current=${this._section === 'reviews' ? 'page' : nothing}
          @click=${() => this._navigate({ section: 'reviews' })}
        >
          Reviews
        </button>
        <button
          data-testid="pr-workspace-automation"
          aria-current=${management ? 'page' : nothing}
          @click=${() => this._navigate({ section: 'automation' })}
        >
          Automation
        </button>
      </nav>
      ${management
        ? nothing
        : html`<div
            class="workspace-toolbar ${this._selectedPr || this._automationEditing
              ? 'detail-active'
              : ''}"
          >
            ${this._section === 'prs'
              ? html`
                  <button
                    data-testid="pr-scope-all"
                    aria-pressed=${String(this._scope === 'all')}
                    @click=${() => this._navigate({ scope: 'all' })}
                  >
                    All PRs
                  </button>
                  <button
                    data-testid="pr-automation-tab-monitors"
                    aria-pressed=${String(this._scope === 'monitored')}
                    @click=${() => this._navigate({ scope: 'monitored' })}
                  >
                    Monitored
                  </button>
                  <button
                    data-testid="pr-workspace-add-monitor"
                    @click=${() =>
                      this.renderRoot
                        .querySelector<PRAutomationPanel>('pr-automation-panel')
                        ?.openMonitor()}
                  >
                    Add monitoring
                  </button>
                `
              : html`<button
                  data-testid="pr-workspace-request-review"
                  @click=${() =>
                    this.renderRoot
                      .querySelector<PRAutomationPanel>('pr-automation-panel')
                      ?.openRequest()}
                >
                  Request review / QA
                </button>`}
            <label
              ><input
                type="checkbox"
                .checked=${this._showHistory}
                @change=${(event: Event) =>
                  this._navigate({ history: (event.target as HTMLInputElement).checked })}
              />
              Show history</label
            >
            ${this._section === 'prs'
              ? html`<span class="layout-toggle">
                  <button
                    aria-pressed=${String(this._layout === 'list')}
                    @click=${() => this._setLayout('list')}
                  >
                    List
                  </button>
                  <button
                    aria-pressed=${String(this._layout === 'board')}
                    @click=${() => this._setLayout('board')}
                  >
                    Board
                  </button>
                </span>`
              : nothing}
          </div>`}
      <div
        class="workspace ${management ? 'management' : ''} ${this._selectedPr ||
        this._automationEditing
          ? 'has-selection'
          : ''} ${this._layout === 'board' && this._section === 'prs' ? 'board-layout' : ''}"
        data-testid="pr-workspace"
      >
        <div class="split-list" data-testid="pr-workspace-list">
          <div class="list-toolbar">
            <span class="list-toolbar-label">Sort</span>
            <div class="layout-toggle">
              <button
                aria-pressed=${String(this._sortMode === 'group')}
                @click=${() => this._setSortMode('group')}
              >
                By status
              </button>
              <button
                aria-pressed=${String(this._sortMode === 'date')}
                @click=${() => this._setSortMode('date')}
              >
                By activity
              </button>
            </div>
          </div>
          ${this._layout === 'board' && this._section === 'prs'
            ? html`<div
                @pr-open-modal=${(event: CustomEvent) =>
                  this._navigate({
                    selected: prKeyEqual(this._selectedPr, {
                      repo: event.detail.repo,
                      pr: event.detail.pr,
                    })
                      ? null
                      : { repo: event.detail.repo, pr: event.detail.pr },
                    pane: 'overview',
                  })}
              >
                ${this._renderBoard(
                  entries.flatMap((entry) => (entry.status ? [entry.status] : [])),
                )}${entries
                  .filter((entry) => !entry.status)
                  .map((entry) => this._renderListRow(entry))}
              </div>`
            : this._renderListContent(entries)}
        </div>
        <div
          class="split-detail"
          data-testid="pr-workspace-detail"
          role="region"
          aria-label="PR details and actions"
          tabindex="-1"
          @pr-open-modal=${(event: CustomEvent) => {
            this._modalPr = { repo: event.detail.repo, pr: event.detail.pr };
          }}
          @pr-dispatch-fix=${(event: CustomEvent) => this._gotoDispatchComplete(event.detail)}
        >
          ${management
            ? nothing
            : html`<div class="detail-header">
                ${renderWorkInventoryBackButton({
                  label: 'Close details · Back to PR list',
                  testId: 'pr-workspace-back',
                  onBack: () => this._navigate({ selected: null }),
                })}
                ${selected
                  ? html`<h2 title=${selected.title}>${selected.title}</h2>
                      <p class="pr-count">
                        <a
                          href=${`https://${selected.key.host ?? 'github.com'}/${selected.key.repo}/pull/${selected.key.pr}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          >${selected.key.repo}#${selected.key.pr}</a
                        >
                      </p>
                      <p class="pr-author" data-testid="pr-detail-author">
                        ${selected.author
                          ? html`Author
                              <a
                                href=${`https://${selected.key.host ?? 'github.com'}/${encodeURIComponent(selected.author)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                >@${selected.author}</a
                              >`
                          : this._detailLoading
                            ? 'Loading author…'
                            : 'Author unavailable'}
                      </p>
                      ${this._pane === 'review' ? this._renderReviewStatus(selected) : nothing}
                      <div class="detail-tabs" role="tablist" aria-label="Selected PR">
                        ${(['overview', 'monitoring', 'review'] as const).map(
                          (pane) =>
                            html`<button
                              role="tab"
                              data-testid=${`pr-detail-${pane}`}
                              aria-selected=${String(this._pane === pane)}
                              @click=${() => this._navigate({ pane })}
                            >
                              ${{
                                overview: 'Overview',
                                monitoring: 'Monitoring',
                                review: 'Review',
                              }[pane]}
                            </button>`,
                        )}
                      </div>`
                  : nothing}
              </div>`}
          ${!management && !this._automationEditing && this._pane === 'overview' && selected
            ? selected.status
              ? html`<pr-card .pr=${selected.status} .forceExpanded=${true}></pr-card>`
              : html`<p class="pr-count">
                    ${this._detailLoading
                      ? 'Loading PR details…'
                      : this._detailError || 'PR details are not available yet.'}
                  </p>
                  <a
                    href=${`https://${selected.key.host ?? 'github.com'}/${selected.key.repo}/pull/${selected.key.pr}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    >Open PR on GitHub</a
                  >${this._detailError
                    ? html`<button
                        @click=${() => {
                          this._detailRequestKey = '';
                          void this._ensureSelectedDetails();
                        }}
                      >
                        Retry details
                      </button>`
                    : nothing}`
            : nothing}
          ${!management && !selected && !this._automationEditing
            ? html`<p class="empty-detail">
                ${this._selectedPr
                  ? 'This PR is not in the current view. Change filters or select another PR.'
                  : 'Select a PR to view its details and actions.'}
              </p>`
            : nothing}
          <pr-automation-panel
            style=${!management && this._pane === 'overview' && !this._automationEditing
              ? 'display:none'
              : ''}
            .mode=${management ? 'management' : 'context'}
            .pane=${this._pane}
            .selectedPr=${selected?.key ?? null}
            .selectedProject=${selected?.project ?? ''}
            .reviewBlockedReason=${selected
              ? this._reviewLookups.get(prWorkspaceKey(selected.key))?.error
                ? 'Review status could not be checked; refresh before starting.'
                : (prReviewReadiness(selected).blockedReason ?? '')
              : ''}
            .reviewStatusLoading=${!!selected && this._reviewLoading(selected)}
            .showHistory=${this._showHistory}
            @pr-automation-inventory=${(event: CustomEvent<PRAutomationInventory>) =>
              this._receiveInventory(event.detail)}
            @pr-automation-select=${(
              event: CustomEvent<{ key: PRKey; pane: 'monitoring' | 'review' }>,
            ) =>
              this._navigate({
                section: event.detail.pane === 'review' ? 'reviews' : 'prs',
                scope: event.detail.pane === 'monitoring' ? 'monitored' : this._scope,
                pane: event.detail.pane,
                selected: event.detail.key,
              })}
            @pr-automation-navigation=${() => this._automationNavigation()}
            @pr-automation-editing=${(event: CustomEvent<boolean>) => {
              this._automationEditing = event.detail;
            }}
          ></pr-automation-panel>
        </div>
      </div>
      ${this._renderModal(this._entries.flatMap((entry) => (entry.status ? [entry.status] : [])))}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pr-board': PRBoard;
  }
}
