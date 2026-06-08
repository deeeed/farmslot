// run-monitor.ts — Per-run monitoring: violation detection, nudge sending, decision creation
// Ported from farm-monitor skill logic to be gateway-resident and persistent.

import { randomUUID } from 'node:crypto';

import {
  type AgentContext,
  type AgentRole,
  DEFAULT_TASK_DIR,
  Events,
  FLOW_STEPS,
  type MonitorSnapshot,
  type MonitorViolation,
  PipelineSteps,
  primaryRoleForFlow,
  type Run,
  type RunDecision,
  type RunMonitorState,
  type WorkerSignal,
} from '@farmslot/protocol';

import { resolveAgentTarget, selectAgentContext } from '../agents/contexts.js';
import {
  getOrchestratorTaskRoot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  resolveTaskRelDir,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import {
  runnerLineLooksWaiting,
  runnerSupportsTmuxNudgesForLaunch,
  runnerTmuxNudgeUnsupportedDescription,
  sendRunnerInstructionSafely,
  stripRunnerNoise,
} from '../runners/registry.js';
import { isRunnerAliveUnderPane } from '../runners/session-process.js';
import { getRun, updateRun } from '../runs/store.js';
import { onWorkerSignal, resolveContextFilePath } from '../tasks/watcher.js';
import {
  isTerminalWorkerSignal,
  normalizeWorkerSignal,
  signalFreshAfterAll,
} from '../tasks/worker-signals.js';

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
}

