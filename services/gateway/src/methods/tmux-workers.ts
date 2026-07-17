// methods/tmux-workers.ts — registered-node tmux worker inventory

import type {
  FleetStatus,
  NodeTmuxPane,
  NodeTmuxPanesResult,
  PoolConfig,
  Run,
  RunStatus,
  TmuxWorkerActivityState,
  TmuxWorkerAttentionReason,
  TmuxWorkerFilterConfig,
  TmuxWorkerFilterRule,
  TmuxWorkerListParams,
  TmuxWorkerListResult,
  TmuxWorkerNodeResult,
  TmuxWorkerNodeSummary,
  TmuxWorkerSummary,
} from '@farmslot/protocol';

import { getAllNodes, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { loadFleetStatus, loadPoolConfigs } from '../fleet/state.js';
import { isRunnerPaneRetired, normalizeRunner } from '../runners/registry.js';
import { listRuns } from '../runs/store.js';

const TMUX_PANES_TIMEOUT_MS = 5_000;
const SIGNAL_FRESH_MS = 120_000;
const PANE_RECENT_CHANGE_MS = 30_000;
const NODE_TMUX_PUSH_SNAPSHOT_FRESH_MS = 30_000;
// Degraded fallback when live tmux.panes times out — cap age so inventory cannot lie forever.
const NODE_TMUX_STALE_FALLBACK_MAX_MS = 5 * 60_000;
const FILTERED_WORKER_ERROR = 'worker target is excluded by tmux worker filter config';
const nodeTmuxPaneSnapshots = new Map<string, { observedAt: number; panes: NodeTmuxPane[] }>();

const WAITING_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'blocked',
  'paused',
  'human-gating',
  'ci-watching',
]);

function isFresh(signalObservedAt: number | undefined, now: number): boolean {
  return signalObservedAt != null && now - signalObservedAt <= SIGNAL_FRESH_MS;
}

function tmuxPaneActivityState(
  pane: NodeTmuxPane,
  observedAt: number,
  activityHint?: TmuxWorkerActivityState,
): TmuxWorkerActivityState {
  const statusline = pane.signals?.statusline;
  if (statusline && isFresh(statusline.observedAt, observedAt)) {
    if (statusline.busy === true) return 'active';
    if (statusline.busy === false) return 'idle';
    const label = statusline.label?.toLowerCase();
    if (label && /busy|running|working|thinking|composing/u.test(label)) return 'active';
    if (label && /waiting|input-needed|approval-needed/u.test(label)) return 'waiting';
    if (label && /idle|ready|prompt|stopped/u.test(label)) return 'idle';
  }
  const hook = pane.signals?.hook;
  if (hook && isFresh(hook.observedAt, observedAt)) {
    const event = (hook.event ?? hook.label)?.toLowerCase();
    if (event && /waiting|input-needed|approval-needed/u.test(event)) return 'waiting';
    if (event && /stop|idle|ready|prompt/u.test(event)) return 'idle';
    return 'active';
  }
  const taskFile = pane.signals?.taskFile;
  if (taskFile && isFresh(taskFile.observedAt, observedAt)) {
    const status = taskFile.status?.toLowerCase();
    if (status && /waiting|input-needed|approval-needed/u.test(status)) return 'waiting';
    if (status && /done|complete|success|idle|ready/u.test(status)) return 'idle';
    return 'active';
  }
  const processSignal = pane.signals?.process;
  if (processSignal && isFresh(processSignal.observedAt, observedAt) && processSignal.active) {
    return 'active';
  }
  if (activityHint) return activityHint;
  if (pane.lastChangedAt != null) {
    const age = observedAt - pane.lastChangedAt;
    if (age <= PANE_RECENT_CHANGE_MS) return 'active';
    return 'idle';
  }
  return 'unknown';
}

function attentionReasonForRunnerState(
  state: TmuxWorkerActivityState | undefined,
): TmuxWorkerAttentionReason | undefined {
  if (state === 'waiting') return 'waiting';
  if (state === 'idle') return 'idle';
  return undefined;
}

