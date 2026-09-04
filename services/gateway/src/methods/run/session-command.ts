// session-command.ts — hand an operator the exact command that reopens the
// runner session an agent context owns.
//
// A Codex worker runs under an isolated CODEX_HOME, so a plain `codex resume`
// in a shell cannot see it. The reopen command therefore comes from the runner
// layer (`buildRunnerSessionReloadCommand`), never assembled by a client.

import path from 'node:path';

import {
  type AgentContext,
  type AgentRole,
  primaryRoleForFlow,
  type Run,
  type RunSessionCommandParams,
  type RunSessionCommandResult,
  type RunSessionCommandUnsupportedReason,
  type RunSessionLiveness,
} from '@farmslot/protocol';

import { upsertAgentContext } from '../../agents/contexts.js';
import { loadProjectVars, loadSlotVars, resolveProjectRuntimeDir } from '../../core/config.js';
import { readSlotRow } from '../../core/state.js';
import {
  resolveExactTmuxWindowPane,
  resolveTmuxSession,
  tmuxAttachCommandForTarget,
} from '../../core/tmux.js';
import {
  buildOperatorPasteableCommand,
  buildRunnerSessionReloadCommand,
  runnerSupportsSessionReload,
} from '../../runners/launch-command.js';
import { getRunnerDefinition, isKnownRunner, normalizeRunner } from '../../runners/registry.js';
import {
  probeRunnerDescendantPid,
  resolvePersistedRunnerSessionBinding,
  verifyExactLiveRunnerSessionBinding,
} from '../../runners/session-process.js';
import { rediscoverRunnerSessionPane } from '../../runners/session-rediscovery.js';
import { getRun } from '../../runs/store.js';
import { resolveDispatchSafetyTier } from '../dispatch/safety-tier.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface RunSessionCommandDeps {
  getRun: typeof getRun;
  loadSlotVars: typeof loadSlotVars;
  loadProjectVars: typeof loadProjectVars;
  resolveProjectRuntimeDir: typeof resolveProjectRuntimeDir;
  buildReloadCommand: typeof buildRunnerSessionReloadCommand;
  resolvePane: typeof resolveExactTmuxWindowPane;
  resolveSession: typeof resolveTmuxSession;
  probeRunnerPid: typeof probeRunnerDescendantPid;
  verifyBinding: typeof verifyExactLiveRunnerSessionBinding;
  rediscoverPane: typeof rediscoverRunnerSessionPane;
  upsert: typeof upsertAgentContext;
  readSlot: typeof readSlotRow;
}

const DEFAULT_DEPS: RunSessionCommandDeps = {
  getRun,
  loadSlotVars,
  loadProjectVars,
  resolveProjectRuntimeDir,
  buildReloadCommand: buildRunnerSessionReloadCommand,
  resolvePane: resolveExactTmuxWindowPane,
  resolveSession: resolveTmuxSession,
  probeRunnerPid: probeRunnerDescendantPid,
  verifyBinding: verifyExactLiveRunnerSessionBinding,
  rediscoverPane: rediscoverRunnerSessionPane,
  upsert: upsertAgentContext,
  readSlot: readSlotRow,
};

function unsupported(
  runId: string,
  role: AgentRole | null,
  reason: RunSessionCommandUnsupportedReason,
  detail: string,
): RunSessionCommandResult {
  return { supported: false, runId, role, reason, detail };
}

/**
 * Context selection. An exact `contextId` wins: reviewer loops put several
 * contexts on one role, and role alone would hand back the newest reviewer's
 * session no matter which row the operator clicked.
 */
export function selectSessionContext(
  run: Pick<Run, 'flowType' | 'agentContexts'>,
  selector: { contextId?: string; role?: AgentRole } = {},
): { role: AgentRole; context: AgentContext | null } {
  const contexts = run.agentContexts ?? [];
  const wantedId = selector.contextId?.trim();
  if (wantedId) {
    const exact = contexts.find((candidate) => candidate.id === wantedId) ?? null;
    return {
      role: exact?.role ?? selector.role ?? primaryRoleForFlow(run.flowType),
      context: exact,
    };
  }
  const requested = selector.role ?? primaryRoleForFlow(run.flowType);
  const matching = contexts.filter((candidate) => candidate.role === requested);
  // Several attempts can share a role (reviewer loops); prefer the one that
  // actually carries a session, then the most recently updated.
  const withSession = matching.filter(
    (candidate) => candidate.runnerSessionId && candidate.runnerSessionPath,
  );
  const pool = withSession.length > 0 ? withSession : matching;
  // `updatedAt` is an ISO-8601 timestamp, so lexicographic order is
  // chronological order. Do not store a non-ISO value here.
  const selected = [...pool].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  )[0];
  return { role: requested, context: selected ?? null };
}

