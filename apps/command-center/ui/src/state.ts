// Reactive state store — holds fleet/PR/decision data, updated by gateway events

import type {
  BacklogItem,
  BacklogListResult,
  BacklogUpdatedPayload,
  ConfigProjectsResult,
  DecisionListResult,
  DecisionNewPayload,
  DecisionResolvedPayload,
  DispatchQueueListResult,
  FleetStatus,
  FleetStatusResult,
  FleetUpdatedPayload,
  GitHubRateLimitPayload,
  MonitorViolation,
  MonitorViolationPayload,
  PendingDecision,
  PRListResult,
  PRStatus,
  PRUpdatedPayload,
  QueueItem,
  QueueUpdatedPayload,
  Run,
  RunCompletedPayload,
  RunCreatedPayload,
  RunDeletedPayload,
  RunFamilyReadinessSummary,
  RunListResult,
  RunListSummaryMeta,
  RunProjectAnalyticsSummary,
  RunUpdatedPayload,
  SlotChangedPayload,
  SlotStatus,
} from '@farmslot/protocol';
import {
  buildRunFamilyReadinessSummaries,
  buildRunProjectAnalyticsSummaries,
  DEFAULT_BRANCH,
  Events,
  Methods,
} from '@farmslot/protocol';

import { notify as browserNotify } from './utils/notifications.js';
import { safeLsGet, safeLsRemove } from './utils/storage.js';
import { type ConnectionState, gateway } from './gateway-client.js';
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
  | 'projects';
export type HydratedSlices = Record<HydratedSlice, boolean>;

const EMPTY_HYDRATED: HydratedSlices = {
  fleet: false,
  prs: false,
  decisions: false,
  runs: false,
  queue: false,
  backlog: false,
  projects: false,
};

export function isFullyHydrated(h: HydratedSlices): boolean {
  return (Object.values(h) as boolean[]).every(Boolean);
}

export function isHydrating(s: AppState, slice: HydratedSlice): boolean {
  return s.connection === 'connected' && !s.hydrated[slice];
}

export interface AppState {
  connection: ConnectionState;
  hydrated: HydratedSlices;
  // `true` iff the most recent bootstrap snapshot RPC for this slice
  // rejected. Views consult this on the hydrating→hydrated transition to
  // decide whether to retry their own fetch instead of showing stale data
  // left over from a prior connection. Reset on disconnect.
  bootstrapFailed: HydratedSlices;
  fleet: FleetStatus | null;
  prs: PRStatus[];
  decisions: PendingDecision[];
  runs: Run[];
  runSummaryMeta: RunListSummaryMeta | null;
  runFamilySummaries: RunFamilyReadinessSummary[];
  runProjectAnalytics: RunProjectAnalyticsSummary[];
  queueItems: QueueItem[];
  backlogItems: BacklogItem[];
  violations: MonitorViolation[];
  prsUpdatedAt: number;
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
  | 'runs'
  | 'runSummaryMeta'
  | 'runFamilySummaries'
  | 'runProjectAnalytics'
  | 'queueItems'
  | 'backlogItems'
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
  connection: 'disconnected',
  hydrated: { ...EMPTY_HYDRATED },
  bootstrapFailed: { ...EMPTY_HYDRATED },
  fleet: null,
  prs: [],
  decisions: [],
  runs: [],
  runSummaryMeta: null,
  runFamilySummaries: [],
  runProjectAnalytics: [],
  queueItems: [],
  backlogItems: [],
  violations: [],
  prsUpdatedAt: 0,
  globalFilters: loadGlobalFilters(),
  projectDefaultBranches: {},
  projectSlotTracking: {},
  githubQuota: null,
};

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
  map: Record<string, { defaultBranch: string; slotTrackingBranch?: string; worktreeBase?: string }>,
): void {
  state.projectSlotTracking = map;
  notify();
}