function withAttention(
  status: TmuxWorkerSummary['status'],
  reason: TmuxWorkerAttentionReason | undefined,
): TmuxWorkerSummary['status'] {
  return reason ? { ...status, requiresAttention: true, attentionReason: reason } : status;
}

export function tmuxWorkerStatusFromPane(
  pane: NodeTmuxPane,
  observedAt: number,
  activityHint?: TmuxWorkerActivityState,
  runner?: string,
): TmuxWorkerSummary['status'] {
  const signals = pane.signals;
  const hook = signals?.hook;
  if (hook && isFresh(hook.observedAt, observedAt)) {
    const state = tmuxPaneActivityState(pane, observedAt, activityHint);
    return withAttention(
      {
        label: hook.label ?? 'hook event',
        source: 'hook',
        confidence: 'high',
        observedAt: hook.observedAt,
        state,
      },
      attentionReasonForRunnerState(state),
    );
  }

  const statusline = signals?.statusline;
  if (statusline && isFresh(statusline.observedAt, observedAt)) {
    const state = tmuxPaneActivityState(pane, observedAt, activityHint);
    return withAttention(
      {
        label: statusline.label ?? 'statusline',
        source: 'statusline',
        confidence: 'high',
        observedAt: statusline.observedAt,
        state,
      },
      attentionReasonForRunnerState(state),
    );
  }

  // ADR-032 Phase 3A: for a runner whose pane is retired, there is no fresh hook/statusline
  // liveness above and no pane fallback for the send decision — surface observability-degraded
  // BEFORE the task-file/process signals below can mask it (stale AND fully-absent hooks both
  // qualify). isRunnerPaneRetired scopes this to event-driven runners with a hook provider under
  // the flag (per-runner or env), so pane-only runners and flag-off stay byte-identical.
  if (runner && isRunnerPaneRetired(normalizeRunner(runner))) {
    const signal = hook ?? statusline;
    return withAttention(
      {
        label: signal?.label ?? 'observability liveness lapsed',
        source: hook ? 'hook' : statusline ? 'statusline' : 'tmux',
        confidence: 'low',
        ...(signal?.observedAt != null
          ? { observedAt: signal.observedAt, stale: true }
          : { observedAt }),
        state: 'stale',
      },
      'observability-degraded',
    );
  }

  const taskFile = signals?.taskFile;
  if (taskFile) {
    const fresh = isFresh(taskFile.observedAt, observedAt);
    const state = fresh ? tmuxPaneActivityState(pane, observedAt, activityHint) : 'stale';
    return withAttention(
      {
        label: taskFile.label ?? 'task signal',
        source: 'task-file',
        confidence: fresh ? 'medium' : 'low',
        ...(taskFile.observedAt != null ? { observedAt: taskFile.observedAt } : { observedAt }),
        ...(taskFile.observedAt != null && !fresh ? { stale: true } : {}),
        state,
      },
      fresh ? attentionReasonForRunnerState(state) : 'stale-signal',
    );
  }

  const processSignal = signals?.process;
  if (processSignal && isFresh(processSignal.observedAt, observedAt) && processSignal.active) {
    return {
      label: processSignal.label ?? 'process active',
      source: 'tmux',
      confidence: 'medium',
      observedAt: processSignal.observedAt,
      state: 'active',
    };
  }

  if (hook || statusline) {
    const signal = hook ?? statusline;
    return withAttention(
      {
        label: signal?.label ?? 'stale worker signal',
        source: hook ? 'hook' : 'statusline',
        confidence: 'low',
        ...(signal?.observedAt != null
          ? { observedAt: signal.observedAt, stale: true }
          : { observedAt }),
        state: 'stale',
      },
      'stale-signal',
    );
  }

  return {
    label: pane.command ? `${pane.command} in tmux` : 'tmux pane',
    source: 'tmux',
    confidence: 'medium',
    observedAt,
    state: tmuxPaneActivityState(pane, observedAt, activityHint),
  };
}

