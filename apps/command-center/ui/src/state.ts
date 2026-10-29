// Reactive view state. Shared cache observations own gateway collection facts.

import type {
  BacklogItem,
  BacklogListResult,
  ConfigProjectsResult,
  DecisionListResult,
  DispatchQueueListResult,
  FleetStatus,
  FleetStatusResult,
  GitHubRateLimitPayload,
  MonitorViolation,
  MonitorViolationPayload,
  PendingDecision,
  PRListResult,
  PRStatus,
  QueueItem,
  Run,
  RunFamilyReadinessSummary,
  RunListResult,
  RunListSummaryMeta,
  RunProjectAnalyticsSummary,
  WorkGraphListResult,
  WorkGraphProjection,
} from '@farmslot/protocol';
import {
  buildRunFamilyReadinessSummaries,
  buildRunProjectAnalyticsSummaries,
  DEFAULT_BRANCH,
  Events,
  isTerminalRunStatus,
  mergeRunListObservations,
  Methods,
} from '@farmslot/protocol';
import {
  type GatewayResourceCache,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { notificationTray, publishReadNotice } from './utils/notification-tray.js';
import { safeLsGet, safeLsRemove } from './utils/storage.js';
import { contentPrefetchTargets } from './content-prefetch.js';
import { type ConnectionState, gateway } from './gateway-client.js';
import {
  getResourceCache,
  getResourceWorkspaceAccess,
  getResourceWorkspaceKey,
  initializeResourceCache,
  setContentPrefetchTargets,
  subscribeResourceCache,
} from './resource-cache.js';
import {
  filtersHash,
  type GlobalFilters,
  parseFiltersFromHash,
  writeFiltersToHash,
} from './state-url-state.js';
export {
  type GlobalFilters,
  parseRunsHashState,
  type RunsHashState,
  writeRunsHashState,
} from './state-url-state.js';

export type HydratedSlice =
  | 'fleet'
  | 'prs'
  | 'decisions'
  | 'runs'
  | 'queue'
  | 'backlog'
  | 'workGraphs'
  | 'projects';
export type HydratedSlices = Record<HydratedSlice, boolean>;

const EMPTY_HYDRATED: HydratedSlices = {
  fleet: false,
  prs: false,
  decisions: false,
  runs: false,
  queue: false,
  backlog: false,
  workGraphs: false,
  projects: false,
};

export function isFullyHydrated(h: HydratedSlices): boolean {
  return (Object.values(h) as boolean[]).every(Boolean);
}

export function isHydrating(s: AppState, slice: HydratedSlice): boolean {
  // A kept workspace stays visibly stale while disconnected, not falsely live.
  return s.connection !== 'auth_required' && !s.hydrated[slice];
}

export interface AppState {
  connection: ConnectionState;
  /** Access level of the account the shown workspace belongs to; kept across a transient disconnect. */
  workspaceAccess: 'farm' | 'native' | 'none';
  hydrated: HydratedSlices;
  // `true` iff the most recent bootstrap snapshot RPC for this slice
  // rejected. Views consult this on the hydrating→hydrated transition to
  // decide whether to retry their own fetch instead of showing stale data
  // left over from a prior connection. Reset on disconnect.
  bootstrapFailed: HydratedSlices;
  fleet: FleetStatus | null;
  fleetObservation: ResourceQueryState<FleetStatusResult>;
  prs: PRStatus[];
  prsObservation: ResourceQueryState<PRListResult>;
  decisions: PendingDecision[];
  runs: Run[];
  runsObservation: ResourceQueryState<RunListResult>;
  decisionsObservation: ResourceQueryState<DecisionListResult>;
  runSummaryMeta: RunListSummaryMeta | null;
  runFamilySummaries: RunFamilyReadinessSummary[];
  runProjectAnalytics: RunProjectAnalyticsSummary[];
  queueItems: QueueItem[];
  backlogItems: BacklogItem[];
  workGraphs: WorkGraphProjection[];
  violations: MonitorViolation[];
  globalFilters: GlobalFilters;
  projectDefaultBranches: Record<string, string>;
  projectSlotTracking: Record<
    string,
    { defaultBranch: string; slotTrackingBranch?: string; worktreeBase?: string }
  >;
  githubQuota: GitHubRateLimitPayload | null;
}

type Listener = (state: AppState) => void;

const GLOBAL_FILTERS_KEY = 'farmslot:global-filters';

export type AppStateSliceSnapshot = Pick<
  AppState,
  | 'fleet'
  | 'prs'
  | 'prsObservation'
  | 'runs'
  | 'runSummaryMeta'
  | 'runFamilySummaries'
  | 'runProjectAnalytics'
  | 'queueItems'
  | 'backlogItems'
  | 'workGraphs'
  | 'bootstrapFailed'
>;

function normalizeStoredProjectFilters(projects: string[]): string[] {
  return [
    ...new Set(projects.map((project) => (project === 'farmslot' ? 'farmslot-farm' : project))),
  ];
}

function loadGlobalFilters(): GlobalFilters {
  const fromHash = parseFiltersFromHash();
  if (fromHash) {
    return { ...fromHash, projects: normalizeStoredProjectFilters(fromHash.projects) };
  }
  const raw = safeLsGet(GLOBAL_FILTERS_KEY);
  if (!raw) return { projects: [], machines: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      projects: normalizeStoredProjectFilters(parsed.projects ?? []),
      machines: parsed.machines ?? [],
    };
  } catch (err) {
    console.warn('[state] corrupted global-filters in localStorage, clearing:', err);
    safeLsRemove(GLOBAL_FILTERS_KEY);
    return { projects: [], machines: [] };
  }
}