// pr.list fans out into several gh calls per candidate PR; cold/reconnect
// runs routinely exceed the 15s default. Used by both the shared bootstrap
// in fetchInitialState and pr-board's manual/poll refresh.
export const PR_LIST_TIMEOUT_MS = 30_000;

// Flow types that are expected to produce a PR. `dev` runs are exploratory
// and may legitimately finish on a side branch without one.
const PR_PRODUCING_FLOWS = new Set<Run['flowType']>([
  'fix-bug',
  'review-pr',
  'pr-complete',
  'merge-main',
]);
const TERMINAL_RUN_STATUSES = new Set<Run['status']>(['done', 'failed', 'cancelled']);

function isActiveRun(run: Run): boolean {
  return !TERMINAL_RUN_STATUSES.has(run.status);
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
    buffer: { fleet: [], prs: [], decisions: [], runs: [], queue: [], backlog: [], projects: [] },
    pendingDecisionsDrain: false,
  };
}

function deferEvent(slice: HydratedSlice, fn: () => void): void {
  if (!activeBootstrap || activeBootstrap.ready.has(slice)) {
    fn();
    return;
  }
  activeBootstrap.buffer[slice].push(fn);
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

// --- Public API ---

export function getState(): Readonly<AppState> {
  return state;
}

export function captureStateSlices(): AppStateSliceSnapshot {
  return {
    fleet: state.fleet,
    prs: state.prs,
    runs: state.runs,
    runSummaryMeta: state.runSummaryMeta,
    runFamilySummaries: state.runFamilySummaries,
    runProjectAnalytics: state.runProjectAnalytics,
    queueItems: state.queueItems,
    backlogItems: state.backlogItems,
    bootstrapFailed: state.bootstrapFailed,
  };
}

export function restoreStateSlices(snapshot: AppStateSliceSnapshot): void {
  state.fleet = snapshot.fleet;
  state.prs = snapshot.prs;
  state.runs = snapshot.runs;
  state.runSummaryMeta = snapshot.runSummaryMeta;
  state.runFamilySummaries = snapshot.runFamilySummaries;
  state.runProjectAnalytics = snapshot.runProjectAnalytics;
  state.queueItems = snapshot.queueItems;
  state.backlogItems = snapshot.backlogItems;
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

export function updateSlot(slot: SlotStatus): void {
  if (!state.fleet) return;
  const idx = state.fleet.slots.findIndex((s) => s.slot === slot.slot);
  const prev = idx >= 0 ? state.fleet.slots[idx] : null;
  const newSlots = [...state.fleet.slots];
  if (idx >= 0) {
    newSlots[idx] = slot;
  } else {
    newSlots.push(slot);
  }

  // Detect dispatch completion: working -> released/ready
  if (prev?.lifecycle === 'busy' && slot.lifecycle === 'ready') {
    browserNotify('Dispatch complete', {
      body: `${slot.slot} finished (${slot.taskId || 'task'})`,
      tag: `complete-${slot.slot}`,
      route: `#slot/${slot.slot}`,
    });
  }

  state.fleet = { ...state.fleet, slots: newSlots };
  notify();
}

export function updatePRs(prs: PRStatus[]): void {
  state.prs = prs;
  state.prsUpdatedAt = Date.now();
  state.bootstrapFailed = { ...state.bootstrapFailed, prs: false };
  notify();
}

function samePRKey(a: Pick<PRStatus, 'repo' | 'pr'>, b: Pick<PRStatus, 'repo' | 'pr'>): boolean {
  return a.repo === b.repo && a.pr === b.pr;
}

export function updatePR(pr: PRStatus): void {
  const idx = state.prs.findIndex((p) => samePRKey(p, pr));
  // Replace the array ref so `this._prs = s.prs` in subscribers triggers
  // Lit's reactive comparison; in-place mutation would be missed.
  state.prs = idx >= 0 ? state.prs.map((p, i) => (i === idx ? pr : p)) : [...state.prs, pr];
  state.prsUpdatedAt = Date.now();
  state.bootstrapFailed = { ...state.bootstrapFailed, prs: false };
  notify();
}

export function markPRsRefreshFailed(): void {
  state.bootstrapFailed = { ...state.bootstrapFailed, prs: true };
  notify();
}

export function updateDecisions(decisions: PendingDecision[]): void {
  state.decisions = decisions;
  notify();
}

/**
 * Merge a snapshot from `decision.list` into local state. Caller passes the
 * set of decision ids known BEFORE the snapshot request was fired; any
 * local id outside that set arrived during the request window (e.g. an
 * analyzing placeholder via RUN_DECISION_NEW) and must survive the merge.
 * Old local ids absent from the snapshot are server-resolved → drop.
 */
export function mergeDecisions(snapshot: PendingDecision[], preRequestIds: Set<string>): void {
  const snapshotIds = new Set(snapshot.map((d) => d.id));
  const newLocal = state.decisions.filter(
    (d) => !snapshotIds.has(d.id) && !preRequestIds.has(d.id),
  );
  state.decisions = [...snapshot, ...newLocal];
  notify();
}

export function addDecision(decision: PendingDecision): void {
  if (state.decisions.some((d) => d.id === decision.id)) return;
  state.decisions = [...state.decisions, decision];
  browserNotify('Decision needed', {
    body: `${decision.title}`,
    tag: `decision-${decision.id}`,
    route: '#decisions',
  });
  notify();
}

export function removeDecision(id: string): void {
  state.decisions = state.decisions.filter((d) => d.id !== id);
  notify();
}

export function updateDecision(decision: PendingDecision): void {
  const idx = state.decisions.findIndex((d) => d.id === decision.id);
  // Strictly an update — if the id isn't in the inbox the decision was either
  // never seen (NEW arrived after UPDATED — unlikely with the gateway's
  // ordering) or already removed via RESOLVED. Re-adding here would resurrect
  // a resolved card; safer to drop. Log so the rare reorder/reload race is
  // visible rather than silently swallowed.
  if (idx === -1) {
    console.warn(
      `[state] updateDecision dropped — id=${decision.id.slice(0, 8)} not in inbox (NEW unseen or already RESOLVED)`,
    );
    return;
  }
  state.decisions = state.decisions.map((d, i) => (i === idx ? decision : d));
  notify();
}

/**
 * Drop any local decisions that the run's authoritative `decisions` array now
 * shows as resolved. Recovers the inbox from missed RUN_DECISION_RESOLVED
 * events (e.g. when the resolve happened in another tab or before subscribe).
 */
export function sweepResolvedFromRun(run: Run): void {
  const resolvedIds = new Set((run.decisions ?? []).filter((d) => d.resolvedAt).map((d) => d.id));
  if (resolvedIds.size === 0) return;
  const before = state.decisions.length;
  state.decisions = state.decisions.filter((d) => !resolvedIds.has(d.id));
  if (state.decisions.length !== before) notify();
}

// Bootstrap path: server returns authoritative summaries with `totalCount`. Adopt
// them as-is. Live path (`upsertRun`/`removeRun`) recomputes locally from the
// already-flowing `RUN_*` events so the strip never goes stale and we don't
// burn a round-trip per delta. Helper is pure (no fs/network — enforced by
// `protocol/run-family-readiness.test.ts`), so doing it client-side is cheap.
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

export function upsertRun(run: Run): void {
  const idx = state.runs.findIndex((r) => r.id === run.id);
  state.runs = idx >= 0 ? state.runs.map((r, i) => (i === idx ? run : r)) : [run, ...state.runs];
  // Track local create against the server-snapshot total so isTruncated reflects
  // the post-event state. RUN_DELETED would otherwise flip isTruncated=true even
  // when totalCount and runs.length both dropped together.
  if (idx < 0 && state.runSummaryMeta) {
    state.runSummaryMeta = {
      ...state.runSummaryMeta,
      totalCount: state.runSummaryMeta.totalCount + 1,
    };
  }
  recomputeRunSummariesInPlace();
  notify();
}

export function removeRun(runId: string): void {
  const before = state.runs.length;
  state.runs = state.runs.filter((r) => r.id !== runId);
  if (state.runs.length !== before && state.runSummaryMeta) {
    state.runSummaryMeta = {
      ...state.runSummaryMeta,
      totalCount: Math.max(0, state.runSummaryMeta.totalCount - 1),
    };
  }
  recomputeRunSummariesInPlace();
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
    setConnection(conn);
    if (conn === 'connected') {
      const epoch = gateway.connectionEpoch;
      void fetchInitialState(epoch);
    }
  });

  // Fleet events
  gateway.subscribe<FleetUpdatedPayload>(Events.FLEET_UPDATED, (p) => {
    if (p.fleet) deferEvent('fleet', () => updateFleet(p.fleet!));
  });

  gateway.subscribe<SlotChangedPayload>(Events.SLOT_CHANGED, (p) => {
    if (p.slot) deferEvent('fleet', () => updateSlot(p.slot!));
  });

  // PR events
  gateway.subscribe<PRUpdatedPayload>(Events.PR_UPDATED, (p) => {
    if (p.pr) deferEvent('prs', () => updatePR(p.pr!));
  });

  // Decision events (file-based + run-based).
  // The emitter shape is two flavors: either { decision, slotId, runId } or the decision fields
  // spread directly onto the root. Normalize both here.
  //
  // Used by both NEW and UPDATED handlers so a placeholder card swapped in
  // place keeps its runMeta + slotId + context (Apply/Chat need runId).
  const buildPendingDecision = (p: DecisionNewPayload): PendingDecision | null => {
    const d = p.decision ?? p;
    if (!d.id) return null;
    let runMeta: PendingDecision['runMeta'];
    if (p.runId) {
      const run = state.runs.find((r) => r.id === p.runId);
      if (run) {
        runMeta = {
          runId: run.id,
          familyId: run.familyId,
          flowType: run.flowType,
          ticketOrPr: run.ticketOrPr,
          prNumber: run.prNumber ?? undefined,
          branch: run.branch ?? undefined,
          runner: run.metrics?.runner ?? undefined,
          model: run.metrics?.model ?? undefined,
          summary: run.summary ?? undefined,
        };
      }
    }
    const payload = 'payload' in d ? d.payload : undefined;
    return {
      id: d.id,
      type: (d.type ?? 'unknown') as PendingDecision['type'],
      slotId: p.slotId ?? null,
      title: d.title ?? '',
      description: d.description ?? '',
      context: { runId: p.runId, ...(d.context ?? {}) },
      actions: d.actions ?? [],
      createdAt: d.createdAt ?? new Date().toISOString(),
      payload,
      runMeta,
    };
  };

  const onDecisionNew = (p: DecisionNewPayload) => {
    // Build the decision only after the runs slice has drained, so runMeta
    // reflects any buffered RUN_CREATED/RUN_UPDATED for the decision's run.
    // Slices drain in RPC-resolution order, so DECISION_LIST may finish
    // before RUN_LIST. The decisions buffer itself is gated behind runs in
    // `markReady` via `pendingDecisionsDrain`. Every decision event for a
    // decision ID stays in the decisions buffer and drains in insertion order,
    // so a DECISION_NEW → DECISION_RESOLVED sequence cannot re-add a resolved
    // decision.
    deferEvent('decisions', () => {
      const decision = buildPendingDecision(p);
      if (decision) addDecision(decision);
    });
  };
  gateway.subscribe<DecisionNewPayload>(Events.DECISION_NEW, onDecisionNew);
  gateway.subscribe<DecisionNewPayload>(Events.RUN_DECISION_NEW, onDecisionNew);

  const onDecisionResolved = (p: DecisionResolvedPayload) => {
    const id = p.id ?? p.decisionId;
    if (id) deferEvent('decisions', () => removeDecision(id));
  };
  gateway.subscribe<DecisionResolvedPayload>(Events.DECISION_RESOLVED, onDecisionResolved);
  gateway.subscribe<DecisionResolvedPayload>(Events.RUN_DECISION_RESOLVED, onDecisionResolved);

  const onDecisionUpdated = (p: DecisionNewPayload) => {
    deferEvent('decisions', () => {
      const decision = buildPendingDecision(p);
      if (decision) updateDecision(decision);
    });
  };
  gateway.subscribe<DecisionNewPayload>(Events.DECISION_UPDATED, onDecisionUpdated);
  gateway.subscribe<DecisionNewPayload>(Events.RUN_DECISION_UPDATED, onDecisionUpdated);

  // Run events
  gateway.subscribe<RunCreatedPayload>(Events.RUN_CREATED, (p) => {
    if (p.run) {
      console.log(
        `[state] RUN_CREATED runId=${p.run.id.slice(0, 8)} status=${p.run.status} decisions=${p.run.decisions?.length ?? 0}`,
      );
      deferEvent('runs', () => upsertRun(p.run!));
    }
  });

  gateway.subscribe<RunUpdatedPayload>(Events.RUN_UPDATED, (p) => {
    if (p.run) {
      const unresolvedReview = (p.run.decisions ?? []).some(
        (d) => !d.resolvedAt && (d.payload as { kind?: string } | undefined)?.kind === 'review',
      );
      console.log(
        `[state] RUN_UPDATED runId=${p.run.id.slice(0, 8)} status=${p.run.status} decisions=${p.run.decisions?.length ?? 0} unresolvedReview=${unresolvedReview}`,
      );
      deferEvent('runs', () => upsertRun(p.run!));
      // Authoritative sweep — drop any local decisions the run already shows as
      // resolved (recovers from missed DECISION_RESOLVED events after restart
      // or cross-tab resolves).
      const run = p.run!;
      deferEvent('decisions', () => sweepResolvedFromRun(run));
    }
  });

  gateway.subscribe<RunCompletedPayload>(Events.RUN_COMPLETED, (p) => {
    if (p.run) {
      console.log(`[state] RUN_COMPLETED runId=${p.run.id.slice(0, 8)} status=${p.run.status}`);
      deferEvent('runs', () => upsertRun(p.run!));
    }
  });

  gateway.subscribe<RunDeletedPayload>(Events.RUN_DELETED, (p) => {
    if (p.runId) deferEvent('runs', () => removeRun(p.runId));
  });

  // Queue events
  gateway.subscribe<QueueUpdatedPayload>(Events.QUEUE_UPDATED, (p) => {
    if (p.items) deferEvent('queue', () => updateQueueItems(p.items));
  });

  // Backlog events
  gateway.subscribe<BacklogUpdatedPayload>(Events.BACKLOG_UPDATED, (p) => {
    if (p.items) deferEvent('backlog', () => updateBacklogItems(p.items));
  });

  // GitHub API rate-limit telemetry (github-client.ts emits after each call).
  gateway.subscribe<GitHubRateLimitPayload>(Events.GITHUB_RATE_LIMIT, (p) => {
    updateGitHubQuota(p);
  });

  // Monitor violations
  gateway.subscribe<MonitorViolationPayload>(Events.MONITOR_VIOLATION, (p) => {
    if (p.violation) {
      recordMonitorViolation(p.violation);
      browserNotify(`Agent ${p.violation.type}`, {
        body: `${p.violation.slotId}: ${p.violation.message}`,
        tag: `violation-${p.violation.slotId}-${p.violation.type}`,
        route: p.violation.slotId ? `#slot/${p.violation.slotId}` : '#fleet',
      });
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
    gateway.connectionState === 'connected' && gateway.connectionEpoch === epoch;

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
  const fleetJob = gateway
    .request<FleetStatusResult>(Methods.FLEET_STATUS)
    .then((r) => {
      if (stillCurrent() && r.fleet) updateFleet(r.fleet);
    })
    .catch(() => markFailed('fleet'))
    .finally(() => markReady('fleet'));
  const decisionsJob = gateway
    .request<DecisionListResult>(Methods.DECISION_LIST)
    .then((r) => {
      if (stillCurrent() && r.decisions) updateDecisions(r.decisions);
    })
    .catch(() => {
      if (stillCurrent()) updateDecisions([]);
      markFailed('decisions');
    })
    .finally(() => markReady('decisions'));
  const runsJob = gateway
    .request<RunListResult>(Methods.RUN_LIST, {
      limit: 1000,
      includeFamilySummaries: true,
      includeProjectAnalytics: true,
    })
    .then((r) => {
      if (stillCurrent() && r.runs) updateRuns(r.runs, r);
    })
    .catch(() => markFailed('runs'))
    .finally(() => markReady('runs'));
  const queueJob = gateway
    .request<DispatchQueueListResult>(Methods.DISPATCH_QUEUE_LIST, {})
    .then((r) => {
      if (stillCurrent() && r.items) updateQueueItems(r.items);
    })
    .catch(() => {
      if (stillCurrent()) updateQueueItems([]);
      markFailed('queue');
    })
    .finally(() => markReady('queue'));
  const backlogJob = gateway
    .request<BacklogListResult>(Methods.BACKLOG_LIST, { includeArchived: true })
    .then((r) => {
      if (stillCurrent() && r.items) updateBacklogItems(r.items);
    })
    .catch(() => {
      if (stillCurrent()) updateBacklogItems([]);
      markFailed('backlog');
    })
    .finally(() => markReady('backlog'));
  const projectsJob = gateway
    .request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {})
    .then((r) => {
      if (stillCurrent() && r.projects) {
        updateProjectDefaultBranches(
          Object.fromEntries(r.projects.map((p) => [p.name, p.defaultBranch || DEFAULT_BRANCH])),
        );
        updateProjectSlotTracking(
          Object.fromEntries(
            r.projects.map((p) => [
              p.name,
              {
                defaultBranch: p.defaultBranch || DEFAULT_BRANCH,
                slotTrackingBranch: p.slotTrackingBranch,
                worktreeBase: p.worktreeBase,
              },
            ]),
          ),
        );
      }
    })
    .catch(() => {
      if (stillCurrent()) {
        updateProjectDefaultBranches({});
        updateProjectSlotTracking({});
      }
      markFailed('projects');
    })
    .finally(() => markReady('projects'));

  // PR_LIST fans out across multiple gh calls per candidate PR; cold runs
  // routinely exceed the 15s default. Keep the 30s budget but gate
  // `waitForCoreHydration` on the five core slices only — workspace recovery
  // (slot-view, ready/review workspaces) has no PR dependency and must not
  // wait up to 30s on GitHub latency. The prs job still participates in
  // the bootstrap lifecycle (awaited before activeBootstrap is cleared) so
  // `markReady('prs')` lands under the correct identity guard, the buffer
  // drains, and hydrated.prs flips.
  const prsJob = gateway
    .request<PRListResult>(Methods.PR_LIST, undefined, PR_LIST_TIMEOUT_MS)
    .then((r) => {
      if (stillCurrent() && r.prs) updatePRs(r.prs);
    })
    .catch(() => markFailed('prs'))
    .finally(() => markReady('prs'));

  // Gate `waitForCoreHydration` on the five core slices. Any caller awaiting
  // it after this point sees lastHydratedEpoch bumped even if PR_LIST is
  // still in flight, which is what spares workspace recovery from the
  // PR_LIST timeout.
  await Promise.allSettled([fleetJob, decisionsJob, runsJob, queueJob, backlogJob, projectsJob]);
  if (stillCurrent()) {
    lastHydratedEpoch = epoch;
    notify();
  }
  resolveCoreHydration();
  // Keep activeBootstrap alive until PR_LIST settles too, so its
  // markReady/markFailed run under the correct identity guard.
  await prsJob;
}
