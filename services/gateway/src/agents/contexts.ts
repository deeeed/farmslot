import {
  type AgentContext,
  type AgentContextSelector,
  type AgentContextStatus,
  type AgentContextSummary,
  agentContextTaskFile,
  type AgentRole,
  agentRoleForWindowName,
  agentRoleLabel,
  agentRoleWindow,
  allocateReviewerContext,
  contextIdFor,
  isReviewerAgentContext,
  isReviewerAgentRole,
  isReviewerWindowName,
  primaryRoleForFlow,
  type Run,
  selectLatestReviewerContext,
  signalFileForTask,
} from '@farmslot/protocol';

import {
  selectSingleActiveRunForSlot,
  SKIP_ACTIVE_RUN_SELECTION,
} from '../core/active-run-selection.js';
import { loadSlotVars } from '../core/config.js';
import { updateSlotStatus } from '../core/state.js';
import { resolveTmuxSession } from '../core/tmux.js';
import { loadFleetStatus } from '../fleet/state.js';
import { canonicalAgentContextTarget } from '../methods/dispatch/role-target.js';
import { getRun, listRuns, updateRunAgentContexts } from '../runs/store.js';

const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentContextStatus> = new Set([
  'complete',
  'failed',
  'blocked',
  'idle',
]);
export function summarizeAgentContexts(run: Pick<Run, 'agentContexts'>): AgentContextSummary[] {
  return (run.agentContexts ?? []).map((ctx) => {
    const {
      id,
      role,
      label,
      status,
      runId,
      taskFile,
      signalFile,
      runner,
      model,
      target,
      nudgeCount,
      ctxPct,
      lastSignalAt,
      updatedAt,
    } = ctx;
    return {
      id,
      role,
      label,
      status,
      runId,
      taskFile,
      signalFile,
      runner,
      model,
      target,
      nudgeCount,
      ctxPct,
      lastSignalAt,
      updatedAt,
    };
  });
}

export function synthesizePrimaryContext(run: Run): AgentContext | null {
  const role = primaryRoleForFlow(run.flowType);
  const taskFile = agentContextTaskFile(run.taskFile, run.activeTaskFile);
  return {
    id: contextIdFor(role),
    role,
    label: agentRoleLabel(role),
    status: statusFromRun(run.status),
    slotId: run.slotId ?? '',
    runId: run.id,
    taskFile,
    signalFile: signalFileForTask(taskFile),
    runner: run.metrics.runner,
    model: run.metrics.model,
    target: null,
    runnerSessionId: run.metrics.runnerSessionId,
    runnerSessionPath: run.metrics.runnerSessionPath,
    nudgeCount: run.metrics.nudgeCount,
    updatedAt: run.updatedAt,
  };
}

export function getAgentContexts(run: Run): AgentContext[] {
  if (run.agentContexts && run.agentContexts.length > 0) return run.agentContexts;
  const primary = synthesizePrimaryContext(run);
  return primary ? [primary] : [];
}

export function selectAgentContext(run: Run, selector?: AgentContextSelector): AgentContext | null {
  const contexts = getAgentContexts(run);
  if (selector?.contextId) {
    return contexts.find((ctx) => ctx.id === selector.contextId) ?? null;
  }
  // Explicit non-primary role: exact match only. For self-review / reviewer tabs,
  // prefer the latest reviewer when multiple coexist on the same run.
  if (selector?.role && selector.role !== 'primary') {
    if (isReviewerAgentRole(selector.role)) {
      return (
        selectLatestReviewerContext(contexts) ??
        contexts.find((ctx) => ctx.role === selector.role) ??
        null
      );
    }
    return contexts.find((ctx) => ctx.role === selector.role) ?? null;
  }
  // No selector, or selector.role === 'primary': resolve the flow's primary role
  const primaryFlowRole = primaryRoleForFlow(run.flowType);
  return (
    contexts.find((ctx) => ctx.role === primaryFlowRole) ??
    contexts.find((ctx) => ctx.role === 'primary') ??
    null
  );
}

