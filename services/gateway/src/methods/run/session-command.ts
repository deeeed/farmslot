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

import { loadProjectVars, loadSlotVars, resolveProjectRuntimeDir } from '../../core/config.js';
import {
  resolveExactTmuxWindowPane,
  resolveTmuxSession,
  tmuxAttachCommandForTarget,
} from '../../core/tmux.js';
import {
  buildRunnerSessionReloadCommand,
  runnerSupportsSessionReload,
} from '../../runners/launch-command.js';
import { isKnownRunner, normalizeRunner } from '../../runners/registry.js';
import {
  probeRunnerDescendantPid,
  resolvePersistedRunnerSessionBinding,
} from '../../runners/session-process.js';
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
};

function unsupported(
  runId: string,
  role: AgentRole | null,
  reason: RunSessionCommandUnsupportedReason,
  detail: string,
): RunSessionCommandResult {
  return { supported: false, runId, role, reason, detail };
}

/** Role selection: explicit request, else the flow's primary worker role. */
export function selectSessionContext(
  run: Pick<Run, 'flowType' | 'agentContexts'>,
  role?: AgentRole,
): { role: AgentRole; context: AgentContext | null } {
  const requested = role ?? primaryRoleForFlow(run.flowType);
  const contexts = run.agentContexts ?? [];
  const matching = contexts.filter((candidate) => candidate.role === requested);
  // Several attempts can share a role (reviewer loops); prefer the one that
  // actually carries a session, then the most recently updated.
  const withSession = matching.filter(
    (candidate) => candidate.runnerSessionId && candidate.runnerSessionPath,
  );
  const pool = withSession.length > 0 ? withSession : matching;
  const selected = [...pool].sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  )[0];
  return { role: requested, context: selected ?? null };
}

/**
 * Structured runner liveness for the pane that owns the session. Pane text is
 * never consulted. A pane that no longer exists is a confirmed `dead`; a probe
 * that cannot decide (unreachable machine, tmux query failure) stays `unknown`
 * with its reason, because refusing to answer would also withhold the reopen
 * command the operator came for.
 */
async function probeSessionLiveness(
  vars: SlotVars,
  runner: string,
  tmuxTarget: string | null,
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
  if (probe.state === 'present') return { liveness: 'live' };
  if (probe.state === 'absent') return { liveness: 'dead' };
  return {
    liveness: 'unknown',
    ...(probe.reason ? { livenessReason: probe.reason } : {}),
  };
}

export async function runSessionCommand(
  params: RunSessionCommandParams,
  deps: RunSessionCommandDeps = DEFAULT_DEPS,
): Promise<RunSessionCommandResult> {
  const run = deps.getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);

  const { role, context } = selectSessionContext(run, params.role);
  if (!context) {
    return unsupported(
      run.id,
      role,
      'no-agent-context',
      `Run ${run.id} has no '${role}' agent context.`,
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
  const reopenCommand = deps.buildReloadCommand(
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

  const tmuxTarget = context.target?.target ?? null;
  // A context recorded before role-scoped targets (or one whose target was
  // cleared) still lives in the slot's tmux session, and that is the session an
  // operator must attach to. Resolve it rather than withholding the attach line.
  // Non-strict resolution always yields the configured name, so this narrows to
  // null only for a slot whose config carries no session at all.
  const tmuxSession = context.target?.session ?? (await deps.resolveSession(slotId, vars)) ?? null;
  const liveness = await probeSessionLiveness(vars, runner, tmuxTarget, deps);

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
    tmuxTarget,
    reopenCommand,
    attachCommand: tmuxSession ? tmuxAttachCommandForTarget(tmuxSession, tmuxTarget) : null,
    ...liveness,
  };
}
