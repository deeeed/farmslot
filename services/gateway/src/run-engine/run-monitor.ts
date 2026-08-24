// run-monitor.ts — Per-run monitoring: violation detection, nudge sending, decision creation
// Ported from farm-monitor skill logic to be gateway-resident and persistent.

import { randomUUID } from 'node:crypto';

import {
  type AgentContext,
  type AgentRole,
  Events,
  FLOW_STEPS,
  type FlowType,
  isLightweightInteractiveDevRun,
  type MonitorSnapshot,
  type MonitorViolation,
  PipelineSteps,
  primaryRoleForFlow,
  type Run,
  type RunDecision,
  type RunMonitorState,
  type RunStep,
  type WorkerSignal,
  type WorkerSignalProbeResult,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import { resolveAgentTarget, selectAgentContext } from '../agents/contexts.js';
import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import {
  classifyMonitorProgress,
  evaluateMonitorStuckForRunner,
  shouldDeliverStuckNudge,
} from '../runners/observability-progress.js';
import {
  getRunnerSessionUsageProvider,
  readRunnerActivityFromObservability,
  readRunnerTurnState,
  runnerLineLooksWaiting,
  runnerSupportsTmuxNudgesForLaunch,
  runnerTmuxNudgeUnsupportedDescription,
  sendRunnerInstructionSafely,
  stripRunnerNoise,
} from '../runners/registry.js';
import {
  isRunnerAliveUnderPane,
  resolveRunnerSessionForRun,
  resolveRunRetainedSessionBinding,
  retainedSessionSendOption,
} from '../runners/session-process.js';
import { getRun, updateRun, updateRunStep } from '../runs/store.js';
import { onWorkerSignal, resolveContextFilePath } from '../tasks/watcher.js';
import {
  isTerminalWorkerSignal,
  normalizeWorkerSignal,
  parseStrictIsoMs,
  signalFreshAfterAll,
} from '../tasks/worker-signals.js';
import {
  artifactContractWorkerInstruction,
  artifactTerminalCommandForSignal,
  loadTerminalContractForRun,
  validateTerminalSignalArtifacts,
} from '../tasks/worker-terminal-contract.js';

import {
  type BudgetUsageSampleState,
  emptyBudgetUsageSampleState,
  sampleBudgetUsage,
} from './budget-usage-sample.js';
import { pendingDecisionForRun } from './decision-projection.js';
import {
  applyBudgetUsageBaseline,
  buildUsageBudgetNudgeMessage,
  evaluateFlowUsageBudget,
  FLOW_USAGE_BUDGET_DEFAULTS,
  formatUsageBudgetMessage,
  hasUsageBudget,
} from './flow-usage-budget.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};

export function initRunMonitor(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
}

// ─── Config defaults (overridable via project.json monitoring section) ───

interface MonitorConfig {
  pollIntervalMs: number;
  stuckTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxNudges: number;
  /** Soft turn ceiling (null = no budget for this flow). */
  maxTurns: number | null;
  /** Soft total-token ceiling (null = no budget for this flow). */
  maxTotalTokens: number | null;
}

const DEFAULT_CONFIG: MonitorConfig = {
  pollIntervalMs: 60_000, // 1 min — fallback for missed SIGNAL.json push events
  stuckTimeoutMs: 20 * 60_000, // 20 min
  idleTimeoutMs: 15 * 60_000, // 15 min
  totalTimeoutMs: 90 * 60_000, // 90 min
  maxNudges: 5,
  maxTurns: null,
  maxTotalTokens: null,
};

function readNumericMonitorField(
  value: unknown,
  field: string,
  fallback: number,
  project: string,
  options?: { allowZero?: boolean },
): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  const minOk = options?.allowZero ? n >= 0 : n > 0;
  if (!Number.isFinite(n) || !minOk) {
    console.warn(
      `[run-monitor] ignoring invalid monitoring.${field}=${JSON.stringify(value)} for ${project}; using default ${fallback}`,
    );
    return fallback;
  }
  return n;
}

type MonitoringSection = NonNullable<RawProjectJson['monitoring']>;

/**
 * Resolve monitor thresholds from the raw project `monitoring` section, applying
 * per-flow overrides. Total/stuck timeouts fall back to the project value, then
 * the built-in default. Turn/token soft budgets fall back to
 * {@link FLOW_USAGE_BUDGET_DEFAULTS} for mechanical flows when unset.
 * Pure — no I/O — so config-loader tests can exercise it directly.
 */
export function resolveMonitorConfig(
  monitoring: MonitoringSection | undefined,
  project: string,
  flowType?: FlowType,
): MonitorConfig {
  const flowDefaults = flowType ? FLOW_USAGE_BUDGET_DEFAULTS[flowType] : undefined;
  if (!monitoring) {
    return {
      ...DEFAULT_CONFIG,
      maxTurns: flowDefaults?.maxTurns ?? null,
      maxTotalTokens: flowDefaults?.maxTotalTokens ?? null,
    };
  }
  const flow = flowType ? monitoring.flows?.[flowType] : undefined;
  const flowLabel = (field: string): string => (flowType ? `flows.${flowType}.${field}` : field);

  const projectStuckMin = readNumericMonitorField(
    monitoring.stuck_timeout_min,
    'stuck_timeout_min',
    20,
    project,
  );
  const projectTotalMin = readNumericMonitorField(
    monitoring.total_timeout_min,
    'total_timeout_min',
    90,
    project,
  );

  return {
    pollIntervalMs:
      readNumericMonitorField(monitoring.poll_interval_min, 'poll_interval_min', 1, project) *
      60_000,
    stuckTimeoutMs:
      readNumericMonitorField(
        flow?.stuck_timeout_min,
        flowLabel('stuck_timeout_min'),
        projectStuckMin,
        project,
      ) * 60_000,
    idleTimeoutMs:
      readNumericMonitorField(monitoring.idle_timeout_min, 'idle_timeout_min', 15, project) *
      60_000,
    totalTimeoutMs:
      readNumericMonitorField(
        flow?.total_timeout_min,
        flowLabel('total_timeout_min'),
        projectTotalMin,
        project,
      ) * 60_000,
    // max_nudges=0 is a legitimate "escalate immediately, no nudges" config.
    maxNudges: readNumericMonitorField(monitoring.max_nudges, 'max_nudges', 5, project, {
      allowZero: true,
    }),
    maxTurns: readOptionalBudgetField(
      flow?.max_turns,
      flowLabel('max_turns'),
      flowDefaults?.maxTurns ?? null,
      project,
    ),
    maxTotalTokens: readOptionalBudgetField(
      flow?.max_total_tokens,
      flowLabel('max_total_tokens'),
      flowDefaults?.maxTotalTokens ?? null,
      project,
    ),
  };
}