function targetWindowName(target: string): string | null {
  const separator = target.indexOf(':');
  const windowPart = separator === -1 ? '' : target.slice(separator + 1);
  if (!windowPart) return null;
  return windowPart.split('.', 1)[0] || null;
}

function roleForWindowName(windowName: string | null): AgentRole | null {
  return agentRoleForWindowName(windowName);
}

// Rate-limit per-slot warnings so an ambiguous slot stuck across many monitor
// poll ticks does not flood the log with the same message.
const RATE_LIMITED_WARN_INTERVAL_MS = 30_000;
const lastWarnAt = new Map<string, number>();
function rateLimitedWarn(slotId: string, message: string): void {
  const now = Date.now();
  const prev = lastWarnAt.get(slotId);
  if (prev !== undefined && now - prev < RATE_LIMITED_WARN_INTERVAL_MS) return;
  lastWarnAt.set(slotId, now);
  console.warn(message);
}

function assertSelectorTargetMatchesRole(selector: AgentContextSelector): void {
  if (selector.contextId && selector.role) {
    const roleMatchesCanonical = selector.contextId === contextIdFor(selector.role);
    const reviewerOk =
      isReviewerAgentRole(selector.role) &&
      (selector.contextId.startsWith('rev-') ||
        /^rev\d+-/.test(selector.contextId) ||
        selector.contextId === contextIdFor('self-review'));
    if (!roleMatchesCanonical && !reviewerOk) {
      throw new Error(
        `Agent target selector mismatch: context ${selector.contextId} does not match role ${selector.role}`,
      );
    }
  }
  if (!selector.target?.trim()) return;
  const windowName = targetWindowName(selector.target.trim());
  const windowRole = roleForWindowName(windowName);
  if (windowRole && selector.contextId) {
    const contextMatchesWindow = isReviewerWindowName(windowName)
      ? selector.contextId === windowName
      : selector.contextId === contextIdFor(windowRole) || selector.contextId === windowName;
    if (!contextMatchesWindow) {
      throw new Error(
        `Agent target selector mismatch: target ${selector.target.trim()} belongs to context ${windowName ?? contextIdFor(windowRole)}, not ${selector.contextId}`,
      );
    }
  }
  if (!selector.role || selector.role === 'primary') return;
  if (windowRole && windowRole !== selector.role) {
    throw new Error(
      `Agent target selector mismatch: target ${selector.target.trim()} belongs to role ${windowRole}, not ${selector.role}`,
    );
  }
}