function slotSession(slot: PoolConfig['slots'][number]): string | undefined {
  return slot.session || slot.id;
}

interface SlotCorrelation {
  slotId: string;
  runId?: string;
  familyId?: string;
  activityHint?: TmuxWorkerActivityState;
  /** Runner id of the correlated run — lets the status surface apply per-runner pane-retirement. */
  runner?: string;
}

function runActivityHint(run: Run | undefined): TmuxWorkerActivityState | undefined {
  if (!run) return undefined;
  return WAITING_RUN_STATUSES.has(run.status) ? 'waiting' : 'active';
}

function slotActivityHint(
  slot: FleetStatus['slots'][number] | undefined,
): TmuxWorkerActivityState | undefined {
  if (!slot?.currentRunId) return undefined;
  if (slot.lifecycle === 'busy') return 'active';
  if (slot.lifecycle === 'held' || slot.lifecycle === 'manual') return 'waiting';
  return undefined;
}

export function buildSessionCorrelation(
  pools: PoolConfig[],
  fleet: FleetStatus,
  activeRuns: Run[] = [],
): Map<string, Map<string, SlotCorrelation>> {
  const fleetBySlot = new Map(fleet.slots.map((slot) => [slot.slot, slot]));
  const activeRunBySlot = new Map<string, Run>();
  for (const run of activeRuns) {
    if (run.slotId && !activeRunBySlot.has(run.slotId)) activeRunBySlot.set(run.slotId, run);
  }
  const byMachine = new Map<string, Map<string, SlotCorrelation>>();
  for (const pool of pools) {
    if (!byMachine.has(pool.machine)) byMachine.set(pool.machine, new Map());
    const machineSessions = byMachine.get(pool.machine)!;
    for (const slot of pool.slots) {
      const session = slotSession(slot);
      if (!session || machineSessions.has(session)) continue;
      const fleetSlot = fleetBySlot.get(slot.id);
      const activeRun = activeRunBySlot.get(slot.id);
      const runId = fleetSlot?.currentRunId ?? activeRun?.id;
      const familyId = fleetSlot?.currentFamilyId ?? activeRun?.familyId;
      const activityHint = slotActivityHint(fleetSlot) ?? runActivityHint(activeRun);
      const runner = activeRun?.metrics?.runner;
      machineSessions.set(session, {
        slotId: slot.id,
        ...(runId ? { runId } : {}),
        ...(familyId ? { familyId } : {}),
        ...(activityHint ? { activityHint } : {}),
        ...(runner ? { runner } : {}),
      });
    }
  }
  return byMachine;
}

export function tmuxWorkerFromNodePane(params: {
  nodeId: string;
  pane: NodeTmuxPane;
  observedAt: number;
  correlation?: SlotCorrelation;
}): TmuxWorkerSummary {
  const { nodeId, pane, observedAt, correlation } = params;
  return {
    ref: {
      nodeId,
      session: pane.session,
      window: pane.window,
      ...(pane.windowName ? { windowName: pane.windowName } : {}),
      pane: pane.pane,
      ...(pane.paneId ? { paneId: pane.paneId } : {}),
      target: pane.target,
    },
    ...(pane.title ? { title: pane.title } : {}),
    ...(pane.cwd ? { cwd: pane.cwd } : {}),
    ...(pane.command ? { command: pane.command } : {}),
    ...(pane.pid != null ? { pid: pane.pid } : {}),
    ...(pane.width != null ? { width: pane.width } : {}),
    ...(pane.height != null ? { height: pane.height } : {}),
    ...(pane.active != null ? { active: pane.active } : {}),
    ...(correlation?.slotId ? { linkedSlotId: correlation.slotId } : {}),
    ...(correlation?.runId ? { linkedRunId: correlation.runId } : {}),
    ...(correlation?.familyId ? { linkedFamilyId: correlation.familyId } : {}),
    ...(pane.branch ? { branch: pane.branch } : {}),
    ...(pane.lastChangedAt != null ? { lastChangedAt: pane.lastChangedAt } : {}),
    status: tmuxWorkerStatusFromPane(
      pane,
      observedAt,
      correlation?.activityHint,
      correlation?.runner,
    ),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globMatches(pattern: string, value: string | undefined): boolean {
  if (value == null) return false;
  const source = [...pattern]
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return escapeRegex(char);
    })
    .join('');
  return new RegExp(`^${source}$`).test(value);
}

