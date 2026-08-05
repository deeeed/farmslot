// agents/runtime-recovery.ts — reconcile persisted agent context state with live tmux runtime.

import path from 'node:path';

import {
  type AgentContext,
  type AgentContextStatus,
  type AgentContextTarget,
  agentRoleWindow,
  contextIdFor,
  isTerminalRunStatus,
  primaryRoleForFlow,
  type Run,
  type TmuxWorkerRef,
  type TmuxWorkerRestoreContextResult,
  type TmuxWorkerRestoreParams,
  type TmuxWorkerRestoreResult,
} from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars, resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import {
  resolveTmuxSession,
  respawnTmuxWindowWithCommand,
  shellQuote,
  TMUX_WINDOW_RESPAWN_SETTLE_MS,
  tmuxShellSnippet,
} from '../core/tmux.js';
import { canonicalAgentContextTarget } from '../methods/dispatch/role-target.js';
import { resolveDispatchSafetyTier } from '../methods/dispatch/safety-tier.js';
import { buildRunnerSessionReloadCommand } from '../runners/launch-command.js';
import {
  normalizeRunner,
  runnerPersistsSessionFiles,
  WORKER_ENV_PREFIX,
} from '../runners/registry.js';
import { isRunnerAliveUnderPane, resolveRunnerSessionBinding } from '../runners/session-process.js';
import { getRun, listRuns, updateRunAgentContexts } from '../runs/store.js';

const ACTIVE_CONTEXT_STATUSES: ReadonlySet<AgentContextStatus> = new Set([
  'launching',
  'working',
  'waiting',
  'blocked',
]);

interface TmuxPaneRuntime {
  session: string;
  window: string;
  windowName: string;
  pane: string;
  paneId: string;
  panePid: string;
  cwd: string;
  command: string;
}

interface RuntimeInspection {
  state: 'live' | 'missing' | 'dead' | 'skipped';
  panes: TmuxPaneRuntime[];
  runnerAlive: boolean;
  detail?: string;
  target?: TmuxWorkerRef;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
}

function activeContext(ctx: AgentContext): boolean {
  return ACTIVE_CONTEXT_STATUSES.has(ctx.status);
}

function primaryContextId(run: Run): string {
  return contextIdFor(primaryRoleForFlow(run.flowType));
}

function stableWindowName(ctx: AgentContext): string | null {
  const stored = ctx.target?.window?.trim();
  if (stored && !/^\d+$/.test(stored)) return stored;
  const roleWindow = agentRoleWindow(ctx.role);
  return roleWindow?.trim() || null;
}

function parseTmuxPaneRuntime(line: string): TmuxPaneRuntime | null {
  const [session, window, windowName, pane, paneId, panePid, command, cwd] = line.split('\t');
  if (!session || !window || !pane) return null;
  return {
    session,
    window,
    windowName: windowName ?? '',
    pane,
    paneId: paneId ?? '',
    panePid: panePid ?? '',
    command: command ?? '',
    cwd: cwd ?? '',
  };
}

function workerRefFromPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  pane: TmuxPaneRuntime,
): TmuxWorkerRef {
  const target = pane.paneId || `${pane.session}:${pane.window}.${pane.pane}`;
  return {
    nodeId: vars.machine,
    session: pane.session,
    window: pane.window,
    ...(pane.windowName ? { windowName: pane.windowName } : {}),
    pane: pane.pane,
    ...(pane.paneId ? { paneId: pane.paneId } : {}),
    target,
  };
}

function agentTargetFromWorkerRef(ref: TmuxWorkerRef): AgentContextTarget {
  return {
    session: ref.session,
    window: ref.windowName ?? ref.window ?? null,
    pane: ref.pane ?? null,
    target: ref.windowName ? `${ref.session}:${ref.windowName}` : ref.target,
  };
}