export async function resolveAgentTarget(
  slotId: string,
  selector?: AgentContextSelector & { runId?: string | null },
): Promise<{ target: string; session: string; role?: AgentRole; contextId?: string }> {
  if (selector) assertSelectorTargetMatchesRole(selector);
  if (selector?.target?.trim()) {
    const target = selector.target.trim();
    const targetSession = target.split(':')[0] || target;
    // Validate the target session belongs to this slot
    const vars = await loadSlotVars(slotId);
    const expectedSession = await resolveTmuxSession(slotId, vars, { strict: true });
    if (targetSession !== expectedSession) {
      throw new Error(
        `Target session ${targetSession} does not belong to slot ${slotId} (expected ${expectedSession})`,
      );
    }
    const role = selector.role;
    return {
      target,
      session: targetSession,
      role,
      contextId: selector.contextId ?? (role ? contextIdFor(role) : undefined),
    };
  }

  // Explicit selector callers (subscribe with non-primary role, dispatch,
  // role-targeted nudges, runId-bound calls) want ambiguity to fail loudly.
  // Implicit/UI-default callers — including terminal-view's `role: 'primary'`
  // (slot-view passes this whenever no role context is selected) and bare
  // poll/snapshot/monitor calls — must degrade to "no run" so the downstream
  // code can fall back to the bare session view instead of throwing.
  const nonPrimaryRole = selector?.role && selector.role !== 'primary';
  const explicitSelector = !!(selector && (selector.runId || selector.contextId || nonPrimaryRole));
  let run: ReturnType<typeof getRun> | null;
  try {
    run = selector?.runId ? getRun(selector.runId) : await findActiveRunForSlot(slotId);
  } catch (err) {
    if (explicitSelector) throw err;
    rateLimitedWarn(
      slotId,
      `[agent-contexts] degrading to bare session for ${slotId}: ${(err as Error).message}`,
    );
    run = null;
  }
  const ctx = run ? selectAgentContext(run, selector) : null;
  const explicitNonPrimaryRole = selector?.role && selector.role !== 'primary';
  if ((selector?.contextId || explicitNonPrimaryRole) && !ctx) {
    const requested = selector?.contextId
      ? `context ${selector.contextId}`
      : `role ${selector?.role}`;
    throw new Error(`No active agent ${requested} for slot ${slotId}`);
  }
  if (ctx?.target?.target) {
    return {
      target: canonicalAgentContextTarget(ctx.target),
      session: ctx.target.session,
      role: ctx.role,
      contextId: ctx.id,
    };
  }

  const vars = await loadSlotVars(slotId);
  const session = await resolveTmuxSession(slotId, vars, { strict: true });
  const role = ctx?.role ?? selector?.role;
  const contextId = ctx?.id ?? (role ? contextIdFor(role) : undefined);
  // Only construct a role-scoped window target when no context exists (explicit
  // role request without a run). When a context exists but has no stored target
  // (synthesized from legacy runs pre-role-scoping), the worker lives in the
  // default session window, not a role-named one.
  const windowName = !ctx && role && role !== 'primary' ? agentRoleWindow(role) : null;
  const target = windowName ? `${session}:${windowName}` : session;
  return {
    target,
    session,
    role,
    contextId,
  };
}

const agentContextChains = new Map<string, Promise<unknown>>();

export async function upsertAgentContext(
  runId: string,
  role: AgentRole,
  patch: Partial<AgentContext>,
): Promise<AgentContext | null> {
  const previous = agentContextChains.get(runId) ?? Promise.resolve();
  const applyMutation = async () => {
    const run = getRun(runId);
    if (!run || !run.slotId) return null;
    const slotId = run.slotId;
    const now = new Date().toISOString();
    let nextContext: AgentContext;
    const updated = updateRunAgentContexts(runId, (currentRun, currentContexts) => {
      const explicitId = typeof patch.id === 'string' && patch.id.trim() ? patch.id.trim() : null;
      const identityId = explicitId ?? contextIdFor(role);
      const contexts = currentContexts.filter((ctx) => ctx.id !== identityId);
      const existing = currentContexts.find((ctx) => ctx.id === identityId);
      // A relaunch keeps identity/nudge history but clears stale terminal timestamps.
      // When transitioning FROM a terminal status, clear completedAt so the context
      // restarts cleanly. When transitioning TO a terminal status, preserve any fresh
      // completedAt from the patch (terminal→terminal transitions must not drop it).
      const enteringTerminal = patch.status && TERMINAL_AGENT_STATUSES.has(patch.status);
      const leavingTerminal =
        existing &&
        TERMINAL_AGENT_STATUSES.has(existing.status) &&
        patch.status &&
        !TERMINAL_AGENT_STATUSES.has(patch.status);
      const existingForMerge =
        existing &&
        (leavingTerminal || (patch.status && !enteringTerminal && patch.completedAt === undefined))
          ? { ...existing, completedAt: undefined, lastSignalAt: undefined }
          : existing;
      const {
        id: _ignoredId,
        role: _ignoredRole,
        runId: _ignoredRunId,
        slotId: _ignoredSlotId,
        ...safePatch
      } = patch;
      const context: AgentContext = {
        label: agentRoleLabel(role),
        status: 'working',
        runner: currentRun.metrics.runner,
        model: currentRun.metrics.model,
        ...existingForMerge,
        ...safePatch,
        id: identityId,
        role,
        runId,
        slotId: currentRun.slotId ?? slotId,
        updatedAt: now,
      };
      if (!context.startedAt) context.startedAt = now;
      nextContext = context;
      return [...contexts, context];
    });
    if (!updated?.slotId) return nextContext!;
    try {
      await updateSlotStatus(updated.slotId, { agent_contexts: summarizeAgentContexts(updated) });
    } catch (err) {
      // Slot mirror is best-effort — the farm-status.json write can fail when
      // the slot was just released (no entry in fleet) or during concurrent
      // resets. The run-store remains the source of truth for agent contexts.
      console.warn(
        `[agent-contexts] slot mirror failed for ${updated.slotId}: ${(err as Error).message}`,
      );
    }
    return nextContext!;
  };
  const result = previous.then(applyMutation, applyMutation);
  // Keep the serialization tail alive after a failed caller-visible mutation,
  // so one slot mirror failure cannot prevent later context updates.
  const tail = result.catch(() => null);
  agentContextChains.set(runId, tail);
  try {
    return await result;
  } finally {
    if (agentContextChains.get(runId) === tail) agentContextChains.delete(runId);
  }
}