function filtersEqual(a: GlobalFilters, b: GlobalFilters): boolean {
  if (a.projects.length !== b.projects.length || a.machines.length !== b.machines.length)
    return false;
  for (let i = 0; i < a.projects.length; i++) if (a.projects[i] !== b.projects[i]) return false;
  for (let i = 0; i < a.machines.length; i++) if (a.machines[i] !== b.machines[i]) return false;
  return true;
}

const state: AppState = {
  connection: gateway.connectionState,
  workspaceAccess: 'none',
  hydrated: { ...EMPTY_HYDRATED },
  bootstrapFailed: { ...EMPTY_HYDRATED },
  fleet: null,
  fleetObservation: { status: 'loading' },
  prs: [],
  prsObservation: { status: 'loading' },
  decisions: [],
  runs: [],
  runsObservation: { status: 'loading' },
  decisionsObservation: { status: 'loading' },
  runSummaryMeta: null,
  runFamilySummaries: [],
  runProjectAnalytics: [],
  queueItems: [],
  backlogItems: [],
  workGraphs: [],
  violations: [],
  globalFilters: loadGlobalFilters(),
  projectDefaultBranches: {},
  projectSlotTracking: {},
  githubQuota: null,
};

function clearWorkspaceState(): void {
  // Authentication transitions must not leave the previous owner's farm in memory.
  Object.assign(state, {
    fleet: null,
    fleetObservation: { status: 'loading' },
    prs: [],
    prsObservation: { status: 'loading' },
    decisions: [],
    runs: [],
    runsObservation: { status: 'loading' },
    decisionsObservation: { status: 'loading' },
    runSummaryMeta: null,
    runFamilySummaries: [],
    runProjectAnalytics: [],
    queueItems: [],
    backlogItems: [],
    workGraphs: [],
    violations: [],
    globalFilters: { projects: [], machines: [] },
    projectDefaultBranches: {},
    projectSlotTracking: {},
    githubQuota: null,
    workspaceAccess: 'none',
  });
}

interface WorkspaceOwner {
  credentialGeneration: number;
  principalId: string | null;
  access: 'farm' | 'native' | 'none';
}

let workspaceOwner: WorkspaceOwner | null = null;

/**
 * Returns whether the account behind the workspace changed. Keep the workspace through a
 * transient disconnect or gateway restart. Clear it only when the
 * account behind it changes: sign-in or sign-out on this client, refused credentials, or a
 * reconnect as another principal or access level.
 */
function syncWorkspaceOwner(conn: ConnectionState): boolean {
  const previous = workspaceOwner;
  if (
    conn === 'auth_required' ||
    (workspaceOwner && workspaceOwner.credentialGeneration !== gateway.credentialGeneration)
  ) {
    workspaceOwner = null;
    clearWorkspaceState();
  }
  if (conn !== 'connected') return previous !== null && workspaceOwner === null;
  const owner: WorkspaceOwner = {
    credentialGeneration: gateway.credentialGeneration,
    principalId: gateway.authenticatedPrincipalId,
    access: gateway.workspaceAccess,
  };
  const changed =
    !workspaceOwner ||
    workspaceOwner.principalId !== owner.principalId ||
    workspaceOwner.access !== owner.access;
  if (changed && workspaceOwner) clearWorkspaceState();
  workspaceOwner = owner;
  state.workspaceAccess = owner.access;
  return changed;
}

const workspaceOwnerListeners = new Set<() => void>();

function notifyWorkspaceOwnerChange(): void {
  for (const listener of workspaceOwnerListeners) listener();
}

/** Runs after the account behind the workspace changes; never on a transient disconnect. */
export function onWorkspaceOwnerChange(listener: () => void): () => void {
  workspaceOwnerListeners.add(listener);
  return () => workspaceOwnerListeners.delete(listener);
}