const DEFAULT_CONFIG: MonitorConfig = {
  pollIntervalMs: 60_000, // 1 min — fallback for missed SIGNAL.json push events
  stuckTimeoutMs: 20 * 60_000, // 20 min
  idleTimeoutMs: 15 * 60_000, // 15 min
  totalTimeoutMs: 90 * 60_000, // 90 min
  maxNudges: 5,
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

async function loadMonitorConfig(project: string): Promise<MonitorConfig> {
  try {
    const pv = await loadProjectVars(project);
    const m = pv.projectJson.monitoring;
    if (!m) return DEFAULT_CONFIG;
    return {
      pollIntervalMs:
        readNumericMonitorField(m.poll_interval_min, 'poll_interval_min', 1, project) * 60_000,
      stuckTimeoutMs:
        readNumericMonitorField(m.stuck_timeout_min, 'stuck_timeout_min', 20, project) * 60_000,
      idleTimeoutMs:
        readNumericMonitorField(m.idle_timeout_min, 'idle_timeout_min', 15, project) * 60_000,
      totalTimeoutMs:
        readNumericMonitorField(m.total_timeout_min, 'total_timeout_min', 90, project) * 60_000,
      // max_nudges=0 is a legitimate "escalate immediately, no nudges" config.
      maxNudges: readNumericMonitorField(m.max_nudges, 'max_nudges', 5, project, {
        allowZero: true,
      }),
    };
  } catch (err) {
    console.warn(
      `[run-monitor] failed to load monitor config for ${project}: ${(err as Error).message}`,
    );
    return DEFAULT_CONFIG;
  }
}

// ─── Monitor state (in-memory per run) ───

interface MonitorState {
  lastPaneHash: string;
  lastPaneChangeAt: number;
  lastStepCount: number;
  startedAt: number;
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

function launchCommandForRun(run: Run): unknown {
  return run.steps.find((step) => step.name === PipelineSteps.DISPATCH)?.outputs?.launchCommand;
}

export function shouldHoldForInteractivePrComplete(run: Pick<Run, 'flowType' | 'mode'>): boolean {
  return run.flowType === 'pr-complete' && run.mode === 'interactive';
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

  const config = await loadMonitorConfig(run.project);
  const now = Date.now();

  // Accumulated metrics
  let pollCount = 0;
  const allViolations: MonitorResult['violations'] = [];
  const snapshots: MonitorSnapshot[] = [];
  let exitReason: MonitorResult['exitReason'] = 'worker-done';

  // Restore from persisted state if available (gateway restart recovery)
  const persisted = run.monitorState;
  const state: MonitorState = persisted
    ? {
        lastPaneHash: persisted.lastPaneHash ?? '',
        lastPaneChangeAt: new Date(persisted.lastPollAt).getTime(),
        lastStepCount: 0,
        startedAt: new Date(persisted.startedAt).getTime(),
      }
    : {
        lastPaneHash: '',
        lastPaneChangeAt: now,
        lastStepCount: 0,
        startedAt: now,
      };
  // Also restore nudge count from persisted state
  if (persisted && persisted.nudgeCount > run.metrics.nudgeCount) {
    updateRun(runId, { metrics: { ...run.metrics, nudgeCount: persisted.nudgeCount } });
  }

  // Subscribe to push-based worker signals (SIGNAL.json via task-watcher)
  let receivedSignal: WorkerSignal | undefined;
  let signalResolve: (() => void) | undefined;
  const signalPromise = new Promise<void>((resolve) => {
    signalResolve = resolve;
  });
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
      receivedSignal = bound;
      console.log(
        `[run-monitor] run ${runId.slice(0, 8)} — push signal: status=${bound.status} outcome=${bound.outcome ?? '-'}`,
      );
      signalResolve?.();
    }
  };
  const unsubSignal = onWorkerSignal(signalHandler);

  console.log(
    `[run-monitor] started for run ${runId.slice(0, 8)} slot=${slotId} poll=${config.pollIntervalMs / 60000}min${persisted ? ' (recovered)' : ''}`,
  );

  let warnedNoSignalPath = false;
  async function resolveSignalJsonPath(): Promise<string | undefined> {
    const vars = await loadSlotVars(slotId);
    const pv = await loadProjectVars(vars.projectName);
    const taskDir = getProjectField(pv.projectJson, 'task_dir') || DEFAULT_TASK_DIR;
    const orchRoot = getOrchestratorTaskRoot(initialRun.project, pv.projectJson);
    const taskFile = initialRun.taskFile
      ? (resolveTaskRelDir(initialRun.taskFile, orchRoot) ?? '')
      : '';
    const ctx = currentMonitorContext();
    if (ctx?.signalFile) {
      const taskPath = ctx.taskFile
        ? resolveContextFilePath(
            vars.remoteRepo,
            ctx.taskFile,
            `${vars.remoteRepo}/${taskDir}/${taskFile}/TASK.md`,
          )
        : undefined;
      return resolveContextFilePath(
        vars.remoteRepo,
        ctx.signalFile,
        `${vars.remoteRepo}/${taskDir}/${taskFile}/SIGNAL.json`,
        taskPath,
      );
    }
    return taskFile ? `${vars.remoteRepo}/${taskDir}/${taskFile}/SIGNAL.json` : undefined;
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
      const vars = await loadSlotVars(slotId);
      const result = await execOnSlot(vars, `cat ${shellQuote(signalJsonPath)} 2>/dev/null`);
      if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
      const parsed = JSON.parse(result.stdout) as WorkerSignal;
      const normalized = normalizeWorkerSignal(parsed);
      if (!normalized.ok) {
        console.warn(
          `[run-monitor] run ${runId.slice(0, 8)} — ignoring invalid SIGNAL.json: ${normalized.reason}`,
        );
        return undefined;
      }
      const sig = normalized.signal;
      if (isTerminalWorkerSignal(sig)) {
        const ctx = currentMonitorContext();
        const boundSig = bindSignalToMonitorContext(sig, ctx);
        if (!signalMatchesMonitorContext(boundSig, ctx)) return undefined;
        const latestRun = getRun(runId) ?? initialRun;
        if (!isWorkerSignalFreshForRun(latestRun, boundSig)) {
          console.log(
            `[run-monitor] run ${runId.slice(0, 8)} — ignoring stale SIGNAL.json: status=${boundSig.status} timestamp=${boundSig.timestamp}`,
          );
          return undefined;
        }
        return boundSig;
      }
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
      if (shouldHoldForInteractivePrComplete(run)) {
        const actionId = await createBlockedDecision(
          runId,
          'interactive_handoff',
          'Interactive PR-complete worker is no longer active and did not write a terminal signal. Inspect the slot, do any manual PR work, then write SIGNAL.json or abort the run.',
        );
        if (actionId === 'abort') {
          return { pollCount: 0, exitReason: 'aborted', violations: allViolations, snapshots };
        }
        return { pollCount: 0, exitReason: 'cancelled', violations: allViolations, snapshots };
      }
      return { pollCount: 0, exitReason: 'worker-done', violations: allViolations, snapshots };
    }

    while (!signal.aborted) {
      // Race: poll interval vs push signal vs abort
      await Promise.race([sleep(config.pollIntervalMs, signal), signalPromise]).catch((err) => {
        if (!signal.aborted) throw err;
      });
      if (signal.aborted) break;

      // Check if push signal arrived — exit immediately
      if (receivedSignal) {
        exitReason = 'worker-done';
        return {
          pollCount,
          exitReason,
          violations: allViolations,
          snapshots,
          workerSignal: receivedSignal,
        };
      }

      pollCount++;

      // Check SIGNAL.json directly (fallback for when task-watcher push fails)
      if (!receivedSignal) {
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
      const agentStatus = await checkAgentLive(
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
          if (shouldHoldForInteractivePrComplete(currentRun)) {
            snapshots.push({ timestamp: new Date().toISOString(), trigger: 'decision' });
            const actionId = await createBlockedDecision(
              runId,
              'interactive_handoff',
              'Interactive PR-complete worker stopped without a terminal signal. Inspect the slot, do any manual PR work, then write SIGNAL.json or abort the run.',
            );
            if (actionId === 'abort') {
              exitReason = 'aborted';
              return { pollCount, exitReason, violations: allViolations, snapshots };
            }
            exitReason = 'cancelled';
            return { pollCount, exitReason, violations: allViolations, snapshots };
          }
          exitReason = 'worker-done';
          return { pollCount, exitReason, violations: allViolations, snapshots };
        }
        console.log(`[run-monitor] run ${runId.slice(0, 8)} — transient idle recovered to working`);
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
              `Interactive PR-complete is waiting for operator handoff (${v.message}). Inspect the slot, do any manual PR work, then write SIGNAL.json or abort the run.`,
            );
            if (actionId === 'abort') {
              exitReason = 'aborted';
              return { pollCount, exitReason, violations: allViolations, snapshots };
            }
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
            v.type === 'waiting' &&
            FLOW_STEPS[latestRun.flowType]?.includes(PipelineSteps.HUMAN_GATE)
          ) {
            // Worker is waiting on a flow with human gates — skip the nudge.
            // The worker may be correctly paused at a gate. Let maxNudges
            // escalation handle truly stuck cases.
            console.log(
              `[run-monitor] run ${runId.slice(0, 8)} — worker waiting, flow has human gates — skipping nudge`,
            );
          } else if (
            runnerSupportsTmuxNudgesForLaunch(
              latestRun.metrics.runner,
              launchCommandForRun(latestRun),
            )
          ) {
            const nudgeContext = currentMonitorContext();
            await sendNudge(runId, slotId, v, nudgeContext?.role, nudgeContext?.id);
            snapshots.push({ timestamp: new Date().toISOString(), trigger: 'nudge' });
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
    const strippedContent = stripRunnerNoise(paneContent, runner);
    const paneHash = simpleHash(strippedContent);

    // Detect pane changes (on content area, not footer animation)
    if (paneHash !== state.lastPaneHash) {
      state.lastPaneHash = paneHash;
      state.lastPaneChangeAt = now;
    }

    // Stuck: no content-area change for stuckTimeoutMs
    const sincePaneChange = now - state.lastPaneChangeAt;
    if (sincePaneChange > config.stuckTimeoutMs) {
      violations.push({
        slotId,
        role,
        contextId,
        type: 'stuck',
        message: `No terminal output for ${Math.round(sincePaneChange / 60000)} minutes`,
        nudgeSent: null,
        timestamp: new Date().toISOString(),
      });
    }

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
    if (promptLine && sincePaneChange > 3 * 60_000) {
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
): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  if (!runnerSupportsTmuxNudgesForLaunch(run.metrics.runner, launchCommandForRun(run))) return;

  const nudgeMsg = buildNudgeMessage(violation);

  try {
    const vars = await loadSlotVars(slotId);
    const session = (await resolveAgentTarget(slotId, { runId, role, contextId })).target;
    const sent = await sendRunnerInstructionSafely(
      vars,
      session,
      run.metrics.runner ?? 'claude',
      nudgeMsg,
      'run-monitor',
    );
    if (!sent) return;

    // Update nudge count
    const nudgeCount = run.metrics.nudgeCount + 1;
    updateRun(runId, { metrics: { ...run.metrics, nudgeCount } });
    violation.nudgeSent = new Date().toISOString();

    console.log(
      `[run-monitor] nudge #${nudgeCount} sent to run ${runId.slice(0, 8)}: ${violation.type}`,
    );
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
  } catch (err) {
    console.error(
      `[run-monitor] nudge failed for run ${runId.slice(0, 8)}: ${(err as Error).message}`,
    );
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
    default:
      return '[Orchestrator] Continue working on the current task.';
  }
}

// ─── Decision creation + wait ───

async function createBlockedDecision(
  runId: string,
  reason: string,
  description: string,
): Promise<string> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');

  const decision: RunDecision = {
    id: randomUUID(),
    type: `monitor_${reason}`,
    title: `Run ${runId.slice(0, 8)} — ${reason.replace('_', ' ')}`,
    description,
    actions: [
      { id: 'continue', label: 'Continue', style: 'primary' },
      { id: 'abort', label: 'Abort Run', style: 'danger' },
    ],
    createdAt: new Date().toISOString(),
  };

  run.decisions.push(decision);
  updateRun(runId, { status: 'blocked', decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_NEW, { runId, decision, slotId: run.slotId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  // Wait for resolution
  const actionId = await new Promise<string>((resolve) => {
    decisionResolvers.set(decision.id, resolve);
  });

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