export async function markAgentContextStatus(
  runId: string,
  role: AgentRole,
  status: AgentContextStatus,
  patch: Partial<AgentContext> = {},
): Promise<void> {
  const completedAt = TERMINAL_AGENT_STATUSES.has(status) ? new Date().toISOString() : undefined;
  await upsertAgentContext(runId, role, {
    status,
    ...(completedAt ? { completedAt } : {}),
    ...patch,
  });
}

/**
 * Register or refresh a same-run reviewer context with a short tmux tab name.
 * Multiple reviewers can coexist; warm mode reuses the same-runner tab.
 */
export async function upsertReviewerAgentContext(
  runId: string,
  opts: {
    runner: string;
    model?: string | null;
    mode?: 'warm' | 'fresh';
    patch?: Partial<AgentContext>;
  },
): Promise<AgentContext | null> {
  const run = getRun(runId);
  if (!run) return null;
  const allocated = allocateReviewerContext({
    runId,
    runner: opts.runner,
    model: opts.model ?? null,
    existing: run.agentContexts ?? [],
    mode: opts.mode ?? 'warm',
  });
  const patch = opts.patch ?? {};
  const existingTarget = patch.target;
  const session = existingTarget?.session?.trim() || '';
  const windowName = existingTarget?.window?.trim() || allocated.windowName;
  const target = existingTarget ?? {
    session,
    window: windowName,
    pane: null,
    target: session ? `${session}:${windowName}` : windowName,
  };
  return upsertAgentContext(runId, 'self-review', {
    ...patch,
    id: allocated.id,
    label: allocated.label,
    runner: allocated.runner,
    model: allocated.model,
    target,
  });
}

export function listReviewerContextsForRun(run: Run): AgentContext[] {
  return getAgentContexts(run).filter((ctx) => isReviewerAgentContext(ctx));
}

function statusFromRun(status: Run['status']): AgentContextStatus {
  if (status === 'done') return 'complete';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'cancelled') return 'failed';
  if (status === 'paused') return 'waiting';
  return 'working';
}

async function findActiveRunForSlot(slotId: string): Promise<Run | null> {
  const slot = (await loadFleetStatus()).slots.find((s) => s.slot === slotId);
  const activeRuns = listRuns({
    active: true,
    sort: 'newest',
    limit: Number.MAX_SAFE_INTEGER,
  }).runs;
  // Policy: stale/missing currentRunId falls back to the slotId-only filter
  // (preserves prior behavior); genuine ambiguity throws so explicit-API
  // callers fail loudly. resolveAgentTarget catches the throw for implicit
  // selectors so event-loop paths degrade instead of crashing.
  const result = selectSingleActiveRunForSlot(slotId, activeRuns, {
    currentRunId: slot?.currentRunId ?? null,
    onAmbiguous: 'throw',
    onMissingPointer: 'fallback',
    logPrefix: '[agent-contexts]',
  });
  return result === SKIP_ACTIVE_RUN_SELECTION ? null : result;
}