/** Positive integer budget ceiling, or fallback (null = no budget). Invalid values warn and fall back. */
function readOptionalBudgetField(
  value: unknown,
  field: string,
  fallback: number | null,
  project: string,
): number | null {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  // Require a positive integer — fractions like 0.5 must not floor to 0 and
  // silently disable built-in budgets.
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[run-monitor] ignoring invalid monitoring.${field}=${JSON.stringify(value)} for ${project}; using ${fallback ?? 'no budget'}`,
    );
    return fallback;
  }
  return n;
}

async function loadMonitorConfig(project: string, flowType?: FlowType): Promise<MonitorConfig> {
  try {
    const pv = await loadProjectVars(project);
    return resolveMonitorConfig(pv.projectJson.monitoring, project, flowType);
  } catch (err) {
    console.warn(
      `[run-monitor] failed to load monitor config for ${project}: ${(err as Error).message}`,
    );
    // Keep flow-aware built-in budgets (e.g. update-branch) even when project.json
    // cannot be loaded — DEFAULT_CONFIG alone would silently disable the guard.
    return resolveMonitorConfig(undefined, project, flowType);
  }
}

/**
 * Capture the retained parent transcript totals before a warm task is delivered.
 * A configured budget fails the warm handoff closed when its parent usage cannot
 * be sampled; the caller may safely fall back to a fresh, absolute-count session.
 */
export async function prepareWarmBudgetBaselineForHandoff(
  runId: string,
  slotId: string,
): Promise<'not-required' | 'captured' | 'unavailable'> {
  const run = getRun(runId);
  if (!run) return 'unavailable';
  const config = await loadMonitorConfig(run.project, run.flowType);
  if (!hasUsageBudget(config)) return 'not-required';
  if (!getRunnerSessionUsageProvider(run.metrics.runner)) return 'not-required';

  try {
    const parent = run.parentRunId ? getRun(run.parentRunId) : undefined;
    const parentContext = parent
      ? selectAgentContext(parent, { role: primaryRoleForFlow(parent.flowType) })
      : undefined;
    const runnerSessionPath =
      parentContext?.runnerSessionPath ??
      parent?.metrics.runnerSessionPath ??
      run.metrics.runnerSessionPath ??
      null;
    if (!runnerSessionPath) return 'unavailable';

    const prior = run.monitorState?.budgetUsage ?? emptyBudgetUsageSampleState();
    const sample = await sampleBudgetUsage({
      slotId,
      vars: await loadSlotVars(slotId),
      runner: run.metrics.runner,
      runnerSessionPath,
      prior,
    });
    if (sample.availability === 'unavailable') {
      console.warn(
        `[run-monitor] run ${runId.slice(0, 8)} — warm budget baseline unavailable: ${sample.unavailableReason ?? 'unknown reason'}`,
      );
      return 'unavailable';
    }

    const baseline = applyBudgetUsageBaseline({
      turns: sample.turns,
      totalTokens: sample.totalTokens,
      warmSession: true,
      baselineCaptured: false,
    });
    const now = new Date().toISOString();
    const current = getRun(runId);
    if (!current) return 'unavailable';
    updateRun(runId, {
      monitorState: {
        nudgeCount: current.metrics.nudgeCount,
        lastPollAt: now,
        startedAt: current.monitorState?.startedAt ?? now,
        lastPaneHash: current.monitorState?.lastPaneHash,
        lastStructuredProgressAt: current.monitorState?.lastStructuredProgressAt,
        budgetWarned: current.monitorState?.budgetWarned ?? false,
        budgetNudgeSent: current.monitorState?.budgetNudgeSent ?? false,
        budgetUsage: {
          ...sample.nextState,
          baselineCaptured: baseline.baselineCaptured,
          baselineTurns: baseline.baselineTurns,
          baselineTotalTokens: baseline.baselineTotalTokens,
        },
      },
    });
    return 'captured';
  } catch (err) {
    console.warn(
      `[run-monitor] run ${runId.slice(0, 8)} — warm budget baseline capture failed: ${(err as Error).message}`,
    );
    return 'unavailable';
  }
}

// ─── Monitor state (in-memory per run) ───

interface MonitorState {
  lastPaneHash: string;
  lastPaneChangeAt: number;
  /** Last time runner observability proved the turn was still making progress. */
  lastStructuredProgressAt: number;
  lastStepCount: number;
  startedAt: number;
  /** One-shot usage-budget warning already emitted for this monitor session. */
  budgetWarned: boolean;
  /** Confirmed budget-nudge delivery (may retry while false after a warn). */
  budgetNudgeSent: boolean;
  /** Incremental transcript sample for soft turn/token budgets. */
  budgetUsage: BudgetUsageSampleState;
}

// ADR-027 Phase 3: monitor state lives on Run.monitorState (already persisted).
// No module-level Map — persisted state is the only state.

// Decision wait — blocked monitors await decision resolution
const decisionResolvers = new Map<string, (actionId: string) => void>();

export function resolveMonitorDecision(decisionId: string, actionId: string): void {
  const resolver = decisionResolvers.get(decisionId);
  if (resolver) {
    resolver(actionId);
    decisionResolvers.delete(decisionId);
  }
}

// ─── Main monitoring loop ───

export interface MonitorResult {
  pollCount: number;
  exitReason: 'worker-done' | 'cancelled' | 'timeout' | 'aborted' | 'error';
  violations: Array<{ type: string; message: string; timestamp: string }>;
  snapshots: MonitorSnapshot[];
  workerSignal?: WorkerSignal;
}

type FreshnessAgentContext = Pick<AgentContext, 'id' | 'role' | 'startedAt'>;

type FreshnessRunContext = {
  steps: Pick<Run['steps'][number], 'name' | 'startedAt' | 'completedAt'>[];
  monitorState?: Pick<RunMonitorState, 'startedAt'>;
  agentContexts?: FreshnessAgentContext[];
};

function matchingSignalContext(
  run: Pick<FreshnessRunContext, 'agentContexts'>,
  signal: WorkerSignal,
): FreshnessAgentContext | undefined {
  if (!run.agentContexts?.length) return undefined;
  if (signal.contextId) {
    const exact = run.agentContexts.find((ctx) => ctx.id === signal.contextId);
    if (exact) return exact;
  }
  if (signal.role) {
    const byRole = run.agentContexts.find((ctx) => ctx.role === signal.role);
    if (byRole) return byRole;
  }
  return run.agentContexts[0];
}

export function isWorkerSignalFreshForRun(run: FreshnessRunContext, signal: WorkerSignal): boolean {
  const durableFreshnessFloors = [
    run.steps.find((s) => s.name === PipelineSteps.DISPATCH)?.completedAt,
    run.monitorState?.startedAt,
    matchingSignalContext(run, signal)?.startedAt,
  ];
  if (durableFreshnessFloors.some(Boolean)) {
    return signalFreshAfterAll(signal, durableFreshnessFloors);
  }
  return signalFreshAfterAll(signal, [
    run.steps.find((s) => s.name === PipelineSteps.MONITOR)?.startedAt,
  ]);
}

type MonitorContextIdentity = Pick<AgentContext, 'id' | 'role'>;

export function bindSignalToMonitorContext(
  signal: WorkerSignal,
  monitorContext?: MonitorContextIdentity | null,
): WorkerSignal {
  return {
    ...signal,
    role: signal.role ?? monitorContext?.role,
    contextId: signal.contextId ?? monitorContext?.id,
  };
}

export function signalMatchesMonitorContext(
  signal: WorkerSignal,
  monitorContext?: MonitorContextIdentity | null,
): boolean {
  if (!monitorContext) return true;
  // Legacy signals (pre-0.4.0) omit role and contextId. Accept them for any
  // monitor context — the slot's task watcher already scoped the signal file
  // to the right task directory, so the signal belongs to this run's worker.
  if (!signal.role && !signal.contextId) return true;
  if (monitorContext.id && signal.contextId && signal.contextId !== monitorContext.id) return false;
  if (monitorContext.role && signal.role && signal.role !== monitorContext.role) return false;
  return true;
}

/**
 * True when a signal qualifies to auto-resolve a pending interactive_handoff:
 * a FRESH TERMINAL signal that matches the monitor context. Mirrors the freshness
 * rule the `signal-written` action applies via probeWorkerSignalForRun, so a stale
 * terminal signal (predating the worker context) and any non-terminal signal
 * (e.g. `status: running`) are both rejected.
 */
export function isFreshTerminalHandoffSignal(
  run: FreshnessRunContext,
  signal: WorkerSignal,
  monitorContext?: MonitorContextIdentity | null,
): boolean {
  const bound = bindSignalToMonitorContext(signal, monitorContext);
  if (!isTerminalWorkerSignal(bound)) return false;
  if (!signalMatchesMonitorContext(bound, monitorContext)) return false;
  // Unattended resolution must PROVE freshness. The shared freshness helpers
  // treat an unparseable timestamp as fresh (lenient for operator-confirmed
  // paths), which here would let a corrupt or timestamp-less SIGNAL.json
  // resolve a handoff with nobody watching — so require a strictly-shaped,
  // parseable timestamp (Date.parse alone accepts trailing junk).
  if (parseStrictIsoMs(bound.timestamp) === null) return false;
  return isWorkerSignalFreshForRun(run, bound);
}

async function resolveSignalJsonPathForRun(
  run: Run,
  slotId: string,
  monitorContext?: (MonitorContextIdentity & Pick<AgentContext, 'taskFile' | 'signalFile'>) | null,
): Promise<string | undefined> {
  const vars = await loadSlotVars(slotId);
  const pv = await loadProjectVars(vars.projectName);
  const taskDir = resolveProjectTaskDirName(pv.projectJson);
  const orchRoot = getOrchestratorTaskRoot(run.project, pv.projectJson);
  const taskFile = run.taskFile ? (resolveTaskRelDir(run.taskFile, orchRoot) ?? '') : '';
  if (monitorContext?.signalFile) {
    const taskPath = monitorContext.taskFile
      ? resolveContextFilePath(
          vars.remoteRepo,
          monitorContext.taskFile,
          `${vars.remoteRepo}/${taskDir}/${taskFile}/TASK.md`,
        )
      : undefined;
    return resolveContextFilePath(
      vars.remoteRepo,
      monitorContext.signalFile,
      `${vars.remoteRepo}/${taskDir}/${taskFile}/SIGNAL.json`,
      taskPath,
    );
  }
  return taskFile ? `${vars.remoteRepo}/${taskDir}/${taskFile}/SIGNAL.json` : undefined;
}

export const INTERACTIVE_HANDOFF_DESCRIPTION =
  'The agent did not write a terminal signal. Finish the PR work in the slot (or verify the signal file), then resume the run.';

function displaySignalPath(
  monitorContext:
    | (MonitorContextIdentity & Pick<AgentContext, 'taskFile' | 'signalFile'>)
    | null
    | undefined,
  absolutePath?: string,
): string | null {
  return monitorContext?.signalFile ?? absolutePath ?? null;
}

export async function probeWorkerSignalForRun(
  runId: string,
  slotId?: string | null,
  monitorContext?: AgentContext | null,
): Promise<WorkerSignalProbeResult> {
  const run = getRun(runId);
  if (!run) {
    return { ok: false, code: 'missing', message: 'Run not found.', signalFile: null };
  }
  const ctx = monitorContext ?? selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  const relSignalFile = ctx?.signalFile ?? null;

  if (!slotId) {
    return {
      ok: false,
      code: 'no_slot',
      message: 'Run has no slot bound — cannot read SIGNAL.json.',
      signalFile: relSignalFile,
    };
  }

  let signalJsonPath: string | undefined;
  try {
    signalJsonPath = await resolveSignalJsonPathForRun(run, slotId, ctx);
  } catch (err) {
    return {
      ok: false,
      code: 'missing_path',
      message: `Could not resolve SIGNAL.json path: ${(err as Error).message}`,
      signalFile: relSignalFile,
    };
  }

  if (!signalJsonPath) {
    return {
      ok: false,
      code: 'missing_path',
      message: 'Could not resolve SIGNAL.json path for this run.',
      signalFile: relSignalFile,
    };
  }

  const displayPath = displaySignalPath(ctx, signalJsonPath);

  try {
    const vars = await loadSlotVars(slotId);
    const result = await execOnSlot(vars, `cat ${shellQuote(signalJsonPath)} 2>/dev/null`);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return {
        ok: false,
        code: 'missing',
        message: `No SIGNAL.json at ${displayPath ?? signalJsonPath}. Write one when manual work is done.`,
        signalFile: displayPath,
      };
    }

    let parsed: WorkerSignal;
    try {
      parsed = JSON.parse(result.stdout) as WorkerSignal;
    } catch {
      return {
        ok: false,
        code: 'invalid_json',
        message: 'SIGNAL.json is not valid JSON.',
        signalFile: displayPath,
      };
    }

    const normalized = normalizeWorkerSignal(parsed);
    if (!normalized.ok) {
      return {
        ok: false,
        code: 'invalid_schema',
        message: `SIGNAL.json invalid: ${normalized.reason}`,
        signalFile: displayPath,
        status: String((parsed as { status?: unknown }).status ?? ''),
      };
    }

    const sig = normalized.signal;
    if (!isTerminalWorkerSignal(sig)) {
      const message = isLightweightInteractiveDevRun(run)
        ? `SIGNAL.json exists but status is "${sig.status}". After the operator approves publication, create and push the PR, then run \`./mark complete --mark-last\` to open the Farmslot completion handoff.`
        : `SIGNAL.json exists but status is "${sig.status}". Run \`./mark complete\` when done.`;
      return {
        ok: false,
        code: 'non_terminal',
        message,
        signalFile: displayPath,
        status: sig.status,
        signal: sig,
      };
    }

    const boundSig = bindSignalToMonitorContext(sig, ctx);
    if (!signalMatchesMonitorContext(boundSig, ctx)) {
      return {
        ok: false,
        code: 'context_mismatch',
        message: "SIGNAL.json doesn't match this worker context (role/contextId).",
        signalFile: displayPath,
        status: boundSig.status,
        signal: boundSig,
      };
    }

    const latestRun = getRun(runId) ?? run;
    if (!isWorkerSignalFreshForRun(latestRun, boundSig)) {
      return {
        ok: false,
        code: 'stale',
        message: 'SIGNAL.json is older than this run — write a fresh terminal signal.',
        signalFile: displayPath,
        status: boundSig.status,
        signal: boundSig,
      };
    }

    const artifactValidation = await validateTerminalSignalArtifacts(
      slotId,
      signalJsonPath,
      boundSig,
      ctx?.taskFile,
    );
    if (!artifactValidation.ok) {
      return {
        ok: false,
        code:
          artifactValidation.kind === 'infrastructure'
            ? 'terminal_contract_infrastructure'
            : 'artifact_contract',
        message: artifactValidation.message,
        signalFile: displayPath,
        status: boundSig.status,
        signal: boundSig,
      };
    }

    return {
      ok: true,
      code: 'ready',
      message: 'Terminal SIGNAL.json is valid — ready to resume.',
      signalFile: displayPath,
      status: boundSig.status,
      signal: boundSig,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'missing',
      message: `Failed to read SIGNAL.json: ${(err as Error).message}`,
      signalFile: displayPath,
    };
  }
}