function resetBootstrapState(): void {
  state.hydrated = { ...EMPTY_HYDRATED };
  state.bootstrapFailed = { ...EMPTY_HYDRATED };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function getProjectDefaultBranch(projectName: string): string {
  return state.projectDefaultBranches[projectName] ?? DEFAULT_BRANCH;
}

export function updateProjectDefaultBranches(map: Record<string, string>): void {
  state.projectDefaultBranches = map;
  notify();
}

export function getProjectSlotTrackingConfigs(): Readonly<
  Record<string, { defaultBranch: string; slotTrackingBranch?: string; worktreeBase?: string }>
> {
  return state.projectSlotTracking;
}

export function updateProjectSlotTracking(
  map: Record<
    string,
    { defaultBranch: string; slotTrackingBranch?: string; worktreeBase?: string }
  >,
): void {
  state.projectSlotTracking = map;
  notify();
}

// Explicit GitHub checks and selected PR detail reads can exceed the default request budget.
export const PR_LIST_TIMEOUT_MS = 30_000;

// Flow types that are expected to produce a PR. `dev` runs are exploratory
// and may legitimately finish on a side branch without one.
const PR_PRODUCING_FLOWS = new Set<Run['flowType']>([
  'fix-bug',
  'review-pr',
  'pr-complete',
  'update-branch',
]);
function isActiveRun(run: Run): boolean {
  return !isTerminalRunStatus(run.status);
}

function isReviewableTerminalRun(run: Run): boolean {
  return run.taskFile != null && (run.status === 'done' || run.status === 'failed');
}

export function isPrLinkageMissing(run: Run): boolean {
  // `getProjectDefaultBranch` falls back to DEFAULT_BRANCH while the projects
  // slice is still hydrating, which would flash a false-positive "PR missing"
  // badge for any run whose branch isn't `main`. Gate until projects lands.
  if (!state.hydrated.projects) return false;
  if (run.status !== 'done' || run.prNumber || !run.branch) return false;
  if (!PR_PRODUCING_FLOWS.has(run.flowType)) return false;
  return run.branch !== getProjectDefaultBranch(run.project);
}

const listeners = new Set<Listener>();
let lastHydratedEpoch = 0;
let coreHydrationPromise: Promise<void> = Promise.resolve();

// Reconnect snapshot/event ordering.
//
// On reconnect, two data sources race: the bootstrap snapshot RPCs and the
// live event stream. Events fire as soon as the socket opens, often before
// the matching snapshot RPC resolves — and a snapshot read at time T cannot
// contain updates the gateway made at T+Δ.
//
// Rather than merging the two sources after the fact (which needs per-ID
// diffing, deletion tombstones, and coarse-event special cases — every edge
// becomes its own bug), we defer live event application per slice until that
// slice's snapshot has landed, then drain the buffered events through the
// normal update*/remove* helpers. Natural ordering, one code path.
type BootstrapState = {
  epoch: number;
  ready: Set<HydratedSlice>;
  buffer: Record<HydratedSlice, Array<() => void>>;
  // Set when the decisions slice snapshot lands before runs. Draining
  // decisions is delayed so runMeta lookup and event ordering see the
  // hydrated runs list; `markReady('runs')` flushes it.
  pendingDecisionsDrain: boolean;
};
let activeBootstrap: BootstrapState | null = null;

function newBootstrapState(epoch: number): BootstrapState {
  return {
    epoch,
    ready: new Set(),
    buffer: {
      fleet: [],
      prs: [],
      decisions: [],
      runs: [],
      queue: [],
      backlog: [],
      workGraphs: [],
      projects: [],
    },
    pendingDecisionsDrain: false,
  };
}

// Coalesce notifies during a batch (e.g. per-slice drain) so N upserts
// fire one listener sweep instead of N. `notify()` no-ops while
// `notifyDepth > 0`; the outermost `coalesceNotify` fires a single
// sweep at the end if any batched write would have notified.
let notifyDepth = 0;
let notifyPending = false;
function coalesceNotify(fn: () => void): void {
  notifyDepth++;
  try {
    fn();
  } finally {
    notifyDepth--;
    if (notifyDepth === 0 && notifyPending) {
      notifyPending = false;
      fireNotify();
    }
  }
}
function fireNotify(): void {
  for (const l of listeners) {
    try {
      l(state);
    } catch (err) {
      console.error('[state] listener threw during notify:', err);
    }
  }
}
function notify(): void {
  if (notifyDepth > 0) {
    notifyPending = true;
    return;
  }
  fireNotify();
}

export const runHistoryQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, {
  limit: 1000,
  includeFamilySummaries: true,
  includeProjectAnalytics: true,
});
export const activeRunsQuery = resourceQuery<RunListResult>(Methods.RUN_LIST, { active: true });
export const decisionsQuery = resourceQuery<DecisionListResult>(Methods.DECISION_LIST);
export const fleetQuery = resourceQuery<FleetStatusResult>(Methods.FLEET_STATUS);
export const backlogQuery = resourceQuery<BacklogListResult>(Methods.BACKLOG_LIST, {
  includeArchived: true,
});
export const workGraphsQuery = resourceQuery<WorkGraphListResult>(Methods.WORK_GRAPH_LIST, {
  includeArchived: true,
});
export const queueQuery = resourceQuery<DispatchQueueListResult>(Methods.DISPATCH_QUEUE_LIST);
export const projectsQuery = resourceQuery<ConfigProjectsResult>(Methods.CONFIG_PROJECTS);
export const prsQuery = resourceQuery<PRListResult>(Methods.PR_LIST);

