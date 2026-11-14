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
 * Farmslot's own completions providers. Their adapter omits `reasoning_effort`
 * for Pi `off`, and the model keeps its own default. Built-in Pi providers are
 * absent: `off` there sends an explicit disable. A renamed router id is not
 * known to the client, so only the default id `router` is included.
 */
const COMPLETIONS_OFF_OMITS = new Set(['litellm', 'ollama', 'router']);

function completionsOffOmitsEffort(model: string | null | undefined): boolean {
  const provider = model?.split('/')[0]?.trim().toLowerCase() ?? '';
  return COMPLETIONS_OFF_OMITS.has(provider);
}

/**
 * Word shown for a stored reasoning effort.
 * No value reads `default`. Pi `off` reads `default` only for the completions
 * providers above. On any other model it reads `off`, an explicit disable.
 * `none` is an explicit disable. Any other stored level is shown as written.
 */
export function reasoningEffortLabel(
  effort: string | null | undefined,
  model?: string | null,
): string {
  const value = effort?.trim() ?? '';
  if (value === '') return 'default';
  if (value.toLowerCase() === 'none') return 'off';
  if (value.toLowerCase() === 'off') return completionsOffOmitsEffort(model) ? 'default' : 'off';
  return value;
}

/** Runner, model, and the displayed effort. Blank effort is left out. */
export function runnerModelEffortParts(
  runner: string | null | undefined,
  model: string | null | undefined,
  effort: string | null | undefined,
): string[] {
  const shown = effort?.trim() ? reasoningEffortLabel(effort, model) : '';
  return [runner?.trim(), model?.trim(), shown].filter((part): part is string => Boolean(part));
}

/** "runner/model · effort". Null when neither runner nor model is. */
export function runEngineLabel(engine: {
  runner: string | null;
  model: string | null;
  effort?: string | null;
}): string | null {
  const base = engine.model ? `${engine.runner ?? 'runner'}/${engine.model}` : engine.runner;
  if (!base) return null;
  return `${base} · ${reasoningEffortLabel(engine.effort, engine.model)}`;
}