export async function readFreshTerminalSignalForRun(
  runId: string,
  slotId?: string | null,
  monitorContext?: AgentContext | null,
): Promise<WorkerSignal | undefined> {
  const probe = await probeWorkerSignalForRun(runId, slotId, monitorContext);
  return probe.ok ? probe.signal : undefined;
}

function launchCommandForRun(run: Run): unknown {
  return run.steps.find((step) => step.name === PipelineSteps.DISPATCH)?.outputs?.launchCommand;
}

export function shouldHoldForMissingTerminalSignal(
  contract: Pick<WorkerTerminalContractDocument, 'requireSignal'> | null | undefined,
  run: Pick<Run, 'flowType' | 'mode'>,
): boolean {
  if (contract) return contract.requireSignal;
  if (run.flowType === 'pr-complete' && run.mode === 'interactive') return false;
  return true;
}

export function shouldHoldForInteractivePrComplete(run: Pick<Run, 'flowType' | 'mode'>): boolean {
  return run.flowType === 'pr-complete' && run.mode === 'interactive';
}

type AgentLiveStatus = 'working' | 'idle' | 'no-tmux';

/** Minimal run fields the monitor nudge helpers read — accepts partial test fixtures. */
export type MonitorNudgeRunView = {
  flowType: Run['flowType'];
  status: Run['status'];
  steps?: ReadonlyArray<Pick<RunStep, 'name' | 'status'>>;
  decisions?: ReadonlyArray<Pick<RunDecision, 'type' | 'resolvedAt'>>;
};

/** True when the run is blocked on operator publication / human-gate approval. */
export function runHasOpenHumanGate(
  run: Pick<MonitorNudgeRunView, 'steps' | 'decisions' | 'status'>,
): boolean {
  const humanGateStep = run.steps?.find((step) => step.name === PipelineSteps.HUMAN_GATE);
  if (humanGateStep?.status === 'running') return true;
  if (run.status !== 'blocked') return false;
  return (
    run.decisions?.some(
      (decision) => decision.type === 'engine_human_gate' && !decision.resolvedAt,
    ) ?? false
  );
}

export function shouldSkipMonitorNudge(
  run: MonitorNudgeRunView,
  violation: Pick<MonitorViolation, 'type'>,
  agentStatus: AgentLiveStatus,
): boolean {
  if (runHasOpenHumanGate(run)) return true;

  const flowHasHumanGate = FLOW_STEPS[run.flowType]?.includes(PipelineSteps.HUMAN_GATE) ?? false;
  if (
    flowHasHumanGate &&
    (violation.type === 'waiting' || violation.type === 'idle') &&
    agentStatus === 'working'
  ) {
    return true;
  }

  return false;
}