/**
 * The default branch both prefetch and held reads give `activeRunDiffBase`: the run's project's,
 * which a stacked run's stack base precedes, and `main` follows.
 */
export function runProjectDefaultBranch(run: Pick<Run, 'project'>): string | undefined {
  return state.projectDefaultBranches[run.project];
}

let collectionCache: GatewayResourceCache | undefined;
let collectionWorkspaceKey: string | undefined;
let collectionFarm = false;
let collectionObservers: Array<() => void> = [];

/** These arrays are view projections; notifications and persistence belong to the shared cache. */
function bindFarmCollections(): void {
  const cache = getResourceCache();
  const workspaceKey = getResourceWorkspaceKey();
  const farm =
    getResourceWorkspaceAccess() === 'farm' ||
    (gateway.connectionState === 'connected' && gateway.workspaceAccess === 'farm');
  if (
    collectionCache === cache &&
    collectionWorkspaceKey === workspaceKey &&
    collectionFarm === farm
  )
    return;
  for (const stop of collectionObservers) stop();
  collectionObservers = [];
  collectionCache = cache;
  collectionWorkspaceKey = workspaceKey;
  collectionFarm = farm;
  notificationTray.setOwner(farm ? workspaceKey : undefined);
  state.runsObservation = { status: 'loading' };
  state.decisionsObservation = { status: 'loading' };
  state.fleetObservation = { status: 'loading' };
  state.prsObservation = { status: 'loading' };
  state.fleet = null;
  state.runs = [];
  state.prs = [];
  state.decisions = [];
  state.backlogItems = [];
  state.workGraphs = [];
  state.queueItems = [];
  state.projectDefaultBranches = {};
  state.projectSlotTracking = {};
  setContentPrefetchTargets([]);
  if (!cache || !farm) {
    notify();
    return;
  }
  if (gateway.connectionState !== 'connected') state.workspaceAccess = 'farm';
  const current = () => collectionCache === cache && collectionWorkspaceKey === workspaceKey;
  // Runs start once the projects name their default branches, so no read uses a passing base.
  const prefetchTargetsChanged = () => {
    if (cache.read(projectsQuery).status === 'loading') return;
    setContentPrefetchTargets(
      contentPrefetchTargets(state.decisions, cache.read(activeRunsQuery).data?.runs ?? []),
      runProjectDefaultBranch,
    );
  };
  collectionObservers.push(
    cache.observe(prsQuery, (result) => {
      if (!current()) return;
      state.prsObservation = result;
      state.prs = result.data?.prs ?? [];
      state.hydrated = { ...state.hydrated, prs: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, prs: Boolean(result.error) };
      notify();
    }),
  );
  collectionObservers.push(
    cache.observe(fleetQuery, (result) => {
      if (!current()) return;
      state.fleetObservation = result;
      publishReadNotice('farm:fleet', workspaceKey, fleetQuery, result, '#fleet', () => {
        if (current()) void cache.retry(fleetQuery);
      });
      state.fleet = result.data?.fleet ?? null;
      state.hydrated = { ...state.hydrated, fleet: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, fleet: Boolean(result.error) };
      notify();
    }),
  );
  collectionObservers.push(
    cache.observe(backlogQuery, (result) => {
      if (!current()) return;
      state.backlogItems = result.data?.items ?? [];
      state.hydrated = { ...state.hydrated, backlog: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, backlog: Boolean(result.error) };
      notify();
    }),
  );
  collectionObservers.push(
    cache.observe(workGraphsQuery, (result) => {
      if (!current()) return;
      state.workGraphs = result.data?.graphs ?? [];
      state.hydrated = { ...state.hydrated, workGraphs: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, workGraphs: Boolean(result.error) };
      notify();
    }),
  );
  collectionObservers.push(
    cache.observe(queueQuery, (result) => {
      if (!current()) return;
      state.queueItems = result.data?.items ?? [];
      state.hydrated = { ...state.hydrated, queue: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, queue: Boolean(result.error) };
      notify();
    }),
  );
  collectionObservers.push(
    cache.observe(projectsQuery, (result) => {
      if (!current()) return;
      const projects = result.data?.projects ?? [];
      state.projectDefaultBranches = Object.fromEntries(
        projects.map((project) => [project.name, project.defaultBranch || DEFAULT_BRANCH]),
      );
      state.projectSlotTracking = Object.fromEntries(
        projects.map((project) => [
          project.name,
          {
            defaultBranch: project.defaultBranch || DEFAULT_BRANCH,
            slotTrackingBranch: project.slotTrackingBranch,
            worktreeBase: project.worktreeBase,
          },
        ]),
      );
      state.hydrated = { ...state.hydrated, projects: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, projects: Boolean(result.error) };
      prefetchTargetsChanged();
      notify();
    }),
  );
  const observeRuns = () => {
    if (!current()) return;
    const result = mergeRunListObservations(
      cache.read(activeRunsQuery),
      cache.read(runHistoryQuery),
    );
    state.runsObservation = result;
    publishReadNotice('farm:runs', workspaceKey, activeRunsQuery, result, '#runs', () => {
      if (current()) void cache.retry(activeRunsQuery);
    });
    state.runs = result.data?.runs ?? [];
    state.runSummaryMeta = result.data?.summaryMeta ?? null;
    state.runFamilySummaries = result.data?.familySummaries ?? [];
    state.runProjectAnalytics = result.data?.projectAnalytics ?? [];
    state.hydrated = { ...state.hydrated, runs: result.status !== 'loading' };
    state.bootstrapFailed = { ...state.bootstrapFailed, runs: Boolean(result.error) };
    prefetchTargetsChanged();
    notify();
  };
  collectionObservers.push(cache.observe(runHistoryQuery, observeRuns));
  collectionObservers.push(cache.observe(activeRunsQuery, observeRuns));
  collectionObservers.push(
    cache.observe(decisionsQuery, (result) => {
      if (!current()) return;
      state.decisionsObservation = result;
      state.decisions = result.data?.decisions ?? [];
      state.hydrated = { ...state.hydrated, decisions: result.status !== 'loading' };
      state.bootstrapFailed = { ...state.bootstrapFailed, decisions: Boolean(result.error) };
      notificationTray.decisions(workspaceKey, state.decisions, result.status === 'ready');
      publishReadNotice(
        'farm:decisions',
        workspaceKey,
        decisionsQuery,
        result,
        '#decisions',
        () => {
          if (current()) void cache.retry(decisionsQuery);
        },
      );
      prefetchTargetsChanged();
      notify();
    }),
  );
}