function ruleMatchesWorker(rule: TmuxWorkerFilterRule, worker: TmuxWorkerSummary): boolean {
  const fields: Array<[keyof TmuxWorkerFilterRule, string | undefined]> = [
    ['nodeId', worker.ref.nodeId],
    ['session', worker.ref.session],
    ['target', worker.ref.target],
    ['windowName', worker.ref.windowName],
    ['pane', worker.ref.pane],
    ['paneId', worker.ref.paneId],
    ['title', worker.title],
    ['cwd', worker.cwd],
    ['command', worker.command],
    ['linkedSlotId', worker.linkedSlotId],
    ['linkedRunId', worker.linkedRunId],
    ['linkedFamilyId', worker.linkedFamilyId],
  ];
  let sawField = false;
  for (const [field, value] of fields) {
    const pattern = rule[field];
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    sawField = true;
    if (!globMatches(pattern, value)) return false;
  }
  return sawField;
}

function anyRuleMatchesWorker(
  rules: TmuxWorkerFilterRule[] | undefined,
  worker: TmuxWorkerSummary,
): boolean {
  return Boolean(rules?.some((rule) => ruleMatchesWorker(rule, worker)));
}

export function tmuxWorkerAllowedByConfig(
  config: TmuxWorkerFilterConfig | undefined,
  worker: TmuxWorkerSummary,
): boolean {
  if (!config) return true;
  if (anyRuleMatchesWorker(config.exclude, worker)) return false;
  if (!config.include || config.include.length === 0) return true;
  return anyRuleMatchesWorker(config.include, worker);
}

function filterWorkersByConfig(
  workers: TmuxWorkerSummary[],
  config: TmuxWorkerFilterConfig | undefined,
): { workers: TmuxWorkerSummary[]; hiddenWorkers: number } {
  if (!config) return { workers, hiddenWorkers: 0 };
  const visible = workers.filter((worker) => tmuxWorkerAllowedByConfig(config, worker));
  return { workers: visible, hiddenWorkers: workers.length - visible.length };
}

function summarizeTmuxWorkers(workers: TmuxWorkerSummary[]): TmuxWorkerNodeSummary {
  const summary: TmuxWorkerNodeSummary = {
    panes: workers.length,
    active: 0,
    waiting: 0,
    idle: 0,
    stale: 0,
    unknown: 0,
  };
  for (const worker of workers) {
    const state = worker.status.state ?? 'unknown';
    summary[state] += 1;
  }
  return summary;
}

export function rememberNodeTmuxPaneSnapshot(params: {
  nodeId: string;
  observedAt: number;
  panes: NodeTmuxPane[];
}): void {
  nodeTmuxPaneSnapshots.set(params.nodeId, {
    observedAt: params.observedAt,
    panes: params.panes,
  });
}

function freshNodeTmuxPaneSnapshot(nodeId: string, now: number): NodeTmuxPane[] | null {
  const snapshot = nodeTmuxPaneSnapshots.get(nodeId);
  if (!snapshot) return null;
  if (now - snapshot.observedAt > NODE_TMUX_PUSH_SNAPSHOT_FRESH_MS) return null;
  return snapshot.panes;
}

function staleNodeTmuxPaneSnapshot(nodeId: string, now: number): NodeTmuxPane[] | null {
  const snapshot = nodeTmuxPaneSnapshots.get(nodeId);
  if (!snapshot) return null;
  if (now - snapshot.observedAt > NODE_TMUX_STALE_FALLBACK_MAX_MS) return null;
  return snapshot.panes;
}

