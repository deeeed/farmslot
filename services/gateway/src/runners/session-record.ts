// session-record.ts — the ONE runner-layer hook that binds a persisted runner
// session to the AgentContext role that owns it.
//
// Before this module every launch/relaunch/handoff site hand-wrote the two
// session fields onto its own upsert, so the sites that respawned a runner
// (review fix relaunch, CI inline fix) cleared the pair and never recorded
// the new session. An operator could then see a live worker with no way to
// reopen its conversation. Capture stays in `captureRunnerSessionMetadata` —
// this module owns *recording* it, and offers the capture+record pair for sites
// that have no metadata of their own yet.

import type { AgentContext, AgentContextTarget, AgentRole, Run } from '@farmslot/protocol';

import { selectAgentContext, upsertAgentContext } from '../agents/contexts.js';
import type { loadSlotVars } from '../core/config.js';
import { getRun } from '../runs/store.js';

import {
  captureRunnerSessionMetadata,
  resolvePersistedRunnerSessionBinding,
  type RunnerSessionCaptureOptions,
  type RunnerSessionMetadata,
} from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

/** Exact pane identity, including the reviewer and direct-pane target forms. */
export function contextPaneId(target: AgentContextTarget): string | null {
  for (const candidate of [target.paneId, target.pane, target.target]) {
    if (candidate && /^%\d+$/.test(candidate)) return candidate;
  }
  return null;
}

/** Roles can share one worker, but only a complete saved binding proves that alias. */
export function runnerSessionContextTarget(
  run: Pick<Run, 'slotId' | 'agentContexts'>,
  context: AgentContext,
): AgentContextTarget | null {
  const target = context.target;
  if (!target) return null;
  const ownPane = contextPaneId(target);
  if (ownPane) return { ...target, paneId: ownPane };
  const slotId = context.slotId ?? run.slotId;
  if (!slotId || !context.runner || !context.runnerSessionId || !context.runnerSessionPath)
    return null;
  const peers = (run.agentContexts ?? []).filter(
    (peer) =>
      peer.id !== context.id &&
      !peer.nativeSession &&
      !peer.nativeSessionOwner &&
      (peer.slotId ?? run.slotId) === slotId &&
      peer.runner === context.runner &&
      peer.runnerSessionId === context.runnerSessionId &&
      peer.runnerSessionPath === context.runnerSessionPath &&
      peer.target?.session === target.session &&
      (peer.target.target === target.target ||
        (target.window && peer.target.window === target.window)),
  );
  const panes = new Set(
    peers.flatMap((peer) => {
      const pane = peer.target && contextPaneId(peer.target);
      return pane ? [pane] : [];
    }),
  );
  if (panes.size !== 1) return null;
  return { ...target, paneId: [...panes][0] };
}

export interface RunnerSessionContextPatch {
  runnerSessionId: string;
  runnerSessionPath: string;
  runnerSessionCapturedAt: string;
}

export interface ClearedRunnerSessionContextPatch {
  runnerSessionId: null;
  runnerSessionPath: null;
  runnerSessionCapturedAt: undefined;
}

/**
 * Drop a role's session identity as one unit. `upsertAgentContext` merges
 * patches, so a site that nulls only the id/path leaves the old capture
 * timestamp behind, dating a session that no longer exists. Every site that
 * respawns a runner must clear all three together.
 */
export function clearedRunnerSessionContextPatch(): ClearedRunnerSessionContextPatch {
  return {
    runnerSessionId: null,
    runnerSessionPath: null,
    runnerSessionCapturedAt: undefined,
  };
}

/**
 * Build the agent-context patch for a captured session, or null when the
 * capture produced no complete id/path pair. Half a binding is never written:
 * a lone id cannot be reopened and a lone path cannot be attributed.
 */
