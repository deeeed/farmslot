import { LitElement } from 'lit';
import { state } from 'lit/decorators.js';

import type {
  FlowType,
  PRStatus,
  QueueItem,
  Run,
  RunCleanupResult,
  RunFamilyReadinessSummary,
  RunLane,
  RunListSummaryMeta,
  RunProjectAnalyticsSummary,
  RunStatus,
} from '@farmslot/protocol';

import type { GlobalFilters } from '../../state.js';
import { parseRunsHashState, writeRunsHashState } from '../../state.js';

export type TabFilter = 'active' | 'history' | 'all';
export type StatusFilter = RunStatus | 'all';
export type SortOption = 'newest' | 'oldest' | 'duration' | 'grade';

export const STATUS_PILLS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Done', value: 'done' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
];

export const FLOW_OPTIONS: { label: string; value: FlowType | '' }[] = [
  { label: 'All flows', value: '' },
  { label: 'Bug Fix', value: 'fix-bug' },
  { label: 'Review', value: 'review-pr' },
  { label: 'Dev', value: 'dev' },
  { label: 'PR Complete', value: 'pr-complete' },
];

export const LANE_OPTIONS: { label: string; value: RunLane | '' }[] = [
  { label: 'All lanes', value: '' },
  { label: 'Production', value: 'production' },
  { label: 'Validation', value: 'validation' },
  { label: 'Comparison', value: 'comparison' },
];

export const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Newest', value: 'newest' },
  { label: 'Oldest', value: 'oldest' },
  { label: 'Duration', value: 'duration' },
  { label: 'Grade', value: 'grade' },
];

const TAB_VALUES: TabFilter[] = ['active', 'history', 'all'];
const STATUS_VALUES: StatusFilter[] = STATUS_PILLS.map((p) => p.value);
const FLOW_VALUES = FLOW_OPTIONS.map((o) => o.value).filter((v): v is FlowType => v !== '');
const LANE_VALUES = LANE_OPTIONS.map((o) => o.value).filter((v): v is RunLane => v !== '');
const SORT_VALUES: SortOption[] = SORT_OPTIONS.map((o) => o.value);

export abstract class RunListState extends LitElement {
  abstract refreshFamilyFilter(): Promise<void>;
  abstract refreshTagFilter(): Promise<void>;

  @state() runs: Run[] = [];
  @state() prs: PRStatus[] = [];
  @state() runSummaryMeta: RunListSummaryMeta | null = null;
  @state() runFamilySummaries: RunFamilyReadinessSummary[] = [];
  @state() runProjectAnalytics: RunProjectAnalyticsSummary[] = [];
  @state() queueItems: QueueItem[] = [];
  @state() manageMode = false;
  @state() tab: TabFilter = 'active';
  @state() statusFilter: StatusFilter = 'all';
  @state() flowFilter: FlowType | '' = '';
  @state() laneFilter: RunLane | '' = '';
  @state() familyFilter = '';
  @state() tagFilter = '';
  @state() tagRuns: Run[] | null = null;
  @state() tagRunsError: string | null = null;
  @state() familyRuns: Run[] | null = null;
  @state() familyRunsError: string | null = null;
  @state() sortBy: SortOption = 'newest';
  @state() searchQuery = '';
  @state() globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() selectedIds = new Set<string>();
  @state() cleanupPreview: RunCleanupResult | null = null;
  @state() actionInProgress = false;
  @state() hydrating = false;
  @state() bootstrapFailed = false;
  unsub?: () => void;
  _onHashChange = () => {
    const raw = location.hash.replace(/^#/, '');
    if (!raw.startsWith('runs')) return;
    const parsed = parseRunsHashState();
    const familyChanged = (parsed.family ?? '') !== this.familyFilter;
    const tagChanged = (parsed.tag ?? '') !== this.tagFilter;
    this.familyFilter = parsed.family ?? '';
    this.tagFilter = parsed.tag ?? '';
    // Derive allow-lists from the existing OPTION arrays so adding a new
    // FlowType / RunLane / SortOption automatically extends the URL allow-list
    // (and the dropdown), instead of silently dropping unknown values.
    this.tab = TAB_VALUES.includes(parsed.tab as TabFilter)
      ? (parsed.tab as TabFilter)
      : parsed.tag
        ? 'all'
        : 'active';
    this.statusFilter = STATUS_VALUES.includes(parsed.status as StatusFilter)
      ? (parsed.status as StatusFilter)
      : 'all';
    this.flowFilter = FLOW_VALUES.includes(parsed.flow as FlowType)
      ? (parsed.flow as FlowType)
      : '';
    this.laneFilter = LANE_VALUES.includes(parsed.lane as RunLane) ? (parsed.lane as RunLane) : '';
    this.sortBy = SORT_VALUES.includes(parsed.sort as SortOption)
      ? (parsed.sort as SortOption)
      : 'newest';
    this.searchQuery = parsed.q ?? '';
    if (familyChanged) void this.refreshFamilyFilter();
    if (tagChanged) void this.refreshTagFilter();
  };

  _persistHashState() {
    writeRunsHashState({
      tab: this.tab !== 'active' ? this.tab : '',
      status: this.statusFilter !== 'all' ? this.statusFilter : '',
      flow: this.flowFilter || '',
      lane: this.laneFilter || '',
      sort: this.sortBy !== 'newest' ? this.sortBy : '',
      q: this.searchQuery || '',
      tag: this.tagFilter || '',
      family: this.familyFilter || '',
    });
  }
}