/**
 * Structured runner liveness for the pane that owns THIS session. Pane text is
 * never consulted.
 *
 * A same-type runner process in the pane is not enough: panes get reused, so a
 * newer Codex process would otherwise label an older session live and send the
 * operator to the wrong conversation. `live` therefore requires the pane's
 * active runner session to be the exact id/path we are handing back; anything
 * the check cannot confirm degrades to `unknown` with its reason.
 *
 * A pane that no longer exists is a confirmed `dead`; a probe that cannot
 * decide (unreachable machine, tmux query failure) stays `unknown`, because
 * refusing to answer would also withhold the reopen command the operator came
 * for.
 */
async function probeSessionLiveness(
  vars: SlotVars,
  runner: string,
  tmuxTarget: string | null,
  session: { runnerSessionId: string; runnerSessionPath: string },
  deps: RunSessionCommandDeps,
): Promise<{ liveness: RunSessionLiveness; livenessReason?: string }> {
  if (!tmuxTarget) {
    return { liveness: 'unknown', livenessReason: 'agent context recorded no tmux target' };
  }
  let pane: Awaited<ReturnType<typeof resolveExactTmuxWindowPane>>;
  try {
    pane = await deps.resolvePane(vars, tmuxTarget);
  } catch (err) {
    return { liveness: 'unknown', livenessReason: (err as Error).message };
  }
  if (!pane)
    return { liveness: 'dead', livenessReason: `tmux target ${tmuxTarget} no longer exists` };
  const probe = await deps.probeRunnerPid(vars, pane.panePid, runner);
  if (probe.state === 'present') {
    const owned = await deps.verifyBinding(vars, runner, {
      paneId: pane.paneId,
      slotId: vars.slotId,
      expectedSessionId: session.runnerSessionId,
      expectedSessionPath: session.runnerSessionPath,
    });
    if (owned.ok) return { liveness: 'live' };
    // A live runner that owns a different session means this session is not the
    // one running here. That is not proof it is gone, so it stays `unknown`.
    return {
      liveness: 'unknown',
      livenessReason: owned.reason ?? 'the live runner process does not own this persisted session',
    };
  }
  if (probe.state === 'absent') return { liveness: 'dead' };
  return {
    liveness: 'unknown',
    ...(probe.reason ? { livenessReason: probe.reason } : {}),
  };
}

/**
 * The run that currently holds the slot, or null when the slot row is
 * unreadable or unowned. Same field dispatch and replay reclaim read.
 */
async function resolveSlotOwner(
  slotId: string,
  deps: RunSessionCommandDeps,
): Promise<string | null> {
  const row = await deps.readSlot(slotId);
  const owner = row?.current_run_id;
  return typeof owner === 'string' && owner.trim() ? owner : null;
}

