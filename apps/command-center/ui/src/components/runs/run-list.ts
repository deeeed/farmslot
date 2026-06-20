import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import type {
  PRStatus,
  Run,
  RunArchiveResult,
  RunBulkDeleteResult,
  RunCleanupResult,
  RunEvidenceSummary,
  RunFamilyReadinessSummary,
  RunRehydratePrNumberResult,
} from '@farmslot/protocol';
import { Methods, summarizeRunEvidence } from '@farmslot/protocol';

import './run-pipeline-mini.js';
import '../shared/hydrating-placeholder.js';
import '../queue/dispatch-queue-panel.js';

import { gateway } from '../../gateway-client.js';
import { getState, isHydrating, isPrLinkageMissing, subscribe } from '../../state.js';
import { colors, runnerColor } from '../../styles/theme-tokens.js';

import {
  renderRunListManageBar,
  renderRunListSearchRow,
  renderRunListStatusFilter,
  renderRunListToolbar,
} from './run-list-filter-renderers.js';
import { filterRunList, runGradeColor, TERMINAL_STATUSES } from './run-list-model.js';
import {
  FLOW_OPTIONS,
  LANE_OPTIONS,
  RunListState,
  SORT_OPTIONS,
  STATUS_PILLS,
} from './run-list-state.js';
import { runListStyles } from './run-list-styles.js';
import {
  renderRunCleanupPreview,
  renderRunListAnalyticsStrip,
} from './run-list-summary-renderers.js';
import {
  canCompareRuns,
  dispositionColor,
  dispositionLabel,
  elapsed,
  eligibilityColor,
  eligibilityLabel,
  familyCompletionColor,
  familyCompletionLabel,
  formatCreatedAt,
  groupRunsByFamily,
  pickFamilyComparePair,
  routeForRun,
  runDisplayColor,
  runDisplayLabel,
  runDisplayTitle,
  type RunFamilyGroup,
  runStatusColor,
  summarizeEligibilityReasons,
} from './run-utils.js';

function shortId(id: string): string {
  return id.slice(0, 8);
}

function familyEvidenceRoute(run: Run, evidence?: string): string {
  const params = new URLSearchParams({ run: run.id });
  if (evidence) params.set('evidence', evidence);
  return `#family/${run.familyId}?${params.toString()}`;
}

@customElement('run-list')
export class RunList extends RunListState {
  static styles = runListStyles;

  connectedCallback() {
    super.connectedCallback();
    const s = getState();
    this.runs = s.runs;
    this.prs = s.prs;
    this.runSummaryMeta = s.runSummaryMeta;
    this.runFamilySummaries = s.runFamilySummaries;
    this.runProjectAnalytics = s.runProjectAnalytics;
    this.queueItems = s.queueItems;
    this.globalFilters = s.globalFilters;
    this.hydrating = isHydrating(s, 'runs');
    this.bootstrapFailed = s.bootstrapFailed.runs;
    this.unsub = subscribe((s) => {
      this.runs = s.runs;
      this.prs = s.prs;
      this.runSummaryMeta = s.runSummaryMeta;
      this.runFamilySummaries = s.runFamilySummaries;
      this.runProjectAnalytics = s.runProjectAnalytics;
      this.queueItems = s.queueItems;
      this.globalFilters = s.globalFilters;
      this.hydrating = isHydrating(s, 'runs');
      this.bootstrapFailed = s.bootstrapFailed.runs;
    });
    window.addEventListener('hashchange', this._onHashChange);
    this._onHashChange();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
    window.removeEventListener('hashchange', this._onHashChange);
  }

  async refreshFamilyFilter() {
    if (!this.familyFilter) {
      this.familyRuns = null;
      this.familyRunsError = null;
      return;
    }
    try {
      const res = await gateway.request<{ runs: Run[] }>(Methods.RUN_LIST, {
        familyId: this.familyFilter,
      });
      this.familyRuns = res.runs ?? [];
      this.familyRunsError = null;
    } catch (err) {
      // Surface the failure rather than masking it as an empty list (HARD RULE
      // "no log-and-continue"). Render path checks `familyRunsError` to show
      // an explicit error banner so an empty filtered view is never confused
      // with a fetch failure. Keep `familyRuns = []` (not null) so downstream
      // selection paths (e.g. `selectFamilyRuns`) that fall back via `??` to
      // `this.runs` still see an empty filtered scope rather than the
      // unfiltered run list.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[run-list] failed to refresh family ${this.familyFilter}:`, err);
      this.familyRuns = [];
      this.familyRunsError = message;
    }
  }