// --- Public API ---

export function getState(): Readonly<AppState> {
  return state;
}

export function captureStateSlices(): AppStateSliceSnapshot {
  return {
    fleet: state.fleet,
    prs: state.prs,
    prsObservation: state.prsObservation,
    runs: state.runs,
    runSummaryMeta: state.runSummaryMeta,
    runFamilySummaries: state.runFamilySummaries,
    runProjectAnalytics: state.runProjectAnalytics,
    queueItems: state.queueItems,
    backlogItems: state.backlogItems,
    workGraphs: state.workGraphs,
    bootstrapFailed: state.bootstrapFailed,
  };
}

export function restoreStateSlices(snapshot: AppStateSliceSnapshot): void {
  state.fleet = snapshot.fleet;
  state.prs = snapshot.prs;
  state.prsObservation = snapshot.prsObservation;
  state.runs = snapshot.runs;
  state.runSummaryMeta = snapshot.runSummaryMeta;
  state.runFamilySummaries = snapshot.runFamilySummaries;
  state.runProjectAnalytics = snapshot.runProjectAnalytics;
  state.queueItems = snapshot.queueItems;
  state.backlogItems = snapshot.backlogItems;
  state.workGraphs = snapshot.workGraphs;
  state.bootstrapFailed = snapshot.bootstrapFailed;
  notify();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateFleet(fleet: FleetStatus): void {
  state.fleet = fleet;
  state.bootstrapFailed = { ...state.bootstrapFailed, fleet: false };
  notify();
}

/** Commands recheck the cache so a rendered button cannot outlive its current read. */
export function isFleetCurrent(): boolean {
  const result = getResourceCache()?.read(fleetQuery);
  return (
    gateway.connectionState === 'connected' &&
    gateway.workspaceAccess === 'farm' &&
    result?.status === 'ready' &&
    result.data !== undefined &&
    !result.data.fleet.stale
  );
}

export function requireCurrentFleet(): FleetStatus {
  if (!isFleetCurrent()) throw new Error('Wait for a current fleet read before acting.');
  return getResourceCache()!.read(fleetQuery).data!.fleet;
}

/** Dev-harness fixtures only. Production PR projections are written by the shared observer. */
export function updatePRs(prs: PRStatus[]): void {
  state.prs = prs;
  state.prsObservation = { status: 'ready', data: { prs } };
  state.bootstrapFailed = { ...state.bootstrapFailed, prs: false };
  notify();
}

export function updateDecisions(decisions: PendingDecision[]): void {
  state.decisions = decisions;
  notify();
}

// Development fixtures can provide rows without server summaries. Product
// observations use the summary metadata from their canonical query result.
function recomputeRunSummariesInPlace(): void {
  if (!state.runSummaryMeta) return;
  state.runFamilySummaries = buildRunFamilyReadinessSummaries(state.runs);
  state.runProjectAnalytics = buildRunProjectAnalyticsSummaries(state.runFamilySummaries);
  state.runSummaryMeta = {
    ...state.runSummaryMeta,
    summaryRunCount: state.runs.length,
    isTruncated: state.runs.length < state.runSummaryMeta.totalCount,
  };
}

export function updateRuns(
  runs: Run[],
  summaries?: Pick<RunListResult, 'summaryMeta' | 'familySummaries' | 'projectAnalytics'>,
): void {
  state.runs = runs;
  if (summaries) {
    state.runSummaryMeta = summaries.summaryMeta ?? null;
    state.runFamilySummaries = summaries.familySummaries ?? [];
    state.runProjectAnalytics = summaries.projectAnalytics ?? [];
  } else if (state.runSummaryMeta) {
    recomputeRunSummariesInPlace();
  }
  state.bootstrapFailed = { ...state.bootstrapFailed, runs: false };
  notify();
}

export function updateQueueItems(items: QueueItem[]): void {
  state.queueItems = items;
  notify();
}

export function updateBacklogItems(items: BacklogItem[]): void {
  state.backlogItems = items;
  notify();
}

export function updateWorkGraphs(graphs: WorkGraphProjection[]): void {
  state.workGraphs = graphs;
  notify();
}

export function upsertWorkGraph(graph: WorkGraphProjection): void {
  const idx = state.workGraphs.findIndex((candidate) => candidate.graph.id === graph.graph.id);
  state.workGraphs =
    idx >= 0
      ? state.workGraphs.map((candidate, i) => (i === idx ? graph : candidate))
      : [graph, ...state.workGraphs];
  notify();
}

const MAX_MONITOR_VIOLATIONS = 100;

function monitorViolationKey(v: MonitorViolation): string {
  return `${v.slotId}:${v.type}:${v.message}`;
}

export function recordMonitorViolation(violation: MonitorViolation): void {
  const key = monitorViolationKey(violation);
  state.violations = [
    violation,
    ...state.violations.filter((v) => monitorViolationKey(v) !== key),
  ].slice(0, MAX_MONITOR_VIOLATIONS);
  notify();
}

export function updateGlobalFilters(filters: GlobalFilters): void {
  state.globalFilters = filters;
  persistFilters(filters);
  writeFiltersToHash(filters);
  notify();
}

function persistFilters(filters: GlobalFilters): void {
  try {
    localStorage.setItem(GLOBAL_FILTERS_KEY, JSON.stringify(filters));
  } catch (err) {
    // Private browsing or quota exceeded — filters still live in state + URL.
    console.warn('[state] failed to persist global filters to localStorage:', err);
  }
}

export function getRunForSlot(slotId: string, preferredRunId?: string | null): Run | null {
  if (preferredRunId) {
    const preferred = state.runs.find((r) => r.id === preferredRunId);
    if (!preferred) return null;
    // URL-pinned terminal runs are valid for slot-view evidence (load-run replay).
    if (isReviewableTerminalRun(preferred)) return preferred;
    return preferred.slotId === slotId && isActiveRun(preferred) ? preferred : null;
  }

  const slot = state.fleet?.slots.find((s) => s.slot === slotId);
  if (slot?.currentRunId) {
    const current = state.runs.find((r) => r.id === slot.currentRunId);
    if (current && (isActiveRun(current) || isReviewableTerminalRun(current))) return current;
    // currentRunId is set but the run is not in the local cache (e.g. fleet
    // and runs slices arrived in different orders during reconnect). Return
    // null instead of falling through to a slotId-only scan, which can pick
    // an older active run for the same slot and briefly mis-route the linked
    // run + role tabs in the UI until the runs slice catches up.
    return null;
  }
  return state.runs.find((r) => r.slotId === slotId && isActiveRun(r)) ?? null;
}

export function setConnection(conn: ConnectionState): void {
  state.connection = conn;
  notify();
}

export function updateGitHubQuota(quota: GitHubRateLimitPayload): void {
  state.githubQuota = quota;
  notify();
}

export function getHydratedEpoch(): number {
  return lastHydratedEpoch;
}

export function waitForCoreHydration(epoch?: number): Promise<void> {
  if (epoch == null || lastHydratedEpoch >= epoch) return Promise.resolve();
  return coreHydrationPromise;
}

// --- Wire up gateway events ---

export function initState(): void {
  initializeResourceCache();
  subscribeResourceCache(bindFarmCollections);
  bindFarmCollections();
  // Keep URL ↔ state in sync: inbound hash changes refresh filter state; state
  // changes re-write the hash so filters ride along across route navigations.
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
      // hashchange fires only on real user navigation (link click, back/forward,
      // direct address-bar edit). All in-app filter writes use replaceState,
      // which does not fire hashchange — so reaching this handler always means
      // we should re-sync state from the URL.
      const fromHash = parseFiltersFromHash();
      if (fromHash && !filtersEqual(fromHash, state.globalFilters)) {
        state.globalFilters = fromHash;
        persistFilters(fromHash);
        notify();
      } else if (
        !fromHash &&
        (state.globalFilters.projects.length > 0 || state.globalFilters.machines.length > 0)
      ) {
        // Route navigation stripped the query — restore filters from state.
        // Use history.replaceState so we rewrite the current entry in place
        // instead of pushing a new one. Assigning location.hash here would
        // create a second history entry per navigation, and pressing Back
        // would land on the filterless intermediate URL and get rewritten
        // forward again, effectively breaking Back while filters are active.
        history.replaceState(null, '', filtersHash(state.globalFilters));
      }
    });
  }

  // Connection state
  gateway.onConnectionChange((conn) => {
    if (conn !== 'connected') {
      // Discard any in-flight bootstrap — its buffered events belong to the
      // dead connection and would corrupt the next one if drained.
      activeBootstrap = null;
      resetBootstrapState();
    }
    const ownerChanged = syncWorkspaceOwner(conn);
    bindFarmCollections();
    setConnection(conn);
    if (ownerChanged) notifyWorkspaceOwnerChange();
    if (conn === 'connected' && gateway.workspaceAccess === 'farm') {
      const epoch = gateway.connectionEpoch;
      void fetchInitialState(epoch);
    }
  });

  // GitHub API rate-limit telemetry (github-client.ts emits after each call).
  gateway.subscribe<GitHubRateLimitPayload>(Events.GITHUB_RATE_LIMIT, (p) => {
    updateGitHubQuota(p);
  });

  // Monitor violations
  gateway.subscribe<MonitorViolationPayload>(Events.MONITOR_VIOLATION, (p) => {
    if (p.violation) {
      recordMonitorViolation(p.violation);
    }
  });
}