export async function runSessionCommand(
  params: RunSessionCommandParams,
  deps: RunSessionCommandDeps = DEFAULT_DEPS,
): Promise<RunSessionCommandResult> {
  const run = deps.getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);

  const { role, context } = selectSessionContext(run, {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    ...(params.role ? { role: params.role } : {}),
  });
  if (!context) {
    return unsupported(
      run.id,
      role,
      'no-agent-context',
      params.contextId
        ? `Run ${run.id} has no agent context '${params.contextId}'.`
        : `Run ${run.id} has no '${role}' agent context.`,
    );
  }

  const slotId = run.slotId ?? context.slotId;
  if (!slotId) {
    return unsupported(run.id, role, 'no-slot', `Run ${run.id} is not bound to a slot.`);
  }

  const rawRunner = context.runner ?? run.metrics.runner;
  const runner = normalizeRunner(rawRunner);
  if (!rawRunner || !isKnownRunner(runner)) {
    return unsupported(
      run.id,
      role,
      'unknown-runner',
      `Agent context '${context.id}' records no known runner${rawRunner ? ` (got '${rawRunner}')` : ''}.`,
    );
  }
  if (!runnerSupportsSessionReload(runner)) {
    return unsupported(
      run.id,
      role,
      'session-reload-unsupported',
      `Runner '${runner}' has no validated session reload; there is no command that reopens its session.`,
    );
  }

  const isPrimaryRole = role === primaryRoleForFlow(run.flowType);
  const binding = resolvePersistedRunnerSessionBinding([
    {
      label: `agent context '${context.id}'`,
      runnerSessionId: context.runnerSessionId,
      runnerSessionPath: context.runnerSessionPath,
    },
    // The worker role and the run share one session, so a legacy run whose
    // context predates per-role capture can still be reopened from metrics.
    ...(isPrimaryRole
      ? [
          {
            label: 'run metrics',
            runnerSessionId: run.metrics.runnerSessionId,
            runnerSessionPath: run.metrics.runnerSessionPath,
          },
        ]
      : []),
  ]);
  if (!binding.binding) {
    return unsupported(
      run.id,
      role,
      'session-not-captured',
      binding.reason ?? `No runner session was captured for the '${role}' context.`,
    );
  }

  const vars = await deps.loadSlotVars(slotId);
  const projectVars = await deps.loadProjectVars(run.project);
  const runtimeDir = await deps.resolveProjectRuntimeDir(run.project);
  const safetyTier = resolveDispatchSafetyTier({
    runTier: run.safetyTier,
    projectDefaultRaw: projectVars.projectJson.default_safety_tier,
  });
  const model = context.model ?? run.metrics.model ?? null;
  const rawReopenCommand = deps.buildReloadCommand(
    vars,
    runner,
    model,
    binding.binding.runnerSessionId,
    {
      effort: run.effort,
      runtimeDir,
      safetyTier,
      ...(run.taskFile ? { taskDir: path.posix.dirname(run.taskFile) } : {}),
      ...(run.metrics.providerAccountLabel
        ? { codexAccountLabel: run.metrics.providerAccountLabel }
        : {}),
    },
  );
  // Operator-facing: this string is pasted into whatever interactive shell the
  // operator has, so it must survive zsh/bash history expansion.
  const reopenCommand = buildOperatorPasteableCommand(rawReopenCommand);

  const tmuxTarget = context.target?.target ?? null;
  // A context recorded before role-scoped targets (or one whose target was
  // cleared) still lives in the slot's tmux session, and that is the session an
  // operator must attach to. Resolve it rather than withholding the attach line.
  // Non-strict resolution always yields the configured name, so this narrows to
  // null only for a slot whose config carries no session at all.
  const tmuxSession = context.target?.session ?? (await deps.resolveSession(slotId, vars)) ?? null;
  const recorded = await probeSessionLiveness(vars, runner, tmuxTarget, binding.binding, deps);

  // The recorded window is not where the session must be. Dispatch removes a
  // role window when its runner exits, so a reopen — pasted by an operator or
  // replayed by validation — usually lands in a different window. Search the
  // slot's tmux session before reporting the conversation gone.
  let effectiveTarget = tmuxTarget;
  let effectivePaneId = context.target?.paneId ?? null;
  let liveness = recorded;
  let rediscovered: Awaited<ReturnType<typeof rediscoverRunnerSessionPane>> | null = null;
  // A warm handoff transfers a session to a successor run, so the run asking
  // is not necessarily the run that owns the slot now. Only the current owner
  // may write a target back; a historical run gets the answer but must never
  // be able to steer the live run's pane.
  const slotOwner = await resolveSlotOwner(slotId, deps);
  const ownership = !slotOwner || slotOwner === run.id ? 'owned' : 'transferred';
  if (recorded.liveness !== 'live' && tmuxSession) {
    rediscovered = await deps.rediscoverPane({
      vars,
      session: tmuxSession,
      runner,
      expectedSessionId: binding.binding.runnerSessionId,
      expectedSessionPath: binding.binding.runnerSessionPath,
    });
    if (rediscovered.pane) {
      effectiveTarget = rediscovered.pane.target;
      effectivePaneId = rediscovered.pane.paneId;
      liveness = { liveness: 'live' };
      if (ownership === 'owned') {
        // Rebind so Command Center, the CLI, and the terminal all follow the
        // session to the exact pane it now lives in.
        await deps.upsert(run.id, context.role, {
          id: context.id,
          target: {
            session: tmuxSession,
            window: rediscovered.pane.windowName || null,
            pane: null,
            paneId: rediscovered.pane.paneId,
            target: rediscovered.pane.target,
          },
        });
      }
    } else if (rediscovered.indeterminate) {
      // Part of the session could not be probed, so absence is unproven.
      liveness = {
        liveness: 'unknown',
        ...(rediscovered.reason ? { livenessReason: rediscovered.reason } : {}),
      };
    } else if (recorded.liveness === 'dead' && rediscovered.reason) {
      liveness = { liveness: 'dead', livenessReason: rediscovered.reason };
    }
  }

  return {
    supported: true,
    runId: run.id,
    role,
    contextId: context.id,
    runner,
    model,
    sessionId: binding.binding.runnerSessionId,
    sessionPath: binding.binding.runnerSessionPath,
    capturedAt: context.runnerSessionCapturedAt ?? null,
    slotId,
    machine: vars.machine,
    tmuxTarget: effectiveTarget,
    ...(effectivePaneId ? { paneId: effectivePaneId } : {}),
    ...(rediscovered?.pane ? { rediscoveredTarget: true } : {}),
    ownership,
    ...(ownership === 'transferred' && slotOwner ? { ownerRunId: slotOwner } : {}),
    // Runner-specific stop syntax stays declared in the runner registry; no
    // caller should carry a literal like `/exit`.
    interrupt: getRunnerDefinition(runner).gracefulExit ?? null,
    reopenCommand,
    attachCommand: tmuxSession ? tmuxAttachCommandForTarget(tmuxSession, effectiveTarget) : null,
    ...liveness,
  };
}