  private get filteredRuns(): readonly Run[] {
    return filterRunList({
      familyFilter: this.familyFilter,
      familyRuns: this.familyRuns,
      runs: this.runs,
      globalFilters: this.globalFilters,
      tab: this.tab,
      statusFilter: this.statusFilter,
      flowFilter: this.flowFilter,
      laneFilter: this.laneFilter,
      searchQuery: this.searchQuery,
      sortBy: this.sortBy,
    });
  }

  private setManageMode(next: boolean) {
    this.manageMode = next;
    if (!next) this.selectedIds = new Set();
  }

  private clearSelection() {
    this.selectedIds = new Set();
  }

  private toggleSelect(id: string, e: Event) {
    e.stopPropagation();
    const next = new Set(this.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedIds = next;
  }

  private toggleSelectId(id: string) {
    const next = new Set(this.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedIds = next;
  }

  private selectRuns(runs: readonly Run[]) {
    this.selectedIds = new Set(runs.map((run) => run.id));
  }

  private selectVisibleRuns(terminalOnly = false) {
    const runs = terminalOnly
      ? this.filteredRuns.filter((run) => TERMINAL_STATUSES.has(run.status))
      : this.filteredRuns;
    this.selectRuns(runs);
  }

  private selectFamilyRuns(familyId: string, terminalOnly = false) {
    const source = this.familyFilter ? (this.familyRuns ?? this.runs) : this.runs;
    const runs = source.filter(
      (run) => run.familyId === familyId && (!terminalOnly || TERMINAL_STATUSES.has(run.status)),
    );
    this.selectRuns(runs);
  }

  private async _rescueLinkage(runId: string) {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      // findPRNumber retries up to 65s (0+5+15+45) plus 4 gh calls; default
      // 15s RPC timeout would abort before the gateway finishes. Allow 120s.
      const res = await gateway.request<RunRehydratePrNumberResult>(
        Methods.RUN_REHYDRATE_PR_NUMBER,
        { runId },
        120_000,
      );
      if (res.ok) {
        // run.updated event will refresh the list; no local mutation needed.
        console.log(`[run-list] rehydrated run ${shortId(runId)} -> PR #${res.prNumber}`);
        // Partial success: PR was linked but ci-watch replay was skipped
        // (reassigned slot, disabled, etc.). Surface the reason so operators
        // know CI monitoring did not resume.
        if (res.reason)
          alert(`PR #${res.prNumber} linked, but CI watch did not resume: ${res.reason}`);
      } else {
        alert(`PR rescue failed: ${res.reason}`);
      }
    } catch (err) {
      alert(`PR rescue failed: ${(err as Error).message}`);
    } finally {
      this.actionInProgress = false;
    }
  }

  private async deleteSelected() {
    if (this.selectedIds.size === 0 || this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      const ids = [...this.selectedIds].filter((id) => {
        const run = this.runs.find((candidate) => candidate.id === id);
        return run ? TERMINAL_STATUSES.has(run.status) : false;
      });
      if (ids.length === 0) return;
      await gateway.request<RunBulkDeleteResult>(Methods.RUN_BULK_DELETE, { runIds: ids });
      this.selectedIds = new Set();
    } catch (err) {
      console.error('[run-list] bulk delete failed:', err);
      alert(`Bulk delete failed: ${(err as Error).message}`);
    } finally {
      this.actionInProgress = false;
    }
  }

  private async archiveSelected() {
    if (this.selectedIds.size === 0 || this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      for (const id of this.selectedIds) {
        const run = this.runs.find((candidate) => candidate.id === id);
        if (!run || !TERMINAL_STATUSES.has(run.status)) continue;
        await gateway.request<RunArchiveResult>(Methods.RUN_ARCHIVE, { runId: id });
      }
      this.selectedIds = new Set();
    } catch (err) {
      console.error('[run-list] bulk archive failed:', err);
      alert(`Bulk archive failed: ${(err as Error).message}`);
    } finally {
      this.actionInProgress = false;
    }
  }

  private async startCleanup() {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      const result = await gateway.request<RunCleanupResult>(Methods.RUN_CLEANUP, { dryRun: true });
      this.cleanupPreview = result;
    } catch (err) {
      console.error('[run-list] cleanup preview failed:', err);
      alert(`Cleanup preview failed: ${(err as Error).message}`);
    } finally {
      this.actionInProgress = false;
    }
  }