export async function monitorRun(
  runId: string,
  slotId: string,
  signal: AbortSignal,
): Promise<MonitorResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const initialRun = run;
  // The monitor follows the flow-owned primary worker for this run. Secondary
  // roles such as self-review and ci-fix have their own watchers/signals and
  // must not retarget the main completion monitor mid-run.
  let monitorContext = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  const currentMonitorContext = () => {
    const latestRun = getRun(runId) ?? initialRun;
    const next = selectAgentContext(latestRun, { role: primaryRoleForFlow(latestRun.flowType) });
    if (next) monitorContext = next;
    return monitorContext;
  };

  const config = await loadMonitorConfig(run.project, run.flowType);
  const terminalContract = await loadTerminalContractForRun(initialRun, slotId);
  const holdIfMissingSignal = (current: Pick<Run, 'flowType' | 'mode'>) =>
    shouldHoldForMissingTerminalSignal(terminalContract, current);
  const now = Date.now();

  // Accumulated metrics
  let pollCount = 0;
  const allViolations: MonitorResult['violations'] = [];
  const snapshots: MonitorSnapshot[] = [];
  let exitReason: MonitorResult['exitReason'] = 'worker-done';

  // Restore from persisted state if available (gateway restart recovery)
  const persisted = run.monitorState;
  const restoredBudgetUsage: BudgetUsageSampleState = persisted?.budgetUsage
    ? {
        path: persisted.budgetUsage.path ?? null,
        size: persisted.budgetUsage.size ?? 0,
        mtimeMs: persisted.budgetUsage.mtimeMs ?? 0,
        offset: persisted.budgetUsage.offset ?? 0,
        turns: persisted.budgetUsage.turns ?? 0,
        totalTokens: persisted.budgetUsage.totalTokens ?? 0,
        inputTokens: persisted.budgetUsage.inputTokens ?? 0,
        outputTokens: persisted.budgetUsage.outputTokens ?? 0,
        cacheCreation: persisted.budgetUsage.cacheCreation ?? 0,
        cacheRead: persisted.budgetUsage.cacheRead ?? 0,
        sampledAt: persisted.budgetUsage.sampledAt,
        unavailableReason: persisted.budgetUsage.unavailableReason,
        integrityFailureReason: persisted.budgetUsage.integrityFailureReason,
        skippingOversizedRecord: persisted.budgetUsage.skippingOversizedRecord,
        baselineCaptured: persisted.budgetUsage.baselineCaptured,
        baselineTurns: persisted.budgetUsage.baselineTurns,
        baselineTotalTokens: persisted.budgetUsage.baselineTotalTokens,
      }
    : emptyBudgetUsageSampleState();
  const state: MonitorState = persisted
    ? {
        lastPaneHash: persisted.lastPaneHash ?? '',
        lastPaneChangeAt: new Date(persisted.lastPollAt).getTime(),
        lastStructuredProgressAt: new Date(
          persisted.lastStructuredProgressAt ?? persisted.lastPollAt,
        ).getTime(),
        lastStepCount: 0,
        startedAt: new Date(persisted.startedAt).getTime(),
        budgetWarned: persisted.budgetWarned === true,
        budgetNudgeSent: persisted.budgetNudgeSent === true,
        budgetUsage: restoredBudgetUsage,
      }
    : {
        lastPaneHash: '',
        lastPaneChangeAt: now,
        lastStructuredProgressAt: now,
        lastStepCount: 0,
        startedAt: now,
        budgetWarned: false,
        budgetNudgeSent: false,
        budgetUsage: emptyBudgetUsageSampleState(),
      };
  // Also restore nudge count from persisted state
  if (persisted && persisted.nudgeCount > run.metrics.nudgeCount) {
    updateRun(runId, { metrics: { ...run.metrics, nudgeCount: persisted.nudgeCount } });
  }

  // Subscribe to push-based worker signals (SIGNAL.json via task-watcher)
  let pushedTerminalSignal = false;
  let signalResolve: (() => void) | undefined;
  let signalPromise: Promise<void> = Promise.resolve();
  const armSignalPromise = () => {
    signalPromise = new Promise<void>((resolve) => {
      signalResolve = resolve;
    });
  };
  armSignalPromise();
  const signalHandler = (sigSlotId: string, sigRunId: string | null, ws: WorkerSignal) => {
    if (sigSlotId !== slotId) return;
    if (sigRunId && sigRunId !== runId) return;
    const normalized = normalizeWorkerSignal(ws);
    if (!normalized.ok) {
      console.warn(
        `[run-monitor] run ${runId.slice(0, 8)} — ignoring invalid push signal: ${normalized.reason}`,
      );
      return;
    }
    const ctx = currentMonitorContext();
    const bound = bindSignalToMonitorContext(normalized.signal, ctx);
    if (!signalMatchesMonitorContext(bound, ctx)) return;
    if (isTerminalWorkerSignal(bound)) {
      const latestRun = getRun(runId) ?? initialRun;
      if (!isWorkerSignalFreshForRun(latestRun, bound)) {
        console.log(
          `[run-monitor] run ${runId.slice(0, 8)} — ignoring stale push signal: status=${bound.status} timestamp=${bound.timestamp}`,
        );
        return;
      }
      pushedTerminalSignal = true;
      console.log(
        `[run-monitor] run ${runId.slice(0, 8)} — push signal candidate: status=${bound.status} outcome=${bound.outcome ?? '-'}`,
      );
      signalResolve?.();
    }
  };
  const unsubSignal = onWorkerSignal(signalHandler);

  console.log(
    `[run-monitor] started for run ${runId.slice(0, 8)} slot=${slotId} poll=${config.pollIntervalMs / 60000}min${persisted ? ' (recovered)' : ''}`,
  );

  let warnedNoSignalPath = false;
  let lastArtifactContractMessage: string | null = null;
  async function resolveSignalJsonPath(): Promise<string | undefined> {
    return resolveSignalJsonPathForRun(initialRun, slotId, currentMonitorContext());
  }

  // Helper: check SIGNAL.json directly via agent exec (fallback when push fails)
  async function checkSignalFile(): Promise<WorkerSignal | undefined> {
    try {
      const signalJsonPath = await resolveSignalJsonPath();
      if (!signalJsonPath) {
        if (!warnedNoSignalPath) {
          console.warn(
            `[run-monitor] no SIGNAL.json path resolved for run ${runId.slice(0, 8)}; relying on agent-liveness polling only`,
          );
          warnedNoSignalPath = true;
        }
        return undefined;
      }
      const probe = await probeWorkerSignalForRun(runId, slotId, currentMonitorContext());
      if (!probe.ok && probe.code === 'artifact_contract') {
        console.warn(
          `[run-monitor] run ${runId.slice(0, 8)} — ${probe.message.replace(/\n/g, ' | ')}`,
        );
        updateRunStep(runId, 'monitor', {
          detail: `Completion artifact contract rejected: ${probe.message.slice(0, 1000)}`,
        });
        if (lastArtifactContractMessage !== probe.message) {
          lastArtifactContractMessage = probe.message;
          try {
            const context = currentMonitorContext();
            const currentRun = getRun(runId) ?? initialRun;
            const retainedSession = resolveRunRetainedSessionBinding(currentRun, context);
            const vars = await loadSlotVars(slotId);
            const target = (
              await resolveAgentTarget(slotId, {
                runId,
                role: context?.role,
                contextId: context?.id,
              })
            ).target;
            await sendRunnerInstructionSafely(
              vars,
              target,
              context?.runner ?? initialRun.metrics.runner ?? 'claude',
              artifactContractWorkerInstruction(
                probe.message,
                probe.signal
                  ? (artifactTerminalCommandForSignal(probe.signal) ?? 'complete')
                  : 'complete',
              ),
              'artifact-contract',
              undefined,
              retainedSessionSendOption(retainedSession),
            );
          } catch (err) {
            // The durable blocked decision below is the recovery path when the
            // best-effort worker notification cannot be delivered.
            console.warn(
              `[run-monitor] run ${runId.slice(0, 8)} — artifact-contract worker notification failed: ${(err as Error).message}`,
            );
          }
        }
        const actionId = await createBlockedDecision(
          runId,
          'interactive_handoff',
          `Completion is blocked by the worker artifact contract. The worker was notified and the run will resume automatically after a valid fresh signal.\n\n${probe.message}`,
        );
        if (actionId === 'abort') return undefined;
        const retry = await probeWorkerSignalForRun(runId, slotId, currentMonitorContext());
        if (retry.ok) {
          lastArtifactContractMessage = null;
          return retry.signal;
        }
        return undefined;
      }
      if (!probe.ok && probe.code === 'terminal_contract_infrastructure') {
        console.warn(
          `[run-monitor] run ${runId.slice(0, 8)} — ${probe.message.replace(/\n/g, ' | ')}`,
        );
        updateRunStep(runId, 'monitor', {
          detail: `Terminal contract infrastructure unavailable: ${probe.message.slice(0, 1000)}`,
        });
        const actionId = await createBlockedDecision(
          runId,
          'interactive_handoff',
          `Completion is blocked by Farmslot slot infrastructure, not worker artifacts. Do not ask the worker to retry.\n\n${probe.message}`,
        );
        if (actionId === 'abort') return undefined;
        const retry = await probeWorkerSignalForRun(runId, slotId, currentMonitorContext());
        return retry.ok ? retry.signal : undefined;
      }
      if (probe.ok) lastArtifactContractMessage = null;
      return probe.ok ? probe.signal : undefined;
    } catch (err) {
      console.warn(
        `[run-monitor] failed to read SIGNAL.json for run ${runId.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
    return undefined;
  }

  try {
    // Immediate first checks — worker may have finished while gateway was down
    const existingSignal = await checkSignalFile();
    if (existingSignal) {
      console.log(
        `[run-monitor] run ${runId.slice(0, 8)} — found existing signal on start: ${existingSignal.status}`,
      );
      return {
        pollCount: 0,
        exitReason: 'worker-done',
        violations: allViolations,
        snapshots,
        workerSignal: existingSignal,
      };
    }
    let ctx = currentMonitorContext();
    let startupAgent = await checkAgentLive(slotId, run.metrics.runner, runId, ctx?.role, ctx?.id);
    if (startupAgent !== 'working') {
      ctx = currentMonitorContext();
      startupAgent = await waitForWorkerStart(
        slotId,
        run.metrics.runner,
        10_000,
        runId,
        ctx?.role,
        ctx?.id,
      );
    }
    if (startupAgent !== 'working') {
      console.log(
        `[run-monitor] run ${runId.slice(0, 8)} — worker already done on start (agent=${startupAgent})`,
      );
      if (holdIfMissingSignal(run)) {
        const actionId = await createBlockedDecision(
          runId,
          'interactive_handoff',
          INTERACTIVE_HANDOFF_DESCRIPTION,
        );
        if (actionId === 'abort') {
          return { pollCount: 0, exitReason: 'aborted', violations: allViolations, snapshots };
        }
        const postDecisionSignal = await checkSignalFile();
        if (postDecisionSignal) {
          return {
            pollCount: 0,
            exitReason: 'worker-done',
            violations: allViolations,
            snapshots,
            workerSignal: postDecisionSignal,
          };
        }
      }
      if (!holdIfMissingSignal(run)) {
        return { pollCount: 0, exitReason: 'worker-done', violations: allViolations, snapshots };
      }
    }

    while (!signal.aborted) {
      // Race: poll interval vs push signal vs abort
      await Promise.race([sleep(config.pollIntervalMs, signal), signalPromise]).catch((err) => {
        if (!signal.aborted) throw err;
      });
      if (signal.aborted) break;

      // Push events are wake-ups, never completion authority. Re-read the
      // durable signal and run the artifact contract before accepting it.
      if (pushedTerminalSignal) {
        pushedTerminalSignal = false;
        const pushedSignal = await checkSignalFile();
        if (pushedSignal) {
          exitReason = 'worker-done';
          return {
            pollCount,
            exitReason,
            violations: allViolations,
            snapshots,
            workerSignal: pushedSignal,
          };
        }
        // The one-shot promise was consumed by this rejected candidate. Re-arm
        // it so a later ./mark completion can wake the monitor.
        armSignalPromise();
      }

      pollCount++;

      // Check SIGNAL.json directly (fallback for when task-watcher push fails)
      {
        const directSignal = await checkSignalFile();
        if (directSignal) {
          // Push handler is wired (signalHandler subscribed at start). The first poll
          // can legitimately catch a signal that was written during the brief watcher
          // setup window before chokidar attached. Subsequent polls catching a signal
          // means the watcher dropped a real event — that's the alert-worthy case.
          if (pollCount > 1) {
            console.warn(
              `[run-monitor] run ${runId.slice(0, 8)} — watcher missed SIGNAL.json (caught by poll ${pollCount} after ${(pollCount * config.pollIntervalMs) / 1000}s): ${directSignal.status}`,
            );
          } else {
            console.log(
              `[run-monitor] run ${runId.slice(0, 8)} — found signal via first poll (likely watcher startup race): ${directSignal.status}`,
            );
          }
          return {
            pollCount,
            exitReason: 'worker-done',
            violations: allViolations,
            snapshots,
            workerSignal: directSignal,
          };
        }
      }

      const currentRun = getRun(runId);
      if (!currentRun || currentRun.status === 'cancelled') {
        exitReason = 'cancelled';
        return { pollCount, exitReason, violations: allViolations, snapshots };
      }

      // 1. Check if worker is done — live tmux pgrep (not .farm-status.json which is stale for gateway-dispatched runs)
      const liveContext = currentMonitorContext();
      let agentStatus = await checkAgentLive(
        slotId,
        run.metrics.runner,
        runId,
        liveContext?.role,
        liveContext?.id,
      );
      if (agentStatus !== 'working') {
        const recoveredContext = currentMonitorContext();
        const recoveredStatus = await waitForWorkerStart(
          slotId,
          run.metrics.runner,
          5_000,
          runId,
          recoveredContext?.role,
          recoveredContext?.id,
        );
        if (recoveredStatus !== 'working') {
          console.log(
            `[run-monitor] run ${runId.slice(0, 8)} — worker done (agent=${agentStatus}, confirmed=${recoveredStatus})`,
          );
          if (holdIfMissingSignal(currentRun)) {
            snapshots.push({ timestamp: new Date().toISOString(), trigger: 'decision' });
            const actionId = await createBlockedDecision(
              runId,
              'interactive_handoff',
              INTERACTIVE_HANDOFF_DESCRIPTION,
            );
            if (actionId === 'abort') {
              exitReason = 'aborted';
              return { pollCount, exitReason, violations: allViolations, snapshots };
            }
            const postDecisionSignal = await checkSignalFile();
            if (postDecisionSignal) {
              return {
                pollCount,
                exitReason: 'worker-done',
                violations: allViolations,
                snapshots,
                workerSignal: postDecisionSignal,
              };
            }
            continue;
          }
          exitReason = 'worker-done';
          return { pollCount, exitReason, violations: allViolations, snapshots };
        }
        console.log(`[run-monitor] run ${runId.slice(0, 8)} — transient idle recovered to working`);
        agentStatus = recoveredStatus;
      }

      // 2. Capture pane + detect violations
      const violationContext = currentMonitorContext();
      const violations = await detectViolations(
        runId,
        slotId,
        state,
        config,
        violationContext?.role,
        violationContext?.id,
      );

      // 2b. Soft budget: sample every poll until warned; after warn, still retry
      // nudge delivery if not confirmed (soft guard must not die on nudge errors).
      if (hasUsageBudget(config) && (!state.budgetWarned || !state.budgetNudgeSent)) {
        const tick = await pollRunBudgetGuard({
          runId,
          slotId,
          maxTurns: config.maxTurns,
          maxTotalTokens: config.maxTotalTokens,
          budgetWarned: state.budgetWarned,
          budgetNudgeSent: state.budgetNudgeSent,
          budgetUsage: state.budgetUsage,
          monitorStartedAt: new Date(state.startedAt).toISOString(),
          agentStatus,
          sendNudge: true,
        });
        state.budgetUsage = tick.budgetUsage;
        state.budgetWarned = tick.budgetWarned;
        if (tick.nudgeSent) state.budgetNudgeSent = true;
        if (tick.unavailableReason && tick.unavailableReasonChanged) {
          console.warn(
            `[run-monitor] run ${runId.slice(0, 8)} — budget usage unavailable: ${tick.unavailableReason}`,
          );
        }
        if (tick.violation) {
          allViolations.push({
            type: tick.violation.type,
            message: tick.violation.message,
            timestamp: tick.violation.timestamp,
          });
          snapshots.push({
            timestamp: tick.violation.timestamp,
            trigger: 'violation',
            violation: { type: tick.violation.type, message: tick.violation.message },
          });
          console.warn(`[run-monitor] run ${runId.slice(0, 8)} — ${tick.violation.message}`);
          if (tick.nudgeSent && tick.violation.nudgeSent) {
            snapshots.push({ timestamp: tick.violation.nudgeSent, trigger: 'nudge' });
          }
        }
      }

      // 3. Handle violations
      for (const v of violations) {
        broadcastFn(Events.MONITOR_VIOLATION, { violation: v });
        allViolations.push({ type: v.type, message: v.message, timestamp: v.timestamp });
        snapshots.push({
          timestamp: v.timestamp,
          trigger: 'violation',
          violation: { type: v.type, message: v.message },
        });

        if (v.type === 'stuck' || v.type === 'idle' || v.type === 'waiting') {
          const latestRun = getRun(runId);
          if (!latestRun) {
            exitReason = 'error';
            return { pollCount, exitReason, violations: allViolations, snapshots };
          }

          if (shouldHoldForInteractivePrComplete(latestRun)) {
            console.log(
              `[run-monitor] run ${runId.slice(0, 8)} — interactive PR-complete handoff (${v.type}), blocking instead of nudging`,
            );
            snapshots.push({ timestamp: new Date().toISOString(), trigger: 'decision' });
            const actionId = await createBlockedDecision(
              runId,
              'interactive_handoff',
              `${INTERACTIVE_HANDOFF_DESCRIPTION}\n\nMonitor note: ${v.message}`,
            );
            if (actionId === 'abort') {
              exitReason = 'aborted';
              return { pollCount, exitReason, violations: allViolations, snapshots };
            }
            const postDecisionSignal = await checkSignalFile();
            if (postDecisionSignal) {
              return {
                pollCount,
                exitReason: 'worker-done',
                violations: allViolations,
                snapshots,
                workerSignal: postDecisionSignal,
              };
            }
            continue;
          } else if (shouldSkipMonitorNudge(latestRun, v, agentStatus)) {
            console.log(
              `[run-monitor] run ${runId.slice(0, 8)} — skipping ${v.type} nudge (human gate or live worker)`,
            );
          } else if (latestRun.metrics.nudgeCount >= config.maxNudges) {
            // Max nudges exceeded — create decision
            console.log(
              `[run-monitor] run ${runId.slice(0, 8)} — max nudges (${config.maxNudges}), creating decision`,
            );
            snapshots.push({ timestamp: new Date().toISOString(), trigger: 'decision' });
            const actionId = await createBlockedDecision(
              runId,
              'max_nudges',
              `Worker exceeded ${config.maxNudges} nudges — may need manual intervention`,
            );
            if (actionId === 'abort') {
              exitReason = 'aborted';
              return { pollCount, exitReason, violations: allViolations, snapshots };
            }
            // "continue" — reset nudge count and resume
            updateRun(runId, { metrics: { ...latestRun.metrics, nudgeCount: 0 } });
          } else if (
            runnerSupportsTmuxNudgesForLaunch(
              latestRun.metrics.runner,
              launchCommandForRun(latestRun),
            )
          ) {
            const nudgeContext = currentMonitorContext();
            if (await sendNudge(runId, slotId, v, nudgeContext?.role, nudgeContext?.id)) {
              snapshots.push({ timestamp: new Date().toISOString(), trigger: 'nudge' });
            }
          } else {
            const description = runnerTmuxNudgeUnsupportedDescription(
              latestRun.metrics.runner,
              launchCommandForRun(latestRun),
              v.type,
            );
            console.log(
              `[run-monitor] run ${runId.slice(0, 8)} — ${description}; escalating to decision`,
            );
            snapshots.push({ timestamp: new Date().toISOString(), trigger: 'decision' });
            const actionId = await createBlockedDecision(runId, 'runner_waiting', description);
            if (actionId === 'abort') {
              exitReason = 'aborted';
              return { pollCount, exitReason, violations: allViolations, snapshots };
            }
          }
        }
      }

      // 4. Persist monitor state to Run (survives gateway restart)
      const currentForPersist = getRun(runId);
      if (currentForPersist) {
        updateRun(runId, {
          monitorState: {
            nudgeCount: currentForPersist.metrics.nudgeCount,
            lastPollAt: new Date().toISOString(),
            startedAt: new Date(state.startedAt).toISOString(),
            lastPaneHash: state.lastPaneHash,
            lastStructuredProgressAt: new Date(state.lastStructuredProgressAt).toISOString(),
            budgetWarned: state.budgetWarned,
            budgetNudgeSent: state.budgetNudgeSent,
            budgetUsage: state.budgetUsage,
          },
        });
      }

      // 5. Check total timeout
      const elapsed = Date.now() - state.startedAt;
      if (elapsed > config.totalTimeoutMs) {
        console.log(
          `[run-monitor] run ${runId.slice(0, 8)} — total timeout (${config.totalTimeoutMs / 60000}min)`,
        );
        snapshots.push({ timestamp: new Date().toISOString(), trigger: 'decision' });
        const timeoutRun = getRun(runId);
        if (timeoutRun && holdIfMissingSignal(timeoutRun)) {
          const actionId = await createBlockedDecision(
            runId,
            'interactive_handoff',
            `${INTERACTIVE_HANDOFF_DESCRIPTION}\n\nMonitor note: exceeded ${config.totalTimeoutMs / 60000} minute timeout.`,
          );
          if (actionId === 'abort') {
            exitReason = 'aborted';
            return { pollCount, exitReason, violations: allViolations, snapshots };
          }
          const postDecisionSignal = await checkSignalFile();
          if (postDecisionSignal) {
            return {
              pollCount,
              exitReason: 'worker-done',
              violations: allViolations,
              snapshots,
              workerSignal: postDecisionSignal,
            };
          }
          // Avoid immediately reopening the same timeout decision if the operator resolved the
          // handoff but the signal read races with a file write/delete.
          state.startedAt = Date.now();
          continue;
        }
        const actionId = await createBlockedDecision(
          runId,
          'timeout',
          `Run exceeded ${config.totalTimeoutMs / 60000} minute timeout`,
        );
        if (actionId === 'abort') {
          exitReason = 'aborted';
          return { pollCount, exitReason, violations: allViolations, snapshots };
        }
        // "continue" — extend by another full timeout period
        state.startedAt = Date.now();
      }
    }
    exitReason = 'cancelled';
    return { pollCount, exitReason, violations: allViolations, snapshots };
  } finally {
    unsubSignal();
  }
}

// ─── Violation detection ───

async function detectViolations(
  runId: string,
  slotId: string,
  state: MonitorState,
  config: MonitorConfig,
  role?: AgentRole,
  contextId?: string,
): Promise<MonitorViolation[]> {
  const violations: MonitorViolation[] = [];
  const now = Date.now();

  try {
    const vars = await loadSlotVars(slotId);
    const paneContent = await capturePaneContent(vars, runId, role, contextId);
    const runner = getRun(runId)?.metrics.runner;
    const target = (await resolveAgentTarget(slotId, { runId, role, contextId })).target;
    const stuckState = await evaluateMonitorStuckForRunner({
      vars,
      target,
      runner,
      now,
      lastProgressAt: state.lastStructuredProgressAt,
      stuckTimeoutMs: config.stuckTimeoutMs,
    });
    state.lastStructuredProgressAt = stuckState.lastProgressAt;
    if (stuckState.stuck) {
      const sinceProgress = now - stuckState.lastProgressAt;
      violations.push({
        slotId,
        role,
        contextId,
        type: 'stuck',
        message: `No structured runner activity for ${Math.round(sinceProgress / 60000)} minutes`,
        nudgeSent: null,
        timestamp: new Date().toISOString(),
      });
    }

    const strippedContent = stripRunnerNoise(paneContent, runner);
    const paneHash = simpleHash(strippedContent);

    // Waiting still uses the composer prompt (permission / input gates). Stuck
    // never does — Cursor queues orchestrator text as a follow-ups overlay while
    // a tool is running, and that overlay is not idleness.
    if (paneHash !== state.lastPaneHash) {
      state.lastPaneHash = paneHash;
      state.lastPaneChangeAt = now;
    }

    const sincePaneChange = now - state.lastPaneChangeAt;

    // Waiting: input prompt visible in the last few content lines. Scan the
    // last 5 stripped lines rather than just the tail — Claude Code renders
    // `❯` inside a bordered prompt box, so the `❯` line isn't always last
    // even after footer stripping.
    const strippedLines = strippedContent
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const tailLines = strippedLines.slice(-5);
    const promptLine = tailLines.find((line) => runnerLineLooksWaiting(line, runner));
    if (
      promptLine &&
      sincePaneChange > 3 * 60_000 &&
      stuckState.kind !== 'making-progress' &&
      stuckState.kind !== 'unproven'
    ) {
      violations.push({
        slotId,
        role,
        contextId,
        type: 'waiting',
        message: `Agent waiting for input: "${promptLine.slice(0, 60)}"`,
        nudgeSent: null,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn(
      `[run-monitor] violation detection failed for run ${runId.slice(0, 8)} role=${role ?? '-'}: ${(err as Error).message}`,
    );
  }

  return violations;
}

/** Live tmux+pgrep check — avoids stale .farm-status.json agent field for gateway-dispatched runs */
async function checkAgentLive(
  slotId: string,
  runner?: string | null,
  runId?: string,
  role?: AgentRole,
  contextId?: string,
): Promise<'working' | 'idle' | 'no-tmux'> {
  try {
    const vars = await loadSlotVars(slotId);
    if (!vars.session) return 'idle';
    const session = (await resolveAgentTarget(slotId, { runId, role, contextId })).target;
    const r = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(session)} -F '#{pane_pid}' 2>/dev/null | head -1`,
      ),
    );
    const panePid = r.stdout.trim();
    if (!panePid) return 'no-tmux';
    return (await isRunnerAliveUnderPane(vars, panePid, runner)) ? 'working' : 'idle';
  } catch (err) {
    console.warn(
      `[run-monitor] live agent check failed for slot=${slotId} run=${runId?.slice(0, 8) ?? '-'} role=${role ?? '-'}: ${(err as Error).message}`,
    );
    return 'no-tmux';
  }
}

