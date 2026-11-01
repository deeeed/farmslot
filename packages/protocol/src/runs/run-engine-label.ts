import { primaryRoleForFlow } from '../agents/roles.js';
import type { AgentRole } from '../contracts/agents.js';
import type { Run } from '../contracts/runs.js';

/** The fields of a run that can name its worker's effort; a full Run satisfies it. */
export interface RunEffortSource {
  flowType: Run['flowType'];
  effort?: string | null;
  metrics?: { runner?: string | null; model?: string | null };
  agentContexts?: readonly {
    role: AgentRole;
    effort?: string | null;
    nativeSession?: { effort?: string | null };
  }[];
  workflowExecution?: {
    models: readonly { runner: string; model: string | null; effort: string | null }[];
  };
}

/**
 * The worker's reasoning effort, when a record names it: the worker context the dispatch
 * launched (its own effort, then its native session's), the run's dispatch effort, then the
 * execution-profile choice matching the run's runner and model. Null when nothing names one.
 */
export function runWorkerEffort(run: RunEffortSource): string | null {
  const role = primaryRoleForFlow(run.flowType);
  const worker = run.agentContexts?.find((context) => context.role === role);
  const choice = run.workflowExecution?.models.find(
    (entry) =>
      entry.runner === run.metrics?.runner &&
      (entry.model ?? null) === (run.metrics?.model ?? null),
  );
  for (const value of [worker?.effort, worker?.nativeSession?.effort, run.effort, choice?.effort]) {
    const effort = value?.trim();
    if (effort) return effort;
  }
  return null;
}

/** "runner/model · effort"; the effort only when known. Null when neither runner nor model is. */
export function runEngineLabel(engine: {
  runner: string | null;
  model: string | null;
  effort?: string | null;
}): string | null {
  const base = engine.model ? `${engine.runner ?? 'runner'}/${engine.model}` : engine.runner;
  if (!base) return null;
  return engine.effort ? `${base} · ${engine.effort}` : base;
}