function normalizeNodeTmuxPanesResult(payload: unknown): NodeTmuxPane[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as NodeTmuxPanesResult).panes)
  ) {
    throw new Error('node tmux.panes returned invalid payload');
  }
  return (payload as NodeTmuxPanesResult).panes;
}

function normalizeNodeTmuxPaneArray(payload: unknown): NodeTmuxPane[] {
  if (!Array.isArray(payload)) {
    throw new Error('node tmux worker update returned invalid panes payload');
  }
  return payload as NodeTmuxPane[];
}

async function listNodeWorkers(params: {
  nodeId: string;
  connected: boolean;
  observedAt: number;
  sessionCorrelation: Map<string, SlotCorrelation> | undefined;
  tmuxWorkerConfig: TmuxWorkerFilterConfig | undefined;
  requestPanes: (nodeId: string) => Promise<NodeTmuxPane[]>;
}): Promise<TmuxWorkerNodeResult> {
  const { nodeId, connected, observedAt, sessionCorrelation, tmuxWorkerConfig, requestPanes } =
    params;
  if (!connected) {
    return {
      nodeId,
      connected: false,
      ok: false,
      observedAt,
      workers: [],
      summary: summarizeTmuxWorkers([]),
      error: `node ${nodeId} is not connected`,
    };
  }

  try {
    const panes = await requestPanes(nodeId);
    const allWorkers = panes.map((pane) =>
      tmuxWorkerFromNodePane({
        nodeId,
        pane,
        observedAt,
        correlation: sessionCorrelation?.get(pane.session),
      }),
    );
    const filtered = filterWorkersByConfig(allWorkers, tmuxWorkerConfig);
    return {
      nodeId,
      connected: true,
      ok: true,
      observedAt,
      workers: filtered.workers,
      summary: summarizeTmuxWorkers(filtered.workers),
      ...(filtered.hiddenWorkers > 0 ? { hiddenWorkers: filtered.hiddenWorkers } : {}),
    };
  } catch (error) {
    // Expected degraded-node path: inventory must surface node errors instead of
    // collapsing them into an empty worker list (R-033-02).
    return {
      nodeId,
      connected: true,
      ok: false,
      observedAt,
      workers: [],
      summary: summarizeTmuxWorkers([]),
      error: (error as Error).message,
    };
  }
}

export async function buildTmuxWorkerListFromSources(params: {
  pools: PoolConfig[];
  fleet: FleetStatus;
  nodeIds: string[];
  connectedNodeIds: Set<string>;
  activeRuns?: Run[];
  includeDisconnected?: boolean;
  observedAt: number;
  requestPanes: (nodeId: string) => Promise<NodeTmuxPane[]>;
}): Promise<TmuxWorkerListResult> {
  const includeDisconnected = params.includeDisconnected ?? true;
  const sessionCorrelation = buildSessionCorrelation(params.pools, params.fleet, params.activeRuns);
  const tmuxWorkerConfigByNode = new Map(
    params.pools.map((pool) => [pool.machine, pool.tmuxWorkers] as const),
  );
  const nodes = await Promise.all(
    Array.from(new Set(params.nodeIds))
      .sort()
      .filter((nodeId) => includeDisconnected || params.connectedNodeIds.has(nodeId))
      .map((nodeId) =>
        listNodeWorkers({
          nodeId,
          connected: params.connectedNodeIds.has(nodeId),
          observedAt: params.observedAt,
          sessionCorrelation: sessionCorrelation.get(nodeId),
          tmuxWorkerConfig: tmuxWorkerConfigByNode.get(nodeId),
          requestPanes: params.requestPanes,
        }),
      ),
  );

  return {
    observedAt: params.observedAt,
    nodes,
    workers: nodes.flatMap((node) => node.workers),
    ...(nodes.some((node) => (node.hiddenWorkers ?? 0) > 0)
      ? { hiddenWorkers: nodes.reduce((total, node) => total + (node.hiddenWorkers ?? 0), 0) }
      : {}),
  };
}