async function waitForWorkerStart(
  slotId: string,
  runner?: string | null,
  timeoutMs = 10_000,
  runId?: string,
  role?: AgentRole,
  contextId?: string,
): Promise<'working' | 'idle' | 'no-tmux'> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: 'working' | 'idle' | 'no-tmux' = 'idle';
  while (Date.now() < deadline) {
    lastStatus = await checkAgentLive(slotId, runner, runId, role, contextId);
    if (lastStatus === 'working') return lastStatus;
    await sleep(500);
  }
  return lastStatus;
}

async function capturePaneContent(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runId?: string,
  role?: AgentRole,
  contextId?: string,
): Promise<string> {
  const session = (await resolveAgentTarget(vars.slotId, { runId, role, contextId })).target;
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`capture-pane -p -t ${shellQuote(session)} 2>/dev/null | tail -20`),
  );
  return result.stdout;
}

// ─── Nudge sending ───

async function sendNudge(
  runId: string,
  slotId: string,
  violation: MonitorViolation,
  role?: AgentRole,
  contextId?: string,
): Promise<boolean> {
  const run = getRun(runId);
  if (!run) return false;
  if (!runnerSupportsTmuxNudgesForLaunch(run.metrics.runner, launchCommandForRun(run))) {
    return false;
  }

  const nudgeMsg = buildNudgeMessage(violation);

  try {
    const vars = await loadSlotVars(slotId);
    const context = selectAgentContext(run, { role, contextId });
    const session = (await resolveAgentTarget(slotId, { runId, role, contextId })).target;
    if (violation.type === 'stuck' || violation.type === 'idle') {
      const runner = run.metrics.runner ?? 'claude';
      const activity = await readRunnerActivityFromObservability(vars, session, runner);
      const turnState = await readRunnerTurnState(vars, session, runner);
      const kind = classifyMonitorProgress({ activity, turnState });
      if (!shouldDeliverStuckNudge(kind)) {
        console.log(
          `[run-monitor] run ${runId.slice(0, 8)} — skipping ${violation.type} nudge (${kind} runner activity)`,
        );
        return false;
      }
    }
    const retainedSession = resolveRunRetainedSessionBinding(run, context);
    const sent = await sendRunnerInstructionSafely(
      vars,
      session,
      run.metrics.runner ?? 'claude',
      nudgeMsg,
      'run-monitor',
      undefined,
      // ADR-032 Phase 3A: persist a hook-only degraded hold through the ADR-031 audit (not just a
      // console warning); broadcastFn flips the degraded-audit flag in the UI on write failure.
      {
        recovery: { runId, emit: broadcastFn },
        ...retainedSessionSendOption(retainedSession),
      },
    );
    if (!sent) return false;

    // Update nudge count
    const nudgeCount = run.metrics.nudgeCount + 1;
    updateRun(runId, { metrics: { ...run.metrics, nudgeCount } });
    violation.nudgeSent = new Date().toISOString();

    console.log(
      `[run-monitor] nudge #${nudgeCount} sent to run ${runId.slice(0, 8)}: ${violation.type}`,
    );
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    return true;
  } catch (err) {
    console.error(
      `[run-monitor] nudge failed for run ${runId.slice(0, 8)}: ${(err as Error).message}`,
    );
    return false;
  }
}