export function runnerSessionContextPatch(
  session: RunnerSessionMetadata,
  label: string,
  now: Date = new Date(),
): RunnerSessionContextPatch | null {
  const resolved = resolvePersistedRunnerSessionBinding([
    {
      label,
      runnerSessionId: session.runnerSessionId,
      runnerSessionPath: session.runnerSessionPath,
    },
  ]);
  if (!resolved.binding) return null;
  return {
    runnerSessionId: resolved.binding.runnerSessionId,
    runnerSessionPath: resolved.binding.runnerSessionPath,
    runnerSessionCapturedAt: now.toISOString(),
  };
}

export interface RecordRunnerSessionOptions {
  runId: string;
  role: AgentRole;
  /**
   * Exact context to write. Reviewer loops allocate non-canonical ids such as
   * `rev-codex`, and without this the hook would collapse every reviewer onto
   * the canonical role context and lose the individual sessions.
   */
  contextId?: string;
  /** Context label, when creating rather than updating a non-canonical context. */
  label?: string;
  session: RunnerSessionMetadata;
  /** Capture site, used in the incomplete-binding diagnostic. */
  captureLabel: string;
  /** Pane used for a successful exact-pane session capture. */
  paneId?: string | null;
  now?: Date;
}

export interface RunnerSessionRecordDeps {
  upsert: typeof upsertAgentContext;
  readRun?: typeof getRun;
}

/** Record an already-captured session on the role that owns it. */
export async function recordRunnerSessionForRole(
  options: RecordRunnerSessionOptions,
  deps: RunnerSessionRecordDeps = { upsert: upsertAgentContext },
): Promise<AgentContext | null> {
  const patch = runnerSessionContextPatch(options.session, options.captureLabel, options.now);
  const run = (deps.readRun ?? getRun)(options.runId);
  const context =
    run &&
    (options.contextId
      ? run.agentContexts?.find((entry) => entry.id === options.contextId)
      : selectAgentContext(run, { role: options.role }));
  const capturedTarget =
    context?.target && options.paneId && /^%\d+$/.test(options.paneId)
      ? { ...context.target, paneId: options.paneId }
      : null;
  const target =
    capturedTarget ??
    (run && context ? runnerSessionContextTarget(run, { ...context, ...patch }) : null);
  // Pane capture and transcript capture are independent. A runner can start
  // before its transcript exists; retain its exact pane for later cleanup.
  if (!patch && !capturedTarget) return null;
  return deps.upsert(options.runId, options.role, {
    ...patch,
    ...(target ? { target } : {}),
    ...(options.contextId ? { id: options.contextId } : {}),
    ...(options.label ? { label: options.label } : {}),
  });
}

export interface CaptureAndRecordRunnerSessionOptions {
  vars: SlotVars;
  runner: string;
  runId: string;
  role: AgentRole;
  contextId?: string;
  label?: string;
  captureLabel: string;
  beforePaths?: string[];
  capture?: RunnerSessionCaptureOptions;
  now?: Date;
}

export interface CaptureAndRecordRunnerSessionDeps extends RunnerSessionRecordDeps {
  capture: typeof captureRunnerSessionMetadata;
}

/**
 * Capture the runner session that a freshly launched pane owns and record it on
 * the role. Used by the relaunch paths, which respawn the runner and therefore
 * own a brand-new session id that no earlier capture can supply.
 */
export async function captureAndRecordRunnerSession(
  options: CaptureAndRecordRunnerSessionOptions,
  deps: CaptureAndRecordRunnerSessionDeps = {
    capture: captureRunnerSessionMetadata,
    upsert: upsertAgentContext,
  },
): Promise<RunnerSessionMetadata> {
  const session = await deps.capture(
    options.vars,
    options.runner,
    options.beforePaths ?? [],
    options.capture ?? {},
  );
  await recordRunnerSessionForRole(
    {
      runId: options.runId,
      role: options.role,
      session,
      captureLabel: options.captureLabel,
      paneId: options.capture?.paneId,
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
    { upsert: deps.upsert, readRun: deps.readRun },
  );
  return session;
}