async function fetchInitialState(epoch = gateway.connectionEpoch): Promise<void> {
  // Guarantee the returned promise never rejects so `waitForCoreHydration`
  // callers (slot-view, ready-workspace, review-workspace) never get an
  // unhandled rejection if `gateway.request` throws during a flaky reconnect.
  const bs = newBootstrapState(epoch);
  const coreHydration = deferredVoid();
  coreHydrationPromise = coreHydration.promise;
  activeBootstrap = bs;
  try {
    await runFetchInitialState(bs, coreHydration.resolve);
  } catch (err) {
    console.error('[state] fetchInitialState failed:', err);
    if (gateway.connectionEpoch === epoch && activeBootstrap === bs) {
      // Flush each slice's buffer so live events that arrived before the
      // synchronous failure still apply — the whole point of buffering is
      // to keep them alive across the bootstrap window.
      // Drain runs before decisions so `buildAndAdd` callbacks sitting in
      // the decisions buffer see the hydrated runs list. Unlike the
      // success path, the failure path drains decisions unconditionally
      // (no `pendingDecisionsDrain` gate) — we're giving up and want any
      // late-arriving events to land with whatever runs data we have.
      coalesceNotify(() => {
        const drainOrder: HydratedSlice[] = [
          'fleet',
          'prs',
          'runs',
          'decisions',
          'queue',
          'projects',
        ];
        for (const slice of drainOrder) {
          const queued = bs.buffer[slice];
          bs.buffer[slice] = [];
          bs.ready.add(slice);
          for (const fn of queued) {
            try {
              fn();
            } catch {
              /* event handler error */
            }
          }
        }
        state.hydrated = Object.fromEntries(
          (Object.keys(EMPTY_HYDRATED) as HydratedSlice[]).map((k) => [k, true]),
        ) as HydratedSlices;
        // Whatever threw pre-`.catch` means no slice has authoritative data,
        // so mark every slice failed — views gate their own retries on this.
        state.bootstrapFailed = Object.fromEntries(
          (Object.keys(EMPTY_HYDRATED) as HydratedSlice[]).map((k) => [k, true]),
        ) as HydratedSlices;
        notify();
      });
    }
  } finally {
    coreHydration.resolve();
    // Only null the pointer if we're still the active bootstrap — a newer
    // reconnect may have replaced us mid-flight and must keep its buffer.
    if (activeBootstrap === bs) activeBootstrap = null;
  }
}