function buildNudgeMessage(violation: MonitorViolation): string {
  switch (violation.type) {
    case 'stuck':
      return '[Orchestrator] You appear stuck. Report your current status in TASK.md and continue from where you left off.';
    case 'idle':
      return '[Orchestrator] You appear idle. Report current status in TASK.md.';
    case 'waiting':
      return '[Orchestrator] Continue without waiting. Follow TASK.md exactly.';
    case 'budget':
      return buildUsageBudgetNudgeMessage(violation.message);
    default:
      return '[Orchestrator] Continue working on the current task.';
  }
}

/**
 * One-shot budget warning into the worker pane. Does not increment metrics.nudgeCount
 * (stuck/idle max_nudges is a separate escalation budget).
 *
 * Returns true only when the instruction was confirmed sent. Expected unavailability
 * (missing run, non-tmux-nudgeable runner) returns false without throwing. Unexpected
 * delivery failures propagate so callers do not stamp a false nudgeSent.
 */
export async function sendBudgetNudge(
  runId: string,
  slotId: string,
  message: string,
  role?: AgentRole,
  contextId?: string,
): Promise<boolean> {
  const run = getRun(runId);
  if (!run) return false;
  if (!runnerSupportsTmuxNudgesForLaunch(run.metrics.runner, launchCommandForRun(run))) {
    return false;
  }

  const vars = await loadSlotVars(slotId);
  const context = selectAgentContext(run, { role, contextId });
  const session = (await resolveAgentTarget(slotId, { runId, role, contextId })).target;
  const retainedSession = resolveRunRetainedSessionBinding(run, context);
  const sent = await sendRunnerInstructionSafely(
    vars,
    session,
    run.metrics.runner ?? 'claude',
    buildUsageBudgetNudgeMessage(message),
    'run-monitor-budget',
    undefined,
    {
      recovery: { runId, emit: broadcastFn },
      ...retainedSessionSendOption(retainedSession),
    },
  );
  if (!sent) return false;
  console.log(
    `[run-monitor] budget nudge sent to run ${runId.slice(0, 8)}: ${message.slice(0, 120)}`,
  );
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  return true;
}

/**
 * Pure warn-once budget decision used by the monitor and focused tests.
 * When usage exceeds the ceiling and not yet warned, returns the violation
 * message and next budgetWarned=true; otherwise no emission.
 */
export function applyBudgetWarnOnce(input: {
  turns: number | null;
  totalTokens: number | null;
  maxTurns: number | null;
  maxTotalTokens: number | null;
  budgetWarned: boolean;
  flowType?: string;
}):
  | { emit: false; budgetWarned: boolean }
  | { emit: true; budgetWarned: true; message: string; reasons: string[] } {
  if (input.budgetWarned) return { emit: false, budgetWarned: true };
  const evaluation = evaluateFlowUsageBudget(
    { turns: input.turns, totalTokens: input.totalTokens },
    { maxTurns: input.maxTurns, maxTotalTokens: input.maxTotalTokens },
  );
  if (!evaluation.exceeded) return { emit: false, budgetWarned: false };
  return {
    emit: true,
    budgetWarned: true,
    message: formatUsageBudgetMessage(input.flowType, evaluation),
    reasons: evaluation.reasons,
  };
}

