// session-record.ts — the ONE runner-layer hook that binds a persisted runner
// session to the AgentContext role that owns it.
//
// Before this module every launch/relaunch/handoff site hand-wrote the two
// session fields onto its own upsert, so the sites that respawned a runner
// (self-review fix relaunch, CI inline fix) cleared the pair and never recorded
// the new session. An operator could then see a live worker with no way to
// reopen its conversation. Capture stays in `captureRunnerSessionMetadata` —
// this module owns *recording* it, and offers the capture+record pair for sites
// that have no metadata of their own yet.

import type { AgentContext, AgentRole } from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import type { loadSlotVars } from '../core/config.js';

import {
  captureRunnerSessionMetadata,
  resolvePersistedRunnerSessionBinding,
  type RunnerSessionCaptureOptions,
  type RunnerSessionMetadata,
} from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface RunnerSessionContextPatch {
  runnerSessionId: string;
  runnerSessionPath: string;
  runnerSessionCapturedAt: string;
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
  session: RunnerSessionMetadata;
  /** Capture site, used in the incomplete-binding diagnostic. */
  label: string;
  now?: Date;
}

export interface RunnerSessionRecordDeps {
  upsert: typeof upsertAgentContext;
}

/** Record an already-captured session on the role that owns it. */
export async function recordRunnerSessionForRole(
  options: RecordRunnerSessionOptions,
  deps: RunnerSessionRecordDeps = { upsert: upsertAgentContext },
): Promise<AgentContext | null> {
  const patch = runnerSessionContextPatch(options.session, options.label, options.now);
  if (!patch) return null;
  return deps.upsert(options.runId, options.role, patch);
}

export interface CaptureAndRecordRunnerSessionOptions {
  vars: SlotVars;
  runner: string;
  runId: string;
  role: AgentRole;
  label: string;
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
      label: options.label,
      ...(options.now ? { now: options.now } : {}),
    },
    { upsert: deps.upsert },
  );
  return session;
}