export async function assertTmuxWorkerControlAllowed(worker: {
  nodeId: string;
  session: string;
  target: string;
}): Promise<void> {
  const observedAt = Date.now();
  const [pools, fleet] = await Promise.all([loadPoolConfigs(), loadFleetStatus()]);
  const activeRuns = listRuns({ active: true }).runs;
  const pool = pools.find((candidate) => candidate.machine === worker.nodeId);
  if (!pool?.tmuxWorkers) return;

  const node = getNode(worker.nodeId);
  if (!node) throw new Error(`node ${worker.nodeId} is not connected`);
  const payload = await sendNodeRequest(node, 'tmux.panes', {}, { timeout: TMUX_PANES_TIMEOUT_MS });
  const panes = normalizeNodeTmuxPanesResult(payload);
  const sessionCorrelation = buildSessionCorrelation(pools, fleet, activeRuns).get(worker.nodeId);
  const summary = panes
    .map((pane) =>
      tmuxWorkerFromNodePane({
        nodeId: worker.nodeId,
        pane,
        observedAt,
        correlation: sessionCorrelation?.get(pane.session),
      }),
    )
    .find(
      (candidate) =>
        candidate.ref.target === worker.target ||
        (candidate.ref.session === worker.session && candidate.ref.target === worker.target),
    );
  if (!summary) throw new Error('worker target is not present in current tmux inventory');
  if (!tmuxWorkerAllowedByConfig(pool.tmuxWorkers, summary)) {
    throw new Error(FILTERED_WORKER_ERROR);
  }
}

export async function tmuxWorkerList(
  params: TmuxWorkerListParams = {},
): Promise<TmuxWorkerListResult> {
  const observedAt = Date.now();
  const [pools, fleet] = await Promise.all([loadPoolConfigs(), loadFleetStatus()]);
  const activeRuns = listRuns({ active: true }).runs;
  const poolMachines = pools.map((pool) => pool.machine).filter(Boolean);
  const connectedMachines = getAllNodes().map((node) => node.machine);
  const connectedNodeIds = new Set(connectedMachines);
  const nodeIds = [...poolMachines, ...connectedMachines];

  return buildTmuxWorkerListFromSources({
    pools,
    fleet,
    activeRuns,
    nodeIds,
    connectedNodeIds,
    includeDisconnected: params.includeDisconnected,
    observedAt,
    requestPanes: async (nodeId) => {
      const cached = freshNodeTmuxPaneSnapshot(nodeId, observedAt);
      if (cached) return cached;
      const stale = staleNodeTmuxPaneSnapshot(nodeId, observedAt);
      const node = getNode(nodeId);
      if (!node) throw new Error(`node ${nodeId} is not connected`);
      try {
        const payload = await sendNodeRequest(
          node,
          'tmux.panes',
          {},
          {
            timeout: TMUX_PANES_TIMEOUT_MS,
          },
        );
        return normalizeNodeTmuxPanesResult(payload);
      } catch (error) {
        // Live tmux.panes can block for the full timeout under load. Prefer a
        // degraded stale push snapshot over an empty inventory row.
        if (stale) return stale;
        throw error;
      }
    },
  });
}

export async function buildTmuxWorkerUpdateFromNodeSnapshot(payload: {
  machine: string;
  observedAt?: number;
  panes?: unknown;
}): Promise<TmuxWorkerListResult> {
  if (!payload.machine) throw new Error('node tmux worker update missing machine');
  const panes = normalizeNodeTmuxPaneArray(payload.panes);
  rememberNodeTmuxPaneSnapshot({
    nodeId: payload.machine,
    observedAt: payload.observedAt ?? Date.now(),
    panes,
  });
  return tmuxWorkerList({ includeDisconnected: true });
}