export type PollBudgetGuardStepResult = {
  budgetWarned: boolean;
  budgetUsage: BudgetUsageSampleState;
  sampleTurns: number | null;
  sampleTotalTokens: number | null;
  /** Turns charged toward the soft ceiling after baseline delta. */
  chargeTurns: number | null;
  chargeTotalTokens: number | null;
  establishingBaseline: boolean;
  availability: string;
  unavailableReason?: string;
  unavailableReasonChanged: boolean;
  violation: MonitorViolation | null;
  nudgeSent: boolean;
};

/**
 * One monitor poll of the soft usage budget. Runner resolution and persistence
 * are owned by pollRunBudgetGuard, the production entry used by monitorRun.
 */
export async function pollBudgetGuardStep(params: {
  runId: string;
  slotId: string;
  flowType: FlowType;
  runner?: string | null;
  runnerSessionPath?: string | null;
  maxTurns: number | null;
  maxTotalTokens: number | null;
  budgetWarned: boolean;
  budgetNudgeSent?: boolean;
  budgetUsage: BudgetUsageSampleState;
  agentStatus: AgentLiveStatus;
  /** When false, skip tmux nudge (CLI/local proof without a live pane). */
  sendNudge: boolean;
  /**
   * Force warm-session baseline accounting in focused tests. Production uses
   * `engineState.flags.warmHandoffSucceeded` when omitted.
   */
  warmSession?: boolean;
  /**
   * Optional local host stub for focused tests. Production monitor always loads real vars.
   */
  localVarsStub?: { host: string; machine: string; slotId: string; remoteRepo?: string };
  /** Test seam for confirmed-delivery retry behavior; production uses sendBudgetNudge. */
  deliverNudge?: typeof sendBudgetNudge;
}): Promise<PollBudgetGuardStepResult> {
  const vars = params.localVarsStub
    ? (params.localVarsStub as Awaited<ReturnType<typeof loadSlotVars>>)
    : await loadSlotVars(params.slotId);
  const priorUnavailable = params.budgetUsage.unavailableReason;
  const sample = await sampleBudgetUsage({
    slotId: params.slotId,
    vars,
    runner: params.runner,
    runnerSessionPath: params.runnerSessionPath,
    prior: params.budgetUsage,
  });
  let budgetWarned = params.budgetWarned;
  let violation: MonitorViolation | null = null;
  let nudgeSent = false;
  const priorNudgeSent = params.budgetNudgeSent === true;

  // Warm baseline only when handoff actually succeeded — not merely requested.
  const liveRun = getRun(params.runId);
  const warmSession =
    params.warmSession === true || liveRun?.engineState?.flags?.warmHandoffSucceeded === true;
  const baseline = applyBudgetUsageBaseline({
    turns: sample.turns,
    totalTokens: sample.totalTokens,
    warmSession,
    baselineCaptured: sample.nextState.baselineCaptured ?? params.budgetUsage.baselineCaptured,
    baselineTurns: sample.nextState.baselineTurns ?? params.budgetUsage.baselineTurns,
    baselineTotalTokens:
      sample.nextState.baselineTotalTokens ?? params.budgetUsage.baselineTotalTokens,
  });
  const budgetUsage: BudgetUsageSampleState = {
    ...sample.nextState,
    baselineCaptured: baseline.baselineCaptured,
    baselineTurns: baseline.baselineTurns,
    baselineTotalTokens: baseline.baselineTotalTokens,
  };

  let warningMessage: string | null = null;
  if (sample.enforcementFailure) {
    warningMessage =
      `usage budget enforcement unavailable (${sample.unavailableReason ?? 'unknown accounting failure'}). ` +
      'Stop expanding scope and finish or block the current checklist item.';
    if (!budgetWarned) {
      budgetWarned = true;
      const run = getRun(params.runId);
      const context = run
        ? selectAgentContext(run, { role: primaryRoleForFlow(params.flowType) })
        : undefined;
      violation = {
        slotId: params.slotId,
        role: context?.role,
        contextId: context?.id,
        type: 'budget',
        message: warningMessage,
        nudgeSent: null,
        timestamp: new Date().toISOString(),
      };
    }
  } else if (!baseline.establishingBaseline && sample.availability !== 'unavailable') {
    const decision = applyBudgetWarnOnce({
      turns: baseline.chargeTurns,
      totalTokens: baseline.chargeTotalTokens,
      maxTurns: params.maxTurns,
      maxTotalTokens: params.maxTotalTokens,
      budgetWarned,
      flowType: params.flowType,
    });

    if (decision.emit) {
      budgetWarned = true;
      warningMessage = decision.message;
      const run = getRun(params.runId);
      const context = run
        ? selectAgentContext(run, { role: primaryRoleForFlow(params.flowType) })
        : undefined;
      violation = {
        slotId: params.slotId,
        role: context?.role,
        contextId: context?.id,
        type: 'budget',
        message: decision.message,
        nudgeSent: null,
        timestamp: new Date().toISOString(),
      };
    } else if (budgetWarned && !priorNudgeSent) {
      const evaluation = evaluateFlowUsageBudget(
        { turns: baseline.chargeTurns, totalTokens: baseline.chargeTotalTokens },
        { maxTurns: params.maxTurns, maxTotalTokens: params.maxTotalTokens },
      );
      if (evaluation.exceeded) {
        warningMessage = formatUsageBudgetMessage(params.flowType, evaluation);
      }
    }
  }

  // Warning emission and delivery confirmation are separate. A false/throwing
  // safe-send keeps budgetNudgeSent false so later polls retry without emitting
  // another violation.
  if (params.sendNudge && budgetWarned && !priorNudgeSent && warningMessage) {
    const run = getRun(params.runId);
    const context = run
      ? selectAgentContext(run, { role: primaryRoleForFlow(params.flowType) })
      : undefined;
    const deliveryViolation =
      violation ??
      ({
        slotId: params.slotId,
        role: context?.role,
        contextId: context?.id,
        type: 'budget',
        message: warningMessage,
        nudgeSent: null,
        timestamp: new Date().toISOString(),
      } satisfies MonitorViolation);
    if (
      run &&
      !shouldSkipMonitorNudge(run, deliveryViolation, params.agentStatus) &&
      runnerSupportsTmuxNudgesForLaunch(run.metrics.runner, launchCommandForRun(run))
    ) {
      try {
        nudgeSent = await (params.deliverNudge ?? sendBudgetNudge)(
          params.runId,
          params.slotId,
          warningMessage,
          context?.role,
          context?.id,
        );
        if (nudgeSent && violation) violation.nudgeSent = new Date().toISOString();
      } catch (err) {
        console.warn(
          `[run-monitor] budget nudge delivery failed for run ${params.runId.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
    }
  }

  return {
    budgetWarned,
    budgetUsage,
    sampleTurns: sample.turns,
    sampleTotalTokens: sample.totalTokens,
    chargeTurns: baseline.chargeTurns,
    chargeTotalTokens: baseline.chargeTotalTokens,
    establishingBaseline: baseline.establishingBaseline,
    availability: sample.availability,
    unavailableReason: sample.unavailableReason,
    unavailableReasonChanged: Boolean(
      sample.availability === 'unavailable' &&
      sample.unavailableReason &&
      sample.unavailableReason !== priorUnavailable,
    ),
    violation,
    nudgeSent,
  };
}

/**
 * Production budget tick: resolve the run's live session, execute the bounded
 * guard, and durably persist warning/delivery state before returning. Scripted
 * runner validation calls this same entry point against a real runner session.
 */
export async function pollRunBudgetGuard(params: {
  runId: string;
  slotId: string;
  maxTurns: number | null;
  maxTotalTokens: number | null;
  budgetWarned?: boolean;
  budgetNudgeSent?: boolean;
  budgetUsage?: BudgetUsageSampleState;
  monitorStartedAt?: string;
  agentStatus: 'working' | 'idle' | 'no-tmux';
  sendNudge: boolean;
}): Promise<PollBudgetGuardStepResult> {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const vars = await loadSlotVars(params.slotId);
  const context = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });
  const retainedSession = resolveRunRetainedSessionBinding(run, context);
  const resolvedSession = retainedSession.binding
    ? null
    : await resolveRunnerSessionForRun(run, vars);
  const tick = await pollBudgetGuardStep({
    runId: params.runId,
    slotId: params.slotId,
    flowType: run.flowType,
    runner: run.metrics.runner,
    runnerSessionPath:
      retainedSession.binding?.runnerSessionPath ??
      resolvedSession?.runnerSessionPath ??
      run.metrics.runnerSessionPath ??
      null,
    maxTurns: params.maxTurns,
    maxTotalTokens: params.maxTotalTokens,
    budgetWarned: params.budgetWarned ?? run.monitorState?.budgetWarned === true,
    budgetNudgeSent: params.budgetNudgeSent ?? run.monitorState?.budgetNudgeSent === true,
    budgetUsage:
      params.budgetUsage ?? run.monitorState?.budgetUsage ?? emptyBudgetUsageSampleState(),
    agentStatus: params.agentStatus,
    sendNudge: params.sendNudge,
  });

  const current = getRun(params.runId);
  if (!current) throw new Error(`Run disappeared during budget poll: ${params.runId}`);
  const now = new Date().toISOString();
  updateRun(params.runId, {
    monitorState: {
      nudgeCount: current.metrics.nudgeCount,
      lastPollAt: now,
      startedAt: params.monitorStartedAt ?? current.monitorState?.startedAt ?? now,
      lastPaneHash: current.monitorState?.lastPaneHash,
      lastStructuredProgressAt: current.monitorState?.lastStructuredProgressAt,
      budgetWarned: tick.budgetWarned,
      budgetNudgeSent:
        params.budgetNudgeSent === true ||
        current.monitorState?.budgetNudgeSent === true ||
        tick.nudgeSent,
      budgetUsage: tick.budgetUsage,
    },
  });
  if (tick.violation) {
    broadcastFn(Events.MONITOR_VIOLATION, { violation: tick.violation });
  }
  return tick;
}

// ─── Decision creation + wait ───

const HANDOFF_AUTO_RECOVERY_POLL_MS = 60_000;

export const HANDOFF_AUTO_RESOLVE_ACTION = 'signal-written';

/**
 * Auto-resolution gate for a pending interactive_handoff. When `signal` is a fresh
 * terminal signal matching the monitor context, stamps the auto-resolution onto the
 * decision context and returns true (the caller then resolves the decision). Stale
 * terminal signals and non-terminal signals (`status: running`) return false and
 * leave the decision untouched. Pure aside from the passed-in `nowIso`.
 */
export function applyHandoffAutoResolution(
  run: FreshnessRunContext,
  decision: Pick<RunDecision, 'context'>,
  signal: WorkerSignal,
  monitorContext?: MonitorContextIdentity | null,
  nowIso: string = new Date().toISOString(),
): boolean {
  if (!isFreshTerminalHandoffSignal(run, signal, monitorContext)) return false;
  const bound = bindSignalToMonitorContext(signal, monitorContext);
  decision.context = {
    ...decision.context,
    autoResolved: true,
    autoResolvedBy: 'terminal-signal',
    autoResolvedAt: nowIso,
    autoResolvedStatus: bound.status,
  };
  return true;
}

/**
 * While an interactive_handoff decision is pending, watch the run's signal file. A
 * fresh terminal signal (same freshness rule as the signal-written action) resolves
 * the decision as `signal-written` and records the auto-resolution on the decision,
 * so the run resumes without an operator round-trip. Returns a disarm cleanup.
 */
/**
 * A watcher can outlive its decision when the operator resolves the handoff
 * manually and no fresh terminal signal ever arrives (consider() then never
 * runs). Both delivery paths check this FIRST so a dead decision disarms the
 * watcher on the next push event or poll tick instead of leaking the interval
 * and subscription until process exit. Exported for tests.
 */
export function handoffDecisionStillPending(runId: string, decisionId: string): boolean {
  const decision = getRun(runId)?.decisions.find((d) => d.id === decisionId);
  return Boolean(decision && !decision.resolvedAt);
}

function armInteractiveHandoffAutoRecovery(
  runId: string,
  slotId: string,
  decision: RunDecision,
  resolve: (actionId: string) => void,
): () => void {
  let settled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let unsub: (() => void) | undefined;

  const cleanup = (): void => {
    settled = true;
    unsub?.();
    if (poll) clearInterval(poll);
  };

  const consider = (signal: WorkerSignal): void => {
    if (settled) return;
    const latestRun = getRun(runId);
    if (!latestRun) return;
    // Re-read the decision from the store: after a manual resolve this
    // watcher is stale (its disposer may have been lost across a restart),
    // so disarm instead of stamping an already-resolved decision.
    const liveDecision = latestRun.decisions.find((d) => d.id === decision.id);
    if (!liveDecision || liveDecision.resolvedAt) {
      cleanup();
      return;
    }
    const ctx = selectAgentContext(latestRun, { role: primaryRoleForFlow(latestRun.flowType) });
    if (applyHandoffAutoResolution(latestRun, liveDecision, signal, ctx)) {
      cleanup();
      console.log(
        `[run-monitor] run ${runId.slice(0, 8)} — interactive handoff auto-resolved by fresh terminal signal (status=${signal.status})`,
      );
      resolve(HANDOFF_AUTO_RESOLVE_ACTION);
    }
  };

  const handlePush = (sigSlotId: string, sigRunId: string | null, ws: WorkerSignal): void => {
    if (settled) return;
    if (!handoffDecisionStillPending(runId, decision.id)) {
      cleanup();
      return;
    }
    if (sigSlotId !== slotId) return;
    if (sigRunId && sigRunId !== runId) return;
    const normalized = normalizeWorkerSignal(ws);
    if (!normalized.ok) return;
    // A watcher push is only a wake-up. Re-read the durable signal through
    // the same freshness + artifact-contract probe as the normal monitor;
    // otherwise an invalid terminal push could auto-resolve the handoff that
    // was created specifically because its artifacts were rejected.
    void readFreshTerminalSignalForRun(runId, slotId)
      .then((signal) => {
        if (signal) consider(signal);
      })
      .catch((err) => {
        console.warn(
          `[run-monitor] run ${runId.slice(0, 8)} — handoff push verification failed: ${(err as Error).message}`,
        );
      });
  };
  unsub = onWorkerSignal(handlePush);

  // Fallback poll — the task-watcher push can miss a write and the operator hold may
  // outlive the watcher, so re-read the file directly on the monitor's poll cadence.
  poll = setInterval(() => {
    void (async () => {
      if (settled) return;
      if (!handoffDecisionStillPending(runId, decision.id)) {
        cleanup();
        return;
      }
      try {
        const signal = await readFreshTerminalSignalForRun(runId, slotId);
        if (signal) consider(signal);
      } catch (err) {
        // A failed probe must not become an unhandled rejection (which can
        // kill the gateway); the poll retries on the next tick and the
        // operator path stays available, so warn-and-continue is safe.
        console.warn(
          `[run-monitor] run ${runId.slice(0, 8)} — handoff auto-recovery poll failed: ${(err as Error).message}`,
        );
      }
    })();
  }, HANDOFF_AUTO_RECOVERY_POLL_MS);

  return cleanup;
}

/**
 * Restart path: the engine promise that owned a pending interactive_handoff
 * died with the previous gateway process, taking its auto-recovery watcher
 * with it. Recovery re-arms the watcher here. Resolution cannot use the dead
 * promise's resolver, so it routes through the injected decision resolver
 * (the public resolve path), whose restart fallback resumes the pipeline.
 */
export function rearmInteractiveHandoffAutoRecovery(
  run: Run,
  resolveDecision: (runId: string, decisionId: string, actionId: string) => Promise<void>,
): (() => void) | undefined {
  const slotId = run.slotId;
  if (!slotId) return undefined;
  const decision = run.decisions.find(
    (d) => !d.resolvedAt && d.type === 'monitor_interactive_handoff',
  );
  if (!decision) return undefined;
  return armInteractiveHandoffAutoRecovery(run.id, slotId, decision, (actionId) => {
    resolveDecision(run.id, decision.id, actionId).catch((err) => {
      // The watcher disarmed itself before this resolve ran, so a transient
      // failure (e.g. the signal file momentarily unreadable, or losing the
      // race to a concurrent operator resolve) would otherwise permanently
      // strand auto-recovery. Warn and re-arm: if the decision is already
      // resolved the re-arm declines, otherwise the next poll retries.
      console.warn(
        `[run-monitor] run ${run.id.slice(0, 8)} — auto-resolve of interactive handoff failed after restart: ${(err as Error).message}`,
      );
      const latest = getRun(run.id);
      if (latest) rearmInteractiveHandoffAutoRecovery(latest, resolveDecision);
    });
  });
}

async function createBlockedDecision(
  runId: string,
  reason: string,
  description: string,
  actions: RunDecision['actions'] = [
    { id: 'continue', label: 'Continue', style: 'primary' },
    { id: 'abort', label: 'Abort Run', style: 'danger' },
  ],
): Promise<string> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');

  const monitorCtx = selectAgentContext(run, { role: primaryRoleForFlow(run.flowType) });

  const decision: RunDecision = {
    id: randomUUID(),
    type: `monitor_${reason}`,
    title: `Run ${runId.slice(0, 8)} — ${reason.replace('_', ' ')}`,
    description,
    actions:
      reason === 'interactive_handoff'
        ? [
            {
              id: 'signal-written',
              label: 'Check SIGNAL.json & resume',
              style: 'primary',
              description:
                'Reads SIGNAL.json on the slot. Resumes the run only if it contains a fresh terminal status.',
            },
            { id: 'abort', label: 'Abort Run', style: 'danger' },
          ]
        : actions,
    createdAt: new Date().toISOString(),
    context:
      reason === 'interactive_handoff' ? { signalFile: monitorCtx?.signalFile ?? null } : undefined,
  };

  run.decisions.push(decision);
  updateRun(runId, { status: 'blocked', decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_NEW, {
    runId,
    decision: pendingDecisionForRun(run, decision),
    slotId: run.slotId,
  });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  // Wait for resolution. Interactive handoffs also auto-resolve when a fresh
  // terminal signal lands on the slot — no operator round-trip required.
  let disarmAutoRecovery: (() => void) | undefined;
  const actionId = await new Promise<string>((resolve) => {
    decisionResolvers.set(decision.id, resolve);
    if (reason === 'interactive_handoff' && run.slotId) {
      disarmAutoRecovery = armInteractiveHandoffAutoRecovery(runId, run.slotId, decision, resolve);
    }
  });
  disarmAutoRecovery?.();
  decisionResolvers.delete(decision.id);

  // Mark decision resolved
  decision.resolvedAt = new Date().toISOString();
  decision.resolvedAction = actionId;
  updateRun(runId, { status: 'monitoring', decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_RESOLVED, { runId, decisionId: decision.id, actionId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  return actionId;
}

// ─── Helpers ───

function simpleHash(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
