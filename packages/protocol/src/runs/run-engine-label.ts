import { workerRoleForFlow } from '../agents/roles.js';
import type { AgentRole } from '../contracts/agents.js';

/** The runner and model a run is shown with. */
export interface RunEngine {
  runner?: string | null;
  model?: string | null;
}

/** The fields of a run that can name its worker's effort; a full Run satisfies it. */
export interface RunEffortSource {
  flowType?: string | null;
  effort?: string | null;
  metrics?: RunEngine;
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
 * execution-profile choice matching the runner and model shown for the run (`engine`, the
 * run's metrics by default). Null when nothing names one.
 */
export function runWorkerEffort(
  run: RunEffortSource,
  engine: RunEngine = run.metrics ?? {},
): string | null {
  // A flow type this client doesn't know has no worker role to read.
  const role = workerRoleForFlow(run.flowType);
  const worker = role ? run.agentContexts?.find((context) => context.role === role) : undefined;
  const choice = run.workflowExecution?.models.find(
    (entry) => entry.runner === engine.runner && (entry.model ?? null) === (engine.model ?? null),
  );
  for (const value of [worker?.effort, worker?.nativeSession?.effort, run.effort, choice?.effort]) {
    const effort = value?.trim();
    if (effort) return effort;
  }
  return null;
}

/**
 * Word shown for a run's reasoning effort.
 * No value, and Pi's `off`, both mean no reasoning effort was sent. The model
 * keeps its own default and still reasons, so the list says `default`.
 * Any other stored level is shown as written. `none` is an explicit disable.
 */
export function reasoningEffortLabel(effort: string | null | undefined): string {
  const value = effort?.trim() ?? '';
  if (value === '' || value.toLowerCase() === 'off') return 'default';
  if (value.toLowerCase() === 'none') return 'off';
  return value;
}

/** "runner/model · effort". Null when neither runner nor model is. */
export function runEngineLabel(engine: {
  runner: string | null;
  model: string | null;
  effort?: string | null;
}): string | null {
  const base = engine.model ? `${engine.runner ?? 'runner'}/${engine.model}` : engine.runner;
  if (!base) return null;
  return `${base} · ${reasoningEffortLabel(engine.effort)}`;
}