function persistRestoredContext(
  runId: string,
  contextId: string,
  patch: Partial<AgentContext>,
): void {
  const now = new Date().toISOString();
  updateRunAgentContexts(runId, (_currentRun, currentContexts) =>
    currentContexts.map((ctx) =>
      ctx.id === contextId
        ? {
            ...ctx,
            ...patch,
            completedAt: undefined,
            lastSignalAt: now,
            updatedAt: now,
          }
        : ctx,
    ),
  );
}

async function tmuxSessionExists(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
): Promise<boolean> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`has-session -t ${shellQuote(`=${session}`)} 2>/dev/null`),
    { timeout: 3000 },
  );
  return result.exitCode === 0;
}

async function tmuxWindowExists(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  windowName: string,
): Promise<boolean> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-windows -t ${shellQuote(`=${session}`)} -F '#{window_name}' 2>/dev/null | grep -Fxq ${shellQuote(windowName)}`,
    ),
    { timeout: 3000 },
  );
  return result.exitCode === 0;
}

async function listTargetPanes(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  target: string,
): Promise<TmuxPaneRuntime[]> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      [
        `list-panes -t ${shellQuote(target)} `,
        `-F '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}' `,
        '2>/dev/null',
      ].join(''),
    ),
    { timeout: 3000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => parseTmuxPaneRuntime(line))
    .filter((pane): pane is TmuxPaneRuntime => Boolean(pane))
    .filter((pane) => pane.session === session);
}

async function sessionBindingForContext(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  run: Run,
  ctx: AgentContext,
  paneId?: string | null,
): Promise<{ runnerSessionId: string; runnerSessionPath: string } | null> {
  const runner = ctx.runner ?? run.metrics.runner;
  if (!runner) return null;
  const sinceMs = Date.parse(ctx.startedAt ?? run.createdAt);
  return resolveRunnerSessionBinding(vars, runner, [], {
    sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
    paneId,
    slotId: vars.slotId,
    existingPath: ctx.runnerSessionPath ?? run.metrics.runnerSessionPath,
  });
}

async function inspectContextRuntime(run: Run, ctx: AgentContext): Promise<RuntimeInspection> {
  if (!run.slotId) return { state: 'skipped', panes: [], runnerAlive: false, detail: 'no slot' };
  if (!activeContext(ctx)) {
    return { state: 'skipped', panes: [], runnerAlive: false, detail: 'terminal context' };
  }

  const vars = await loadSlotVars(run.slotId);
  const expectedSession = await resolveTmuxSession(run.slotId, vars, { strict: true });
  const session = ctx.target?.session || expectedSession;
  if (!(await tmuxSessionExists(vars, session))) {
    const binding = await sessionBindingForContext(vars, run, ctx);
    return {
      state: 'missing',
      panes: [],
      runnerAlive: false,
      detail: `tmux session ${session} is missing`,
      runnerSessionId: binding?.runnerSessionId ?? ctx.runnerSessionId ?? null,
      runnerSessionPath: binding?.runnerSessionPath ?? ctx.runnerSessionPath ?? null,
    };
  }

  const windowName = stableWindowName(ctx);
  const target =
    windowName && (await tmuxWindowExists(vars, session, windowName))
      ? `${session}:${windowName}`
      : ctx.target
        ? canonicalAgentContextTarget(ctx.target)
        : session;
  const panes = await listTargetPanes(vars, session, target);
  if (panes.length === 0) {
    const binding = await sessionBindingForContext(vars, run, ctx);
    return {
      state: 'missing',
      panes: [],
      runnerAlive: false,
      detail: `tmux target ${target} is missing`,
      runnerSessionId: binding?.runnerSessionId ?? ctx.runnerSessionId ?? null,
      runnerSessionPath: binding?.runnerSessionPath ?? ctx.runnerSessionPath ?? null,
    };
  }

  const runner = ctx.runner ?? run.metrics.runner;
  let runnerAlive = false;
  for (const pane of panes) {
    if (!pane.panePid) continue;
    if (await isRunnerAliveUnderPane(vars, pane.panePid, runner)) {
      runnerAlive = true;
      break;
    }
  }
  const binding = await sessionBindingForContext(vars, run, ctx, panes[0]?.paneId);
  const base = {
    panes,
    runnerAlive,
    target: workerRefFromPane(vars, panes[0]!),
    runnerSessionId: binding?.runnerSessionId ?? ctx.runnerSessionId ?? null,
    runnerSessionPath: binding?.runnerSessionPath ?? ctx.runnerSessionPath ?? null,
  };
  if (!runnerAlive && runner) {
    return { ...base, state: 'dead', detail: `runner ${runner} is not alive under ${target}` };
  }
  return { ...base, state: 'live' };
}

function targetForRestoredWindow(
  session: string,
  ctx: AgentContext,
  run: Run,
): { windowName: string; target: string } {
  const windowName =
    stableWindowName(ctx) ?? agentRoleWindow(primaryRoleForFlow(run.flowType)) ?? 'worker';
  return { windowName, target: `${session}:${windowName}` };
}

async function ensureRestoredWindow(run: Run, ctx: AgentContext): Promise<TmuxWorkerRef> {
  if (!run.slotId) throw new Error(`Run ${run.id} has no slot`);
  const vars = await loadSlotVars(run.slotId);
  const session =
    ctx.target?.session || (await resolveTmuxSession(run.slotId, vars, { strict: true }));
  if (!(await tmuxSessionExists(vars, session))) {
    const created = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-session -d -s ${shellQuote(session)} -c ${shellQuote(vars.remoteRepo)}`,
      ),
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `Failed to recreate tmux session ${session}: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
      );
    }
  }
  const { windowName, target } = targetForRestoredWindow(session, ctx, run);
  if (!(await tmuxWindowExists(vars, session, windowName))) {
    const result = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `new-window -d -t ${shellQuote(`=${session}`)} -n ${shellQuote(windowName)} -c ${shellQuote(vars.remoteRepo)}`,
      ),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to recreate tmux window ${target}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TMUX_WINDOW_RESPAWN_SETTLE_MS));
  }
  const panes = await listTargetPanes(vars, session, target);
  if (panes.length === 0) throw new Error(`Restored tmux window ${target} has no panes`);
  return workerRefFromPane(vars, panes[0]!);
}

async function waitForRunnerAliveInTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  target: string,
  runner: string,
): Promise<TmuxPaneRuntime | null> {
  const deadline = Date.now() + 5000;
  while (Date.now() <= deadline) {
    const panes = await listTargetPanes(vars, session, target);
    for (const pane of panes) {
      if (!pane.panePid) continue;
      if (await isRunnerAliveUnderPane(vars, pane.panePid, runner)) return pane;
    }
    await new Promise((resolve) => setTimeout(resolve, TMUX_WINDOW_RESPAWN_SETTLE_MS));
  }
  return null;
}

function statusAfterInspection(
  run: Run,
  ctx: AgentContext,
  inspection: RuntimeInspection,
): AgentContextStatus {
  if (inspection.state === 'live') return ctx.status === 'launching' ? 'working' : ctx.status;
  if (inspection.state === 'skipped') return ctx.status;
  if (ctx.id === primaryContextId(run)) return 'blocked';
  return 'failed';
}

export async function reconcileRunAgentRuntime(run: Run): Promise<TmuxWorkerRestoreResult> {
  const contexts = run.agentContexts ?? [];
  if (!run.slotId || contexts.length === 0) {
    return { slotId: run.slotId ?? '', runId: run.id, restored: false, contexts: [] };
  }

  const results: TmuxWorkerRestoreContextResult[] = [];
  const patches = new Map<string, Partial<AgentContext>>();
  for (const ctx of contexts) {
    const inspection = await inspectContextRuntime(run, ctx);
    const nextStatus = statusAfterInspection(run, ctx, inspection);
    const now = new Date().toISOString();
    const patch: Partial<AgentContext> = {
      status: nextStatus,
      ...(inspection.runnerSessionId !== undefined
        ? { runnerSessionId: inspection.runnerSessionId }
        : {}),
      ...(inspection.runnerSessionPath !== undefined
        ? { runnerSessionPath: inspection.runnerSessionPath }
        : {}),
      ...(inspection.state !== 'skipped' ? { lastSignalAt: now, updatedAt: now } : {}),
      ...(nextStatus === 'failed' || nextStatus === 'blocked'
        ? { completedAt: now }
        : inspection.state !== 'skipped'
          ? { completedAt: undefined }
          : {}),
    };
    const changed =
      patch.status !== ctx.status ||
      patch.runnerSessionId !== undefined ||
      patch.runnerSessionPath !== undefined ||
      ('completedAt' in patch && patch.completedAt !== ctx.completedAt);
    if (changed) patches.set(ctx.id, patch);
    results.push({
      contextId: ctx.id,
      role: ctx.role,
      status: inspection.state,
      ...(inspection.target ? { target: inspection.target } : {}),
      ...(inspection.runnerSessionId !== undefined
        ? { runnerSessionId: inspection.runnerSessionId }
        : {}),
      ...(inspection.runnerSessionPath !== undefined
        ? { runnerSessionPath: inspection.runnerSessionPath }
        : {}),
      ...(inspection.detail ? { detail: inspection.detail } : {}),
    });
  }

  if (patches.size > 0) {
    updateRunAgentContexts(run.id, (_currentRun, currentContexts) =>
      currentContexts.map((ctx) =>
        patches.has(ctx.id) ? { ...ctx, ...patches.get(ctx.id)! } : ctx,
      ),
    );
  }
  return { slotId: run.slotId, runId: run.id, restored: false, contexts: results };
}

export async function restoreTmuxWorker(
  params: TmuxWorkerRestoreParams,
): Promise<TmuxWorkerRestoreResult> {
  const run =
    params.runId && params.runId.trim()
      ? getRun(params.runId.trim())
      : listRuns({ active: true, sort: 'newest', limit: Number.MAX_SAFE_INTEGER }).runs.find(
          (candidate) => candidate.slotId === params.slotId,
        );
  if (!run) throw new Error(`No active run found for slot ${params.slotId}`);
  if (run.slotId !== params.slotId) {
    throw new Error(`Run ${run.id} is on slot ${run.slotId}, not ${params.slotId}`);
  }
  if (params.mode !== 'restore-window' && params.mode !== 'reload-session') {
    return reconcileRunAgentRuntime(run);
  }
  if (isTerminalRunStatus(run.status)) {
    throw new Error(`Run ${run.id} is terminal (${run.status}); restore a live run instead`);
  }

  const contexts = run.agentContexts ?? [];
  const selected =
    (params.contextId
      ? contexts.find((ctx) => ctx.id === params.contextId)
      : (contexts.find((ctx) => ctx.id === primaryContextId(run)) ?? contexts[0])) ?? null;
  if (!selected) throw new Error(`Run ${run.id} has no agent context to restore`);
  if (!activeContext(selected)) {
    throw new Error(
      `Agent context ${selected.id} is terminal (${selected.status}); restore a live context instead`,
    );
  }

  const ref = await ensureRestoredWindow(run, selected);
  const nextTarget = agentTargetFromWorkerRef(ref);
  const vars = await loadSlotVars(params.slotId);
  const binding = await sessionBindingForContext(vars, run, selected, ref.paneId);
  const runner = normalizeRunner(selected.runner ?? run.metrics.runner);
  if (params.mode === 'reload-session') {
    const existing = await inspectContextRuntime(run, selected);
    if (existing.runnerAlive) {
      const liveTarget = existing.target ?? ref;
      persistRestoredContext(run.id, selected.id, {
        status: 'working',
        target: agentTargetFromWorkerRef(liveTarget),
        runnerSessionId: existing.runnerSessionId ?? binding?.runnerSessionId ?? null,
        runnerSessionPath: existing.runnerSessionPath ?? binding?.runnerSessionPath ?? null,
      });
      return {
        slotId: params.slotId,
        runId: run.id,
        restored: false,
        contexts: [
          {
            contextId: selected.id,
            role: selected.role,
            status: 'live',
            target: liveTarget,
            runnerSessionId: existing.runnerSessionId ?? binding?.runnerSessionId ?? null,
            runnerSessionPath: existing.runnerSessionPath ?? binding?.runnerSessionPath ?? null,
            detail: `Worker ${runner} is already running; no session reload was needed.`,
          },
        ],
      };
    }
    if (!runnerPersistsSessionFiles(runner)) {
      throw new Error(
        `Runner '${runner}' does not persist resumable sessions; only the tmux window can be restored`,
      );
    }
    const sessionBinding = binding ?? (await sessionBindingForContext(vars, run, selected));
    if (!sessionBinding?.runnerSessionId) {
      throw new Error(`No persisted ${runner} session found for agent context ${selected.id}`);
    }
    const projectVars = await loadProjectVars(run.project);
    const runtimeDir = await resolveProjectRuntimeDir(run.project);
    const safetyTier = resolveDispatchSafetyTier({
      runTier: run.safetyTier,
      projectDefaultRaw: projectVars.projectJson.default_safety_tier,
    });
    const launchCommand = `${WORKER_ENV_PREFIX} && ${buildRunnerSessionReloadCommand(
      vars,
      runner,
      selected.model ?? run.metrics.model,
      sessionBinding.runnerSessionId,
      {
        effort: run.effort,
        runtimeDir,
        safetyTier,
        taskDir: run.taskFile ? path.posix.dirname(run.taskFile) : undefined,
      },
    )}`;
    await respawnTmuxWindowWithCommand(vars, nextTarget.target, launchCommand, {
      preserveWindowAfterExit: selected.role !== 'self-review',
    });
    await new Promise((resolve) => setTimeout(resolve, TMUX_WINDOW_RESPAWN_SETTLE_MS));
    const livePane = await waitForRunnerAliveInTarget(vars, ref.session, nextTarget.target, runner);
    if (!livePane) {
      throw new Error(
        `Reloaded ${runner} session ${sessionBinding.runnerSessionId}, but no runner process became live`,
      );
    }
    const liveRef = workerRefFromPane(vars, livePane);
    persistRestoredContext(run.id, selected.id, {
      status: 'working',
      target: agentTargetFromWorkerRef(liveRef),
      runnerSessionId: sessionBinding.runnerSessionId,
      runnerSessionPath: sessionBinding.runnerSessionPath,
    });
    return {
      slotId: params.slotId,
      runId: run.id,
      restored: true,
      contexts: [
        {
          contextId: selected.id,
          role: selected.role,
          status: 'reloaded-session',
          target: liveRef,
          runnerSessionId: sessionBinding.runnerSessionId,
          runnerSessionPath: sessionBinding.runnerSessionPath,
          detail: `Reloaded ${runner} session ${sessionBinding.runnerSessionId}.`,
        },
      ],
    };
  }
  const restoredInspection = await inspectContextRuntime(run, { ...selected, target: nextTarget });
  persistRestoredContext(run.id, selected.id, {
    status: restoredInspection.runnerAlive ? 'working' : 'waiting',
    target: nextTarget,
    runnerSessionId:
      restoredInspection.runnerSessionId ??
      binding?.runnerSessionId ??
      selected.runnerSessionId ??
      null,
    runnerSessionPath:
      restoredInspection.runnerSessionPath ??
      binding?.runnerSessionPath ??
      selected.runnerSessionPath ??
      null,
  });
  return {
    slotId: params.slotId,
    runId: run.id,
    restored: true,
    contexts: [
      {
        contextId: selected.id,
        role: selected.role,
        status: 'restored-window',
        target: ref,
        runnerSessionId: binding?.runnerSessionId ?? selected.runnerSessionId ?? null,
        runnerSessionPath: binding?.runnerSessionPath ?? selected.runnerSessionPath ?? null,
        detail: 'Restored tmux window; runner process was not auto-replayed.',
      },
    ],
  };
}