async function runFetchInitialState(
  bs: BootstrapState,
  resolveCoreHydration: () => void,
): Promise<void> {
  const epoch = bs.epoch;
  const stillCurrent = () =>
    gateway.connectionState === 'connected' &&
    gateway.workspaceAccess === 'farm' &&
    gateway.connectionEpoch === epoch;

  const drainSlice = (slice: HydratedSlice) => {
    if (activeBootstrap !== bs) return;
    const queued = bs.buffer[slice];
    bs.buffer[slice] = [];
    if (queued.length === 0) return;
    // Coalesce per-event notifies into a single listener sweep at the end
    // — a 50-PR reconnect drain otherwise fires 50 sweeps through every
    // subscriber in this tick.
    coalesceNotify(() => {
      for (const fn of queued) {
        try {
          fn();
        } catch {
          /* event handler error */
        }
      }
    });
  };
  const flipReady = (slice: HydratedSlice) => {
    bs.ready.add(slice);
    state.hydrated = { ...state.hydrated, [slice]: true };
    notify();
  };
  const markFailed = (slice: HydratedSlice) => {
    if (!stillCurrent()) return;
    if (activeBootstrap !== bs) return; // stale rejection from replaced bootstrap
    state.bootstrapFailed = { ...state.bootstrapFailed, [slice]: true };
  };

  // markReady fires when each snapshot RPC settles. For most slices it
  // flips the hydrated bit, drains buffered events in insertion order, and
  // notifies. Decisions depend on runs for runMeta, so if decisions is ready
  // first its drain is deferred until runs settles — this keeps every event
  // for a given decision ID (NEW → RESOLVED) draining in original order, so
  // a resolved decision can't be re-added by a late buildAndAdd.
  const markReady = (slice: HydratedSlice) => {
    if (!stillCurrent()) return;
    if (activeBootstrap !== bs) return; // replaced by newer bootstrap
    if (slice === 'decisions' && !bs.ready.has('runs')) {
      bs.pendingDecisionsDrain = true;
      return;
    }
    flipReady(slice);
    drainSlice(slice);
    if (slice === 'runs' && bs.pendingDecisionsDrain) {
      bs.pendingDecisionsDrain = false;
      flipReady('decisions');
      drainSlice('decisions');
    }
  };

  // Snapshot-first, events-after ordering. Each RPC replaces its slice with
  // the gateway's view at time T. Live events that arrived during the RPC
  // window were buffered and drain in `markReady`, so deletions and newer
  // updates naturally overwrite stale snapshot entries. We preserve the prior
  // snapshot across a transient disconnect so detail routes don't flash
  // "not found" while the replacement snapshot is in flight. Operator-facing
  // slices (fleet/runs/prs) also retain their last snapshot on bootstrap
  // failure and mark the slice failed so the UI can show "cached/stale"
  // affordances instead of false empty states; ephemeral slices that do not
  // have a safe stale rendering path still clear below.
  const cache = getResourceCache();
  const fleetJob = (
    cache
      ? cache.retry(fleetQuery)
      : Promise.reject(new Error('Offline fleet store is unavailable'))
  )
    .catch(() => markFailed('fleet'))
    .finally(() => markReady('fleet'));
  const decisionsJob = (
    cache
      ? cache.retry(decisionsQuery)
      : Promise.reject(new Error('Offline decision store is unavailable'))
  )
    .catch(() => markFailed('decisions'))
    .finally(() => markReady('decisions'));
  const runsJob = (
    cache
      ? Promise.all([cache.retry(runHistoryQuery), cache.retry(activeRunsQuery)])
      : Promise.reject(new Error('Offline run store is unavailable'))
  )
    .catch(() => markFailed('runs'))
    .finally(() => markReady('runs'));
  const queueJob = (
    cache
      ? cache.retry(queueQuery)
      : Promise.reject(new Error('Offline planning store is unavailable'))
  )
    .catch(() => markFailed('queue'))
    .finally(() => markReady('queue'));
  const backlogJob = (
    cache
      ? cache.retry(backlogQuery)
      : Promise.reject(new Error('Offline planning store is unavailable'))
  )
    .catch(() => markFailed('backlog'))
    .finally(() => markReady('backlog'));
  const workGraphsJob = (
    cache
      ? cache.retry(workGraphsQuery)
      : Promise.reject(new Error('Offline planning store is unavailable'))
  )
    .catch(() => markFailed('workGraphs'))
    .finally(() => markReady('workGraphs'));
  const projectsJob = (
    cache
      ? cache.retry(projectsQuery)
      : Promise.reject(new Error('Configuration store is unavailable'))
  )
    .catch(() => markFailed('projects'))
    .finally(() => markReady('projects'));

  // PRs recover independently through their cache observer; core workspaces do not await GitHub.
  await Promise.allSettled([
    fleetJob,
    decisionsJob,
    runsJob,
    queueJob,
    backlogJob,
    workGraphsJob,
    projectsJob,
  ]);
  if (stillCurrent()) {
    lastHydratedEpoch = epoch;
    notify();
  }
  resolveCoreHydration();
}