  private async confirmCleanup() {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      await gateway.request<RunCleanupResult>(Methods.RUN_CLEANUP, { dryRun: false });
      this.cleanupPreview = null;
    } catch (err) {
      console.error('[run-list] cleanup execute failed:', err);
      alert(`Cleanup execute failed: ${(err as Error).message}`);
    } finally {
      this.actionInProgress = false;
    }
  }

  private compareSelected() {
    const ids = [...this.selectedIds];
    if (ids.length !== 2) return;
    const [a, b] = ids.map((id) => this.runs.find((r) => r.id === id)).filter(Boolean) as Run[];
    if (a && b && !canCompareRuns(a, b)) {
      location.hash = `runs?family=${encodeURIComponent(a.familyId)}`;
      return;
    }
    location.hash = `runs/compare?a=${ids[0]}&b=${ids[1]}`;
  }

  render() {
    const filtered = this.filteredRuns;
    const familyGroups = groupRunsByFamily(filtered);
    const showFamilyGroups =
      Boolean(this.familyFilter) ||
      this.laneFilter === 'comparison' ||
      familyGroups.some((group) => group.runs.length > 1);
    const activeCount = this.runs.filter(
      (r) => !TERMINAL_STATUSES.has(r.status) || r.status === 'failed',
    ).length;
    const showStatusFilter = this.tab === 'history' || this.tab === 'all';
    const showCheckboxes = this.manageMode;
    const selCount = this.selectedIds.size;
    const selectedRuns = [...this.selectedIds]
      .map((id) => this.runs.find((r) => r.id === id))
      .filter(Boolean) as Run[];
    const selectedTerminalCount = selectedRuns.filter((run) =>
      TERMINAL_STATUSES.has(run.status),
    ).length;
    const compareAllowed =
      selectedRuns.length === 2 && canCompareRuns(selectedRuns[0], selectedRuns[1]);

    return html`
      ${renderRunListToolbar({
        totalCount: this.runs.length,
        tab: this.tab,
        activeCount,
        manageMode: this.manageMode,
        setTab: (tab) => {
          this.tab = tab;
          this.selectedIds = new Set();
          this._persistHashState();
        },
        setManageMode: (manageMode) => this.setManageMode(manageMode),
        openNewRun: () => {
          location.hash = 'dispatch';
        },
      })}
      ${renderRunListSearchRow({
        searchQuery: this.searchQuery,
        flowFilter: this.flowFilter,
        laneFilter: this.laneFilter,
        sortBy: this.sortBy,
        filteredCount: filtered.length,
        totalCount: this.runs.length,
        flowOptions: FLOW_OPTIONS,
        laneOptions: LANE_OPTIONS,
        sortOptions: SORT_OPTIONS,
        setSearchQuery: (value) => {
          this.searchQuery = value;
          this._persistHashState();
        },
        setFlowFilter: (value) => {
          this.flowFilter = value;
          this._persistHashState();
        },
        setLaneFilter: (value) => {
          this.laneFilter = value;
          this._persistHashState();
        },
        setSortBy: (value) => {
          this.sortBy = value;
          this._persistHashState();
        },
      })}
      ${showStatusFilter
        ? renderRunListStatusFilter({
            statusFilter: this.statusFilter,
            statusPills: STATUS_PILLS,
            familyFilter: this.familyFilter,
            actionInProgress: this.actionInProgress,
            setStatusFilter: (value) => {
              this.statusFilter = value;
              this._persistHashState();
            },
            clearFamilyFilter: () => {
              this.familyFilter = '';
              this.familyRuns = null;
              this.familyRunsError = null;
              this._persistHashState();
            },
            startCleanup: () => this.startCleanup(),
            shortId,
          })
        : nothing}
      ${this.manageMode
        ? renderRunListManageBar({
            selectedCount: selCount,
            selectedTerminalCount,
            compareAllowed,
            actionInProgress: this.actionInProgress,
            selectVisible: () => this.selectVisibleRuns(false),
            selectVisibleTerminal: () => this.selectVisibleRuns(true),
            clearSelection: () => this.clearSelection(),
            compareSelected: () => this.compareSelected(),
            archiveSelected: () => this.archiveSelected(),
            deleteSelected: () => this.deleteSelected(),
          })
        : nothing}
      ${this.renderAnalyticsStrip()} ${this.cleanupPreview ? this.renderCleanupPreview() : nothing}
      ${this.familyRunsError
        ? html`<div class="rehydrating-banner">
            Family ${this.familyFilter} fetch failed: ${this.familyRunsError}
          </div>`
        : nothing}
      ${this.bootstrapFailed && this.runs.length > 0
        ? html`<div class="rehydrating-banner">Refresh failed… showing cached runs</div>`
        : this.hydrating && this.runs.length > 0
          ? html`<div class="rehydrating-banner">Reconnecting… showing last snapshot</div>`
          : nothing}
      ${this.bootstrapFailed && this.runs.length === 0
        ? html`<div class="empty">Run refresh failed — no cached runs available</div>`
        : this.hydrating && this.runs.length === 0
          ? html`<farm-hydrating message="Loading runs…"></farm-hydrating>`
          : html`
              ${this.queueItems.length > 0
                ? html`<div class="queue-preview">
                    <dispatch-queue-panel
                      .items=${this.queueItems}
                      .panelTitle=${'Upcoming Work'}
                      compact
                    ></dispatch-queue-panel>
                  </div>`
                : nothing}
              ${filtered.length === 0
                ? html`<div class="empty">
                    ${this.tab === 'active'
                      ? 'No active runs'
                      : this.tab === 'history'
                        ? 'No completed runs'
                        : 'No runs'}
                  </div>`
                : showFamilyGroups
                  ? familyGroups.map((group) => this.renderFamilyGroup(group, showCheckboxes))
                  : filtered.map((r) => this.renderCard(r, showCheckboxes))}
            `}
    `;
  }

  private renderAnalyticsStrip() {
    return renderRunListAnalyticsStrip(this.runSummaryMeta, this.runProjectAnalytics);
  }

  private readinessForFamily(familyId: string): RunFamilyReadinessSummary | null {
    return this.runFamilySummaries.find((summary) => summary.familyId === familyId) ?? null;
  }

  private renderCleanupPreview() {
    if (!this.cleanupPreview) return nothing;
    return renderRunCleanupPreview(this.cleanupPreview, this.actionInProgress, {
      confirm: () => this.confirmCleanup(),
      dismiss: () => {
        this.cleanupPreview = null;
      },
    });
  }

  private async _stopAutoRecovery(runId: string) {
    await gateway.request(Methods.RUN_AUTO_RECOVERY_STOP, { runId });
  }

  private renderCard(run: Run, showCheckbox: boolean) {
    const fc = runDisplayColor(run);
    const sc = runStatusColor(run.status);
    const isSelected = this.selectedIds.has(run.id);
    const isTerminal = TERMINAL_STATUSES.has(run.status);
    const disposition = dispositionLabel(run.metrics.disposition);
    const runPR =
      run.prNumber != null
        ? (this.prs.find((pr) => pr.pr === run.prNumber && pr.project === run.project) ?? null)
        : null;
    const siblingCount = this.familyFilter
      ? Math.max(0, (this.familyRuns ?? []).filter((r) => r.familyId === run.familyId).length - 1)
      : null;
    const hasAutoRecoveryAttempt =
      run.recoveryAttempts?.some((a) => a.triggeredBy === 'auto-recovery') ?? false;
    const hasCompletedAutoRecovery =
      run.recoveryAttempts?.some(
        (a) => a.triggeredBy === 'auto-recovery' && a.status === 'completed',
      ) ?? false;
    const showStopAutoRecovery =
      run.recoveryProposal?.status === 'auto-in-progress' ||
      (run.status === 'failed' &&
        !run.autoRecoveryDisabled &&
        (hasAutoRecoveryAttempt || Boolean(run.recoveryProposal)));
    const evidenceSummary = summarizeRunEvidence(run);
    return html`
      <div
        class="run-card ${isSelected ? 'selected' : ''} ${this.manageMode ? 'manage-mode' : ''}"
        @click=${() => {
          this.manageMode ? this.toggleSelectId(run.id) : (location.hash = routeForRun(run));
        }}
      >
        <div class="selector-cell">
          ${showCheckbox
            ? html`
                <button
                  class="selector-btn ${isSelected ? 'selected' : ''} ${!isTerminal
                    ? 'disabled'
                    : ''}"
                  title=${isTerminal ? (isSelected ? 'Deselect run' : 'Select run') : 'Select run'}
                  @click=${(e: Event) => this.toggleSelect(run.id, e)}
                >
                  ${isSelected ? '✓' : '+'}
                </button>
              `
            : nothing}
        </div>
        <div>
          <span
            class="badge flow-badge"
            style="--flow-color:${fc}; background:${fc}"
            title=${runDisplayTitle(run)}
            >${runDisplayLabel(run)}</span
          >
        </div>
        <div class="info">
          ${this.familyFilter === run.familyId
            ? html`<div class="summary">family focus</div>`
            : nothing}
          <div class="info-top">
            <span class="ticket">${run.ticketOrPr}</span>
            ${run.links?.length
              ? run.links.map(
                  (l) =>
                    html`<a
                      class="ext-link"
                      href=${l.url}
                      target="_blank"
                      rel="noopener"
                      @click=${(e: Event) => e.stopPropagation()}
                      >${l.label}</a
                    >`,
                )
              : nothing}
            <span class="badge status-badge" style="--status-color:${colors.textMuted}"
              >${run.lane}</span
            >
            ${run.variant
              ? html`<span class="badge status-badge" style="--status-color:${colors.accent}"
                  >variant:${run.variant}</span
                >`
              : nothing}
            <span
              class="badge status-badge"
              style="--status-color:${colors.textMuted}"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.familyFilter = run.familyId;
                void this.refreshFamilyFilter();
                this._persistHashState();
              }}
            >
              family:${shortId(run.familyId)}
            </span>
            <a
              class="ext-link"
              href=${familyEvidenceRoute(run)}
              @click=${(e: Event) => e.stopPropagation()}
              >retrospective</a
            >
            ${this.renderEvidenceSignals(run, evidenceSummary)}
            <span class="badge status-badge" style="--status-color:${sc}">${run.status}</span>
            ${disposition
              ? html`<span
                  class="badge status-badge"
                  style="--status-color:${dispositionColor(run.metrics.disposition)}"
                  >${disposition}</span
                >`
              : nothing}
            ${run.metrics.runner
              ? html`<span
                  class="badge status-badge"
                  style="--status-color:${runnerColor(run.metrics.runner) ?? colors.textMuted}"
                  >${run.metrics.runner}</span
                >`
              : nothing}
            ${run.safetyTier
              ? html`<span
                  class="badge status-badge"
                  style="--status-color:${colors.textMuted}"
                  title="Runner safety tier (ADR-023) — agent invocation flag, not a health signal"
                  >runner:${run.safetyTier}</span
                >`
              : nothing}
            ${run.prepareProfile
              ? html`<span
                  class="badge status-badge"
                  style="--status-color:${colors.textMuted}"
                  title="Prepare profile (ADR-037)"
                  >prep:${run.prepareProfile}</span
                >`
              : nothing}
            ${run.engineState?.intelligenceAuditDegraded
              ? html`<span class="badge status-badge" style="--status-color:${colors.statusWarn}"
                  >audit degraded</span
                >`
              : nothing}
            ${hasCompletedAutoRecovery
              ? html`<span class="badge status-badge" style="--status-color:${colors.statusOk}"
                  >auto-recovered</span
                >`
              : hasAutoRecoveryAttempt
                ? html`<span class="badge status-badge" style="--status-color:${colors.textMuted}"
                    >recovery attempted</span
                  >`
                : nothing}
            ${showStopAutoRecovery
              ? html`<button
                  class="inline-action"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    void this._stopAutoRecovery(run.id);
                  }}
                >
                  Stop auto-recovering
                </button>`
              : nothing}
            ${isPrLinkageMissing(run)
              ? html`<span
                  class="badge status-badge"
                  style="--status-color:${colors.statusWarn}; cursor:pointer"
                  title="Run done but no PR linked on branch ${run.branch ??
                  ''}. Click to re-run PR lookup and kick CI watch."
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this._rescueLinkage(run.id);
                  }}
                  >PR missing</span
                >`
              : nothing}
            ${run.steps.find((s) => s.status === 'running')?.detail
              ? html`<span class="step-detail"
                  >${run.steps.find((s) => s.status === 'running')!.detail}</span
                >`
              : nothing}
          </div>
          ${runPR?.title
            ? html`<div class="pr-title">PR #${runPR.pr}: ${runPR.title}</div>`
            : nothing}
          ${run.summary ? html`<div class="summary">${run.summary}</div>` : nothing}
          ${run.lane === 'comparison'
            ? html`<div class="summary">
                comparison run${run.variant ? ` · variant ${run.variant}` : ''}
              </div>`
            : nothing}
          <div class="info-bottom">
            <span class="run-id">${shortId(run.id)}</span>
            <span>${run.project}</span>
            ${run.slotId ? html`<span>${run.slotId}</span>` : nothing}
            ${siblingCount && siblingCount > 0
              ? html`<span>${siblingCount} sibling${siblingCount !== 1 ? 's' : ''}</span>`
              : nothing}
          </div>
          <run-pipeline-mini
            .run=${run}
            .steps=${run.steps}
            .flowType=${run.flowType}
          ></run-pipeline-mini>
        </div>
        <div class="meta">
          <span title=${run.createdAt}>${formatCreatedAt(run.createdAt)}</span>
          <span>${elapsed(run.createdAt, run.completedAt)}</span>
          ${run.metrics.model
            ? html`<span>${run.metrics.runner ?? ''}/${run.metrics.model}</span>`
            : nothing}
          ${run.metrics.outcome
            ? html`<span
                class="outcome-badge"
                style="background:${run.metrics.outcome === 'success'
                  ? colors.statusOk
                  : run.metrics.outcome === 'failure'
                    ? colors.statusFail
                    : colors.textMuted}22; color:${run.metrics.outcome === 'success'
                  ? colors.statusOk
                  : run.metrics.outcome === 'failure'
                    ? colors.statusFail
                    : colors.textMuted}"
                >${run.metrics.outcome}</span
              >`
            : nothing}
          ${run.humanGrade
            ? html`<span
                class="grade-badge"
                style="background:${runGradeColor(
                  run.humanGrade.recipe_semantic,
                )}22; color:${runGradeColor(run.humanGrade.recipe_semantic)}"
                >${run.humanGrade.recipe_semantic}</span
              >`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderEvidenceSignals(run: Run, evidenceSummary: RunEvidenceSummary) {
    if (evidenceSummary.videoCount === 0 && evidenceSummary.visualPairCount === 0) return nothing;
    return html`
      <span class="evidence-signals" aria-label="Reviewable evidence">
        ${evidenceSummary.videoCount > 0
          ? html`<a
              class="evidence-signal video"
              href=${familyEvidenceRoute(run, 'videos')}
              title=${`${evidenceSummary.videoCount} video artifact${evidenceSummary.videoCount === 1 ? '' : 's'} available`}
              @click=${(e: Event) => e.stopPropagation()}
              >Video ${evidenceSummary.videoCount}</a
            >`
          : nothing}
        ${evidenceSummary.visualPairCount > 0
          ? html`<a
              class="evidence-signal compare"
              href=${familyEvidenceRoute(run)}
              title=${`${evidenceSummary.visualPairCount} before/after pair${evidenceSummary.visualPairCount === 1 ? '' : 's'} available`}
              @click=${(e: Event) => e.stopPropagation()}
              >Compare ${evidenceSummary.visualPairCount}</a
            >`
          : nothing}
      </span>
    `;
  }

  private renderFamilyReadinessBadges(group: RunFamilyGroup) {
    const summary = this.readinessForFamily(group.familyId);
    if (!summary) {
      return html`<span
        class="badge readiness-badge"
        style="--readiness-color:${colors.textMuted}"
        title="No run.list summary returned for this family"
        >summary unknown</span
      >`;
    }
    return html`
      <span
        class="badge readiness-badge"
        style="--readiness-color:${familyCompletionColor(summary.completionState)}"
        title=${`${summary.terminalRunCount}/${summary.runCount} terminal runs`}
        >${familyCompletionLabel(summary)}</span
      >
      <span
        class="badge readiness-badge"
        style="--readiness-color:${eligibilityColor(summary.eligibility.state)}"
        title=${summarizeEligibilityReasons(summary)}
        >${eligibilityLabel(summary.eligibility.state)}</span
      >
    `;
  }

  private renderFamilyGroup(group: RunFamilyGroup, showCheckbox: boolean) {
    const comparePair = pickFamilyComparePair(group.runs);
    const prNumbers = [
      ...new Set(
        group.runs.map((run) => run.prNumber).filter((value): value is number => value != null),
      ),
    ];
    const familyPR = this.prs.find((pr) => prNumbers.includes(pr.pr)) ?? null;
    return html`
      <section class="family-section">
        <div class="family-header">
          <span class="family-title">${group.familyRootTicketOrPr}</span>
          <a
            class="family-link"
            href=${`#runs?family=${encodeURIComponent(group.familyId)}`}
            @click=${(e: Event) => {
              e.stopPropagation();
              this.familyFilter = group.familyId;
              void this.refreshFamilyFilter();
              this._persistHashState();
            }}
          >
            family:${shortId(group.familyId)}
          </a>
          <a
            class="family-link"
            href=${`#family/${group.familyId}`}
            @click=${(e: Event) => e.stopPropagation()}
          >
            retrospective
          </a>
          <span>${group.runs.length} run${group.runs.length !== 1 ? 's' : ''}</span>
          ${this.renderFamilyReadinessBadges(group)}
          ${group.activeCount ? html`<span>${group.activeCount} active</span>` : nothing}
          ${group.comparisonCount
            ? html`<span>${group.comparisonCount} comparison</span>`
            : nothing}
          ${group.variants.length
            ? html`<span>variants: ${group.variants.join(', ')}</span>`
            : nothing}
          ${familyPR?.mergeState
            ? html`<span>merge: ${familyPR.mergeState.replace(/_/g, ' ')}</span>`
            : nothing}
          ${group.latestCreatedAt
            ? html`<span>latest ${elapsed(group.latestCreatedAt)}</span>`
            : nothing}
          ${this.manageMode
            ? html`
                <button
                  class="action-secondary"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.selectFamilyRuns(group.familyId, false);
                  }}
                >
                  select family
                </button>
                <button
                  class="action-secondary"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.selectFamilyRuns(group.familyId, true);
                  }}
                >
                  select terminal
                </button>
              `
            : nothing}
          ${comparePair
            ? html`
                <a
                  class="family-link"
                  href=${`#runs/compare?a=${comparePair[0].id}&b=${comparePair[1].id}`}
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  compare latest siblings
                </a>
              `
            : nothing}
        </div>
        ${this.renderFamilySummaryRow(group, familyPR)}
        ${group.runs.map((run) => this.renderCard(run, showCheckbox))}
      </section>
    `;
  }

  private renderFamilySummaryRow(group: RunFamilyGroup, familyPR: PRStatus | null) {
    const rep = group.representativeRun;
    const repLinks = rep.links ?? [];
    const hasSummary = Boolean(group.familySummary?.trim());
    const hasLinks = repLinks.length > 0 || rep.prNumber != null || familyPR != null;
    if (!hasSummary && !hasLinks) return nothing;
    return html`
      <div class="family-summary-row">
        ${hasSummary
          ? html`<div class="family-summary-text">${group.familySummary}</div>`
          : nothing}
        ${hasLinks
          ? html`
              <div class="family-summary-links">
                ${repLinks.map(
                  (l) =>
                    html`<a
                      class="ext-link"
                      href=${l.url}
                      target="_blank"
                      rel="noopener"
                      @click=${(e: Event) => e.stopPropagation()}
                      >${l.label}</a
                    >`,
                )}
                ${rep.prNumber != null && !repLinks.some((l) => /^pr\b/i.test(l.label.trim()))
                  ? html`<span>PR #${rep.prNumber}</span>`
                  : nothing}
                ${familyPR?.title
                  ? html`<span title=${familyPR.title}
                      >${familyPR.title.length > 80
                        ? familyPR.title.slice(0, 80) + '…'
                        : familyPR.title}</span
                    >`
                  : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-list': RunList;
  }
}
