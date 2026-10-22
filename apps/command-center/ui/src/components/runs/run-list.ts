import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type {
  PRStatus,
  Run,
  RunArchiveResult,
  RunBulkDeleteResult,
  RunCleanupResult,
  RunEvidenceSummary,
  RunFamilyReadinessSummary,
  RunListResult,
  RunRehydratePrNumberResult,
  TaskProgressResult,
  TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import {
  Events,
  groupRunsByFamily,
  Methods,
  normalizeRunTags,
  resolveRunSlotId,
  runDisplayStatus,
  type RunFamilyGroup,
  slotMachineMap,
  sourceObservationAge,
  summarizeRunEvidence,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import {
  acceptsRunChecklistProgress,
  ChecklistProgressReads,
  runChecklistProgressTarget,
} from '@farmslot/review-dispatch';
import { projectColor } from '@farmslot/theme';

import './run-pipeline-mini.js';
import './run-detail.js';
import './run-tag-editor.js';
import '../shared/hydrating-placeholder.js';
import '../queue/dispatch-queue-panel.js';

import { gateway } from '../../gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from '../../resource-cache.js';
import {
  activeRunsQuery,
  getState,
  isHydrating,
  isPrLinkageMissing,
  runHistoryQuery,
  subscribe,
} from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';
import { SLOT_OPERATION_TIMEOUT_MS } from '../../utils/resource-operation-timeout.js';
import { flowBadgeStyles, renderFlowBadge } from '../shared/flow-badge.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';
import { renderRunTitle } from '../shared/run-title.js';
import {
  focusWorkInventoryRow,
  inventoryShowsDetail,
  inventoryShowsList,
  renderWorkInventoryDetailClose,
  renderWorkInventoryLayout,
  renderWorkInventoryRow,
  renderWorkInventoryTable,
  renderWorkInventoryTableHead,
  workInventoryTableStyles,
} from '../shared/work-inventory-table.js';

import { familyRunHash } from './family-observability-url-state.js';
import { standaloneRunDetailHash } from './run-detail-url-state.js';
import { archiveRunSelection } from './run-list-archive.js';
import {
  renderRunListManageBar,
  renderRunListSearchRow,
  renderRunListStatusFilter,
  renderRunListToolbar,
} from './run-list-filter-renderers.js';
import {
  compactRunPipelineLabel,
  RUN_INVENTORY_COLUMNS,
  type RunInventorySortKey,
} from './run-list-inventory.js';
import {
  activeRunsForGlobalFilters,
  filterRunList,
  isArchivableRun,
  runGradeColor,
  runProgressSummary,
  showsRunProgress,
  TERMINAL_STATUSES,
} from './run-list-model.js';
import { renderRunListSkeleton } from './run-list-skeleton.js';
import {
  FLOW_OPTIONS,
  LANE_OPTIONS,
  RunListState,
  SORT_OPTIONS,
  type SortOption,
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
  pickFamilyComparePair,
  resolveRunEngine,
  runDisplayColor,
  runDisplayLabel,
  runDisplayTitle,
  runStatusColor,
  summarizeEligibilityReasons,
} from './run-utils.js';

function shortId(id: string): string {
  return id.slice(0, 8);
}

const TABLE_SORT_PAIRS = {
  project: 'project-desc',
  flow: 'flow-desc',
  status: 'status-desc',
  ref: 'ref-desc',
  slot: 'slot-desc',
  runner: 'runner-desc',
  newest: 'oldest',
  // Desc-first for the Updated column (matches visible updatedAt dates).
  'updated-desc': 'updated',
} as const;

/** Map inventory column keys onto SortOption values used by filterRunList + URL. */
function inventoryKeyToSortOption(key: RunInventorySortKey): SortOption {
  switch (key) {
    case 'status':
      return 'status';
    case 'flow':
      return 'flow';
    case 'project':
      return 'project';
    case 'ref':
      return 'ref';
    case 'slot':
      return 'slot';
    case 'runner':
      return 'runner';
    case 'updated':
      return 'updated-desc';
    case 'pipeline':
      return 'newest';
  }
}

/** Inventory column for the active SortOption, or null when sort is not a column (newest/oldest/…). */
function sortOptionToInventoryKey(sort: SortOption): RunInventorySortKey | null {
  if (sort === 'status' || sort === 'status-desc') return 'status';
  if (sort === 'flow' || sort === 'flow-desc') return 'flow';
  if (sort === 'project' || sort === 'project-desc') return 'project';
  if (sort === 'ref' || sort === 'ref-desc') return 'ref';
  if (sort === 'slot' || sort === 'slot-desc') return 'slot';
  if (sort === 'runner' || sort === 'runner-desc') return 'runner';
  if (sort === 'updated' || sort === 'updated-desc') return 'updated';
  // newest / oldest / duration / grade — no inventory column owns these.
  return null;
}

function sortOptionDirection(sort: SortOption): 'asc' | 'desc' {
  if (sort.endsWith('-desc') || sort === 'newest' || sort === 'duration' || sort === 'grade') {
    return 'desc';
  }
  if (sort === 'oldest') return 'asc';
  return 'asc';
}

@customElement('run-list')
export class RunList extends RunListState {
  static styles = [runListStyles, flowBadgeStyles, workInventoryTableStyles];

  private narrowMedia?: MediaQueryList;
  private unsubProgress?: () => void;
  private readonly taskProgressFetches = new Set<string>();
  @state() private taskProgressErrorsByRun = new Map<string, string>();
  private progressClock?: number;
  private savedAgeClock?: number;
  private readonly tagQuery = new ResourceQueryController<RunListResult>(this, (state) => {
    this.tagRuns = this.tagFilter ? (state.data?.runs ?? []) : null;
    this.tagRunsError = state.error?.message ?? null;
    this.syncSavedAgeClock();
  });
  private readonly familyQuery = new ResourceQueryController<RunListResult>(this, (state) => {
    this.familyRuns = this.familyFilter ? (state.data?.runs ?? []) : null;
    this.familyRunsError = state.error?.message ?? null;
    this.syncSavedAgeClock();
  });
  private progressConnection = getState().connection;
  private readonly checklistReads = new Map<string, ChecklistProgressReads>();
  private readonly onNarrowChange = () => {
    this.narrowViewport = this.narrowMedia?.matches ?? false;
  };

  connectedCallback() {
    super.connectedCallback();
    const s = getState();
    this.runs = s.runs;
    this.runsObservation = s.runsObservation;
    this.prs = s.prs;
    this.runSummaryMeta = s.runSummaryMeta;
    this.runFamilySummaries = s.runFamilySummaries;
    this.runProjectAnalytics = s.runProjectAnalytics;
    this.queueItems = s.queueItems;
    this.globalFilters = s.globalFilters;
    this.fleet = s.fleet;
    this.hydrating = isHydrating(s, 'runs');
    this.bootstrapFailed = s.bootstrapFailed.runs;
    this.unsub = subscribe((s) => {
      this.runs = s.runs;
      this.runsObservation = s.runsObservation;
      if (!s.runsObservation.data) {
        this.selectedIds = new Set();
        this.cleanupPreview = null;
        this.archiveErrors = new Map();
      }
      this.syncSavedAgeClock();
      this.prs = s.prs;
      this.runSummaryMeta = s.runSummaryMeta;
      this.runFamilySummaries = s.runFamilySummaries;
      this.runProjectAnalytics = s.runProjectAnalytics;
      this.queueItems = s.queueItems;
      this.globalFilters = s.globalFilters;
      this.fleet = s.fleet;
      this.hydrating = isHydrating(s, 'runs');
      this.bootstrapFailed = s.bootstrapFailed.runs;
      if (s.connection === 'connected' && this.progressConnection !== 'connected') {
        this.taskProgressFetches.clear();
      }
      this.progressConnection = s.connection;
      void this.fetchInitialTaskProgress(s.runs);
    });
    this.unsubProgress = gateway.subscribe<TaskProgressUpdatedPayload>(
      Events.TASK_PROGRESS_UPDATED,
      (update) => {
        const run = this.runs.find((candidate) => candidate.id === update.runId);
        if (run && update.progress.structured && acceptsRunChecklistProgress(run, update)) {
          const key = runChecklistProgressTarget(run)!.key;
          this.checklistReads.get(key)?.invalidate();
          this.taskProgressByRun = new Map(this.taskProgressByRun).set(
            key,
            update.progress.structured,
          );
        }
      },
    );
    void this.fetchInitialTaskProgress(this.runs);
    window.addEventListener('hashchange', this._onHashChange);
    if (typeof window.matchMedia === 'function') {
      this.narrowMedia = window.matchMedia('(max-width: 860px)');
      this.narrowViewport = this.narrowMedia.matches;
      this.narrowMedia.addEventListener('change', this.onNarrowChange);
    }
    this._onHashChange();
    // "last progress Nm ago" and the stale line move with the clock, not with run events.
    this.progressClock = window.setInterval(() => this.requestUpdate(), 60_000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.clearInterval(this.progressClock);
    window.clearInterval(this.savedAgeClock);
    this.savedAgeClock = undefined;
    this.unsub?.();
    this.unsubProgress?.();
    this.narrowMedia?.removeEventListener('change', this.onNarrowChange);
    window.removeEventListener('hashchange', this._onHashChange);
  }

  private async fetchInitialTaskProgress(runs: readonly Run[]): Promise<void> {
    const targets = runs.flatMap((run) => {
      const target = runChecklistProgressTarget(run);
      return target && !this.taskProgressFetches.has(target.key) ? [target] : [];
    });
    await Promise.all(
      targets.map(async ({ key, params }) => {
        this.taskProgressFetches.add(key);
        let reads = this.checklistReads.get(key);
        if (!reads) {
          reads = new ChecklistProgressReads();
          reads.select(key);
          this.checklistReads.set(key, reads);
        }
        const read = reads.begin(key);
        try {
          const progress = await gateway.request<TaskProgressResult>(Methods.TASK_PROGRESS, params);
          if (reads.isCurrent(read)) {
            const next = new Map(this.taskProgressByRun);
            if (progress.structured) next.set(key, progress.structured);
            else next.delete(key);
            this.taskProgressByRun = next;
            const errors = new Map(this.taskProgressErrorsByRun);
            errors.delete(key);
            this.taskProgressErrorsByRun = errors;
          }
        } catch (error) {
          if (!reads.isCurrent(read)) return;
          // No checklist is shown on failure; a later refresh may read it again.
          this.taskProgressFetches.delete(key);
          this.taskProgressErrorsByRun = new Map(this.taskProgressErrorsByRun).set(
            key,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    );
  }

  async refreshTagFilter() {
    const [tag] = normalizeRunTags([this.tagFilter]);
    this.tagFilter = tag ?? '';
    this.tagQuery.setQuery(tag ? resourceQuery(Methods.RUN_LIST, { tags: [tag] }) : undefined);
    this.tagRuns = tag ? (this.tagQuery.state.data?.runs ?? []) : null;
    this.tagRunsError = this.tagQuery.state.error?.message ?? null;
  }

  async refreshFamilyFilter() {
    this.familyQuery.setQuery(
      this.familyFilter
        ? resourceQuery(Methods.RUN_LIST, { familyId: this.familyFilter })
        : undefined,
    );
    this.familyRuns = this.familyFilter ? (this.familyQuery.state.data?.runs ?? []) : null;
    this.familyRunsError = this.familyQuery.state.error?.message ?? null;
  }

  private get readStates() {
    return [
      this.runsObservation,
      ...(this.tagFilter ? [this.tagQuery.state] : []),
      ...(this.familyFilter ? [this.familyQuery.state] : []),
    ];
  }

  private get canAct(): boolean {
    return (
      gateway.connectionState === 'connected' &&
      gateway.workspaceAccess === 'farm' &&
      this.readStates.every((state) => state.status === 'ready')
    );
  }

  private assertCurrentRuns(ids: readonly string[] = []): void {
    if (!this.canAct || getState().runsObservation.status !== 'ready')
      throw new Error('Wait for current runs before acting.');
    if (this.tagFilter) this.tagQuery.requireReady();
    if (this.familyFilter) this.familyQuery.requireReady();
    if (ids.some((id) => !this.runById(id)))
      throw new Error('The selected runs changed. Review the current list before retrying.');
  }

  private runById(id: string): Run | undefined {
    return this.filteredRuns.find((run) => run.id === id) ?? this.runs.find((run) => run.id === id);
  }

  private syncSavedAgeClock(): void {
    const stale = this.readStates.some((state) => state.status === 'stale' && state.data);
    if (stale && !this.savedAgeClock)
      this.savedAgeClock = window.setInterval(() => this.requestUpdate(), 1000);
    else if (!stale && this.savedAgeClock) {
      window.clearInterval(this.savedAgeClock);
      this.savedAgeClock = undefined;
    }
  }

  private async retryRunReads(): Promise<void> {
    const cache = getResourceCache();
    if (!cache) return;
    await Promise.all([
      cache.retry(runHistoryQuery),
      cache.retry(activeRunsQuery),
      this.tagQuery.retry(),
      this.familyQuery.retry(),
    ]);
  }

  private renderReadStatus() {
    const states = this.readStates;
    const times = states.flatMap((state) =>
      state.data && state.observedAt !== undefined ? [state.observedAt] : [],
    );
    const error = states.find((state) => state.error)?.error;
    return html`
      ${states.some((state) => state.status === 'stale') && times.length
        ? html`<div class="rehydrating-banner" data-run-freshness="stale">
            Saved runs, ${sourceObservationAge(Math.min(...times))}. Actions wait for a current
            read.
          </div>`
        : nothing}
      ${states.some((state) => state.status === 'unsupported')
        ? html`<div class="rehydrating-banner">Run updates are unavailable on this gateway.</div>`
        : nothing}
      ${error
        ? html`<div class="rehydrating-banner" role="alert">
            Run read failed: ${error.message}
            <button @click=${() => this.retryRunReads()}>Retry reading runs</button>
          </div>`
        : nothing}
    `;
  }

  private get filteredRuns(): readonly Run[] {
    return filterRunList({
      familyFilter: this.familyFilter,
      familyRuns: this.familyRuns,
      tagFilter: this.tagFilter,
      tagRuns: this.tagRuns,
      runs: this.runs,
      globalFilters: this.globalFilters,
      slotMachines: slotMachineMap(this.fleet?.slots ?? []),
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

  private selectRun(run: Run) {
    this.selectedRunId = run.id;
    this._persistHashState('push');
  }

  private backToRunList() {
    const id = this.selectedRunId;
    this.selectedRunId = '';
    this._persistHashState();
    void this.updateComplete.then(() => focusWorkInventoryRow(this.renderRoot, id));
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
      this.assertCurrentRuns([runId]);
      // findPRNumber retries up to 65s (0+5+15+45) plus 4 gh calls; default
      // 15s RPC timeout would abort before the gateway finishes. Allow 120s.
      const res = await gateway.request<RunRehydratePrNumberResult>(
        Methods.RUN_REHYDRATE_PR_NUMBER,
        { runId },
        120_000,
      );
      if (res.ok) {
        // The shared query observes the writer's resource notification.
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
      this.assertCurrentRuns([...this.selectedIds]);
      const ids = [...this.selectedIds].filter((id) => {
        const run = this.runById(id);
        return run ? TERMINAL_STATUSES.has(run.status) : false;
      });
      if (ids.length === 0) return;
      // Each cancelled run's delete releases the slot its cancel kept, one after another.
      const releases = ids.filter((id) => this.runById(id)?.status === 'cancelled').length;
      await gateway.request<RunBulkDeleteResult>(
        Methods.RUN_BULK_DELETE,
        { runIds: ids },
        SLOT_OPERATION_TIMEOUT_MS * Math.max(1, releases),
      );
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
    this.archiveErrors = new Map();
    // One refused or slow archive must not strand the rest of the selection;
    // the failures stay selected and are reported together.
    const failed = new Map<string, string>();
    try {
      const cache = getResourceCache();
      const workspaceKey = getResourceWorkspaceKey();
      const connectionId = gateway.resourceConnectionId;
      if (cache) {
        const failures = await archiveRunSelection([...this.selectedIds], {
          cache,
          queries: [
            runHistoryQuery,
            activeRunsQuery,
            ...(this.tagFilter
              ? [resourceQuery<RunListResult>(Methods.RUN_LIST, { tags: [this.tagFilter] })]
              : []),
            ...(this.familyFilter
              ? [resourceQuery<RunListResult>(Methods.RUN_LIST, { familyId: this.familyFilter })]
              : []),
          ],
          isCurrent: () =>
            gateway.connectionState === 'connected' &&
            gateway.workspaceAccess === 'farm' &&
            gateway.resourceConnectionId === connectionId &&
            getResourceCache() === cache &&
            getResourceWorkspaceKey() === workspaceKey,
          archive: (id) =>
            gateway.request<RunArchiveResult>(
              Methods.RUN_ARCHIVE,
              { runId: id },
              SLOT_OPERATION_TIMEOUT_MS,
            ),
        });
        // An account switch clears selection through the owner binding. Do not
        // restore the previous account's selection or errors after that cleanup.
        if (getResourceCache() !== cache || getResourceWorkspaceKey() !== workspaceKey) return;
        for (const [id, message] of failures) failed.set(id, message);
      } else {
        for (const id of this.selectedIds) failed.set(id, 'Wait for current runs before acting.');
      }
      this.selectedIds = new Set(failed.keys());
      this.archiveErrors = failed;
    } finally {
      this.actionInProgress = false;
    }
  }

  private async startCleanup() {
    if (this.actionInProgress) return;
    this.actionInProgress = true;
    try {
      this.assertCurrentRuns();
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
      this.assertCurrentRuns();
      // Each cancelled run it archives releases the slot its cancel kept, one after another.
      const archives = this.cleanupPreview?.runsArchived.length ?? 0;
      await gateway.request<RunCleanupResult>(
        Methods.RUN_CLEANUP,
        { dryRun: false },
        SLOT_OPERATION_TIMEOUT_MS * Math.max(1, archives),
      );
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
    const [a, b] = ids.map((id) => this.runById(id)).filter(Boolean) as Run[];
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
    const activeCount = activeRunsForGlobalFilters(
      this.runs,
      this.globalFilters,
      this.fleet?.slots ?? [],
    ).length;
    const showStatusFilter = this.tab === 'history' || this.tab === 'all';
    const showCheckboxes = this.manageMode;
    const selCount = this.selectedIds.size;
    const selectedRuns = [...this.selectedIds]
      .map((id) => this.runById(id))
      .filter(Boolean) as Run[];
    const selectedTerminalCount = selectedRuns.filter((run) =>
      TERMINAL_STATUSES.has(run.status),
    ).length;
    const selectedArchivableCount = selectedRuns.filter((run) => isArchivableRun(run)).length;
    const compareAllowed =
      selectedRuns.length === 2 && canCompareRuns(selectedRuns[0], selectedRuns[1]);
    const selectedRunId = this.selectedRunId;

    return html`
      ${renderRunListToolbar({
        totalCount: this.runs.length,
        tab: this.tab,
        activeCount,
        manageMode: this.manageMode,
        actionsReady: this.canAct,
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
        tagFilter: this.tagFilter,
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
        setTagFilter: (value) => {
          const [tag] = normalizeRunTags([value]);
          this.tagFilter = tag ?? '';
          if (this.tagFilter && this.tab === 'active') this.tab = 'all';
          void this.refreshTagFilter();
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
            tagFilter: this.tagFilter,
            actionInProgress: this.actionInProgress || !this.canAct,
            setStatusFilter: (value) => {
              this.statusFilter = value;
              this._persistHashState();
            },
            clearFamilyFilter: () => {
              this.familyFilter = '';
              this.familyRuns = null;
              this.familyRunsError = null;
              void this.refreshFamilyFilter();
              this._persistHashState();
            },
            clearTagFilter: () => {
              this.tagFilter = '';
              this.tagRuns = null;
              this.tagRunsError = null;
              void this.refreshTagFilter();
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
            selectedArchivableCount,
            compareAllowed,
            actionInProgress: this.actionInProgress || !this.canAct,
            selectVisible: () => this.selectVisibleRuns(false),
            selectVisibleTerminal: () => this.selectVisibleRuns(true),
            clearSelection: () => this.clearSelection(),
            compareSelected: () => this.compareSelected(),
            archiveSelected: () => this.archiveSelected(),
            deleteSelected: () => this.deleteSelected(),
          })
        : nothing}
      ${this.renderAnalyticsStrip()} ${this.cleanupPreview ? this.renderCleanupPreview() : nothing}
      ${this.renderReadStatus()}
      ${this.archiveErrors.size
        ? html`<div class="rehydrating-banner" role="alert" data-archive-errors>
            ${[...this.archiveErrors].map(
              ([id, message]) => html`<div>${id.slice(0, 8)}: ${message}</div>`,
            )}
          </div>`
        : nothing}
      ${this.familyRunsError
        ? html`<div class="rehydrating-banner">
            Family ${this.familyFilter} fetch failed: ${this.familyRunsError}
          </div>`
        : nothing}
      ${this.tagRunsError
        ? html`<div class="rehydrating-banner">
            Tag ${this.tagFilter} fetch failed: ${this.tagRunsError}
          </div>`
        : nothing}
      ${this.bootstrapFailed && this.runs.length === 0
        ? renderRunListSkeleton('Runs unavailable', () => gateway.reconnect())
        : this.hydrating && this.runs.length === 0
          ? renderRunListSkeleton()
          : (() => {
              const list = html`${this.queueItems.length > 0
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
                : renderWorkInventoryTable({
                    columns: RUN_INVENTORY_COLUMNS,
                    head: this.renderTableHead(showCheckboxes),
                    rows: showFamilyGroups
                      ? familyGroups.map((group) => this.renderFamilyGroup(group, showCheckboxes))
                      : filtered.map((r) => this.renderCard(r, showCheckboxes)),
                    isEmpty: false,
                    testId: 'work-inventory-table',
                    minWidth: '1100px',
                    leadingTracks: showCheckboxes ? ['30px'] : [],
                  })}`;
              const layout = {
                hasSelection: Boolean(selectedRunId),
                narrowViewport: this.narrowViewport,
              };
              const showDetail = inventoryShowsDetail(layout);
              const detail = showDetail
                ? html`<div class="run-detail-actions">
                      ${renderWorkInventoryDetailClose({
                        layout,
                        testId: 'runs-back-to-list',
                        onBack: () => this.backToRunList(),
                        onClose: () => this.backToRunList(),
                      })}
                      <a
                        class="run-detail-full-link"
                        data-testid="runs-open-full-detail"
                        href=${standaloneRunDetailHash(selectedRunId)}
                        @click=${(event: MouseEvent) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            return;
                          event.preventDefault();
                          location.hash = standaloneRunDetailHash(selectedRunId);
                        }}
                        >Open full view ↗</a
                      >
                    </div>
                    <run-detail
                      class="run-list-detail"
                      .runId=${selectedRunId}
                      embedded
                    ></run-detail>`
                : nothing;
              return renderWorkInventoryLayout({
                list,
                detail,
                showList: inventoryShowsList(layout),
                showDetail,
                testId: 'runs-inventory-layout',
              });
            })()}
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
    return renderRunCleanupPreview(this.cleanupPreview, this.actionInProgress || !this.canAct, {
      confirm: () => this.confirmCleanup(),
      dismiss: () => {
        this.cleanupPreview = null;
      },
    });
  }

  private async _stopAutoRecovery(runId: string) {
    try {
      this.assertCurrentRuns([runId]);
      await gateway.request(Methods.RUN_AUTO_RECOVERY_STOP, { runId });
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  private setInventorySort(key: RunInventorySortKey) {
    if (key === 'pipeline') return;
    const mapped = inventoryKeyToSortOption(key);
    const inverse = (TABLE_SORT_PAIRS as Record<string, SortOption>)[mapped];
    if (inverse && (this.sortBy === mapped || this.sortBy === inverse)) {
      this.sortBy = this.sortBy === mapped ? inverse : mapped;
    } else {
      this.sortBy = mapped;
    }
    this._persistHashState();
  }

  private renderTableHead(showCheckbox: boolean) {
    // Non-column sorts (newest/oldest/duration/grade) must not light up Updated.
    const columnKey = sortOptionToInventoryKey(this.sortBy);
    return renderWorkInventoryTableHead({
      columns: RUN_INVENTORY_COLUMNS,
      sort: {
        key: columnKey ?? ('' as RunInventorySortKey),
        direction: sortOptionDirection(this.sortBy),
      },
      onSort: (key) => this.setInventorySort(key),
      testIdPrefix: 'runs',
      leadingCells: showCheckbox
        ? html`<span role="columnheader" aria-hidden="true"></span>`
        : nothing,
    });
  }

  private renderCard(run: Run, showCheckbox: boolean) {
    const fc = runDisplayColor(run);
    const sc = runStatusColor(run.status);
    const isSelected = this.manageMode
      ? this.selectedIds.has(run.id)
      : this.selectedRunId === run.id;
    const isTerminal = TERMINAL_STATUSES.has(run.status);
    const engine = resolveRunEngine(run);
    const slotId = resolveRunSlotId(run);
    const pipelineLabel = compactRunPipelineLabel(run);
    const disposition = dispositionLabel(run.metrics.disposition);
    const evidenceSummary = summarizeRunEvidence(run);
    const hasAutoRecoveryAttempt =
      run.recoveryAttempts?.some((a) => a.triggeredBy === 'auto-recovery') ?? false;
    const showStopAutoRecovery =
      run.recoveryProposal?.status === 'auto-in-progress' ||
      (run.status === 'failed' &&
        !run.autoRecoveryDisabled &&
        (hasAutoRecoveryAttempt || Boolean(run.recoveryProposal)));
    const runnerLabel = engine.model
      ? `${engine.runner ?? 'runner'}/${engine.model}`
      : (engine.runner ?? '—');
    const progress = showsRunProgress(run) ? runProgressSummary(run) : null;
    const cells = [
      ...(showCheckbox
        ? [
            html`<div class="selector-cell">
              <button
                class="selector-btn ${isSelected ? 'selected' : ''} ${!isTerminal
                  ? 'disabled'
                  : ''}"
                title=${isTerminal ? (isSelected ? 'Deselect run' : 'Select run') : 'Select run'}
                @click=${(e: Event) => this.toggleSelect(run.id, e)}
              >
                ${isSelected ? '✓' : '+'}
              </button>
            </div>`,
          ]
        : []),
      html`<span
        class="badge status-badge"
        data-testid="runs-lifecycle"
        style="--status-color:${sc}"
        title=${runDisplayStatus(run)}
        >${runDisplayStatus(run)}</span
      >`,
      html`<span data-testid="runs-flow"
        >${renderFlowBadge(run.flowType, {
          color: fc,
          label: runDisplayLabel(run),
          title: runDisplayTitle(run),
        })}</span
      >`,
      html`<span
        class="run-project"
        data-testid="runs-project"
        style="--project-color:${projectColor(run.project)}"
        title=${`Project: ${run.project}`}
        >${run.project}</span
      >`,
      html`<span class="item-ref" data-testid="runs-ref" title=${run.ticketOrPr}
        >${run.ticketOrPr}</span
      >`,
      html`<span class="slot-id" data-testid="runs-slot" title=${slotId ?? 'unassigned'}
        >${slotId ?? '—'}</span
      >`,
      html`<span data-testid="runs-runner" title=${runnerLabel}>${runnerLabel}</span>`,
      html`<span class="updated-cell" data-testid="runs-updated" title=${run.updatedAt}
        >${run.updatedAt.slice(0, 10)}</span
      >`,
      html`<div class="run-pipeline-cell" data-testid="runs-pipeline" title=${pipelineLabel}>
        ${run.summary ? html`${renderRunTitle(run, 'run-title')}` : nothing}
        <run-pipeline-mini
          .run=${run}
          .steps=${run.steps}
          .flowType=${run.flowType}
          .taskProgressError=${this.taskProgressErrorsByRun.get(
            runChecklistProgressTarget(run)?.key ?? '',
          )}
          .taskProgress=${this.taskProgressByRun.get(runChecklistProgressTarget(run)?.key ?? '')}
        ></run-pipeline-mini>
        <span class="pipeline-label">${pipelineLabel}</span>
        <div class="run-row-affordances" @click=${(e: Event) => e.stopPropagation()}>
          ${this.renderRunTags(run)} ${this.renderEvidenceSignals(run, evidenceSummary)}
          <a class="ext-link" href=${familyRunHash(run.familyId, run.id)}>retrospective</a>
          ${disposition
            ? html`<span
                class="badge status-badge"
                style="--status-color:${dispositionColor(run.metrics.disposition)}"
                >${disposition}</span
              >`
            : nothing}
          ${run.humanGrade
            ? html`<span
                class="badge status-badge"
                style="--status-color:${runGradeColor(run.humanGrade.recipe_semantic)}"
                >${run.humanGrade.recipe_semantic}</span
              >`
            : nothing}
          ${run.engineState?.intelligenceAuditDegraded
            ? html`<span class="badge status-badge" style="--status-color:${colors.statusWarn}"
                >audit degraded</span
              >`
            : nothing}
          ${isPrLinkageMissing(run)
            ? html`<button
                class="inline-action"
                type="button"
                title="Re-run PR lookup and kick CI watch"
                ?disabled=${!this.canAct || this.actionInProgress}
                @click=${() => this._rescueLinkage(run.id)}
              >
                PR missing
              </button>`
            : nothing}
          ${showStopAutoRecovery
            ? html`<button
                class="inline-action"
                type="button"
                ?disabled=${!this.canAct || this.actionInProgress}
                @click=${() => this._stopAutoRecovery(run.id)}
              >
                Stop auto-recovering
              </button>`
            : nothing}
          ${progress
            ? html`<span
                class="run-progress ${progress.kind}"
                data-testid="runs-progress"
                title=${`Last progress ${progress.lastProgressAt}${progress.text ? ` · ${progress.text}` : ''}`}
                >last progress
                ${progress.lastProgressAgo}${progress.text ? ` · ${progress.text}` : ''}</span
              >`
            : nothing}
        </div>
      </div>`,
    ];
    return renderWorkInventoryRow({
      row: {
        id: run.id,
        selected: isSelected,
        className: `run-card ${this.manageMode ? 'manage-mode' : ''}`,
        testId: `runs-row-${run.id}`,
        onActivate: () => {
          this.manageMode ? this.toggleSelectId(run.id) : this.selectRun(run);
        },
        onDeselect: this.manageMode ? undefined : () => this.backToRunList(),
      },
      cells,
    });
  }

  private async setRunTags(run: Run, tags: string[]) {
    this.assertCurrentRuns([run.id]);
    await gateway.request(Methods.RUN_TAGS_SET, { runId: run.id, tags });
  }

  private filterByTag(tag: string) {
    this.tagFilter = tag;
    if (this.tab === 'active') this.tab = 'all';
    void this.refreshTagFilter();
    this._persistHashState();
  }

  private renderRunTags(run: Run) {
    return html`
      <run-tag-editor
        .tags=${normalizeRunTags(run.tags)}
        .disabled=${!this.canAct}
        .saveTags=${(tags: string[]) => this.setRunTags(run, tags)}
        .filterTag=${(tag: string) => this.filterByTag(tag)}
      ></run-tag-editor>
    `;
  }

  private renderEvidenceSignals(run: Run, evidenceSummary: RunEvidenceSummary) {
    if (evidenceSummary.videoCount === 0 && evidenceSummary.visualPairCount === 0) return nothing;
    return html`
      <span class="evidence-signals" aria-label="Reviewable evidence">
        ${evidenceSummary.videoCount > 0
          ? html`<a
              class="evidence-signal video"
              href=${familyRunHash(run.familyId, run.id, { evidence: 'videos' })}
              title=${`${evidenceSummary.videoCount} video artifact${evidenceSummary.videoCount === 1 ? '' : 's'} available`}
              @click=${(e: Event) => e.stopPropagation()}
              >Video ${evidenceSummary.videoCount}</a
            >`
          : nothing}
        ${evidenceSummary.visualPairCount > 0
          ? html`<a
              class="evidence-signal compare"
              href=${familyRunHash(run.familyId, run.id)}
              title=${`${evidenceSummary.visualPairCount} before/after pair${evidenceSummary.visualPairCount === 1 ? '' : 's'} — open family retrospective`}
              @click=${(e: Event) => e.stopPropagation()}
              >Before/after · ${evidenceSummary.visualPairCount}</a
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
      <section class="family-section" role="rowgroup">
        <div class="family-header" role="row">
          <div role="gridcell" class="family-header-cell">
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
            ${group.comparisonCount >= 2
              ? html`
                  <a
                    class="family-link"
                    href=${`#family/${group.familyId}`}
                    @click=${(e: Event) => e.stopPropagation()}
                  >
                    compare ${group.comparisonCount} runs
                  </a>
                `
              : comparePair
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
      <div class="family-summary-row" role="row">
        <div role="gridcell" class="family-summary-cell">
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
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-list': RunList;
  }
}
