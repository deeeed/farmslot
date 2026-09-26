import {
  type CodexReasoningEffort,
  codexReasoningEfforts,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_EFFORT,
  DEFAULT_GROK_MODEL,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_THINKING,
  PI_THINKING_LEVELS,
  type PiThinkingLevel,
  type ReviewRunnerId,
  RUNNER_PICKER_MODELS,
} from '@farmslot/protocol';

import { rememberedVisibleModels } from './runner-visible-cache.js';

export type EffortLevel = '' | CodexReasoningEffort | PiThinkingLevel;

export const RUNNER_OPTIONS: ReviewRunnerId[] = ['claude', 'codex', 'cursor', 'grok', 'pi'];

export { PI_ANTHROPIC_MODELS } from '@farmslot/protocol';

/** Built-in picker models, shared with the gateway's visible-model seed. */
export const MODELS_BY_RUNNER: Record<string, string[]> = Object.fromEntries(
  Object.entries(RUNNER_PICKER_MODELS).map(([runner, models]) => [runner, [...models]]),
);

/** Dispatch hint: PI accepts OpenAI-compatible ids once the worker registers them. */
export const PI_COMPAT_MODEL_HINT =
  'Anthropic OAuth: type anthropic/<id>. Ollama/LiteLLM/router: type ollama/<id> or litellm/<id>. Pool env: OLLAMA_HOST, LITELLM_URL, FARMSLOT_PI_ROUTER_URL. Thinking applies to every PI model.';

export const DEFAULT_MODEL: Record<string, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  codex: DEFAULT_CODEX_MODEL,
  cursor: DEFAULT_CURSOR_MODEL,
  grok: DEFAULT_GROK_MODEL,
  pi: DEFAULT_PI_MODEL,
};

/**
 * Selectable models for a runner. A saved visible set from this page wins over the
 * built-in seed, and a selected model outside that set stays listed.
 */
export function modelsForRunner(runner: string, selected?: string): string[] {
  const models = rememberedVisibleModels(runner) ?? [...(MODELS_BY_RUNNER[runner] ?? [])];
  return selected && !models.includes(selected) ? [...models, selected] : models;
}

/** A model id restored from a URL or draft: kept as typed, and validated again at launch. */
export function isRestorableModelId(model: unknown): model is string {
  return typeof model === 'string' && /^[A-Za-z0-9][^\s]*$/.test(model);
}

/** Keep a selected model when still valid; otherwise fall back to the runner default. */
export function modelForRunnerChange(
  runner: string,
  currentModel: string,
  options?: { defaultRunner?: string },
): string {
  if (!runner) {
    const fallbackRunner = options?.defaultRunner;
    if (!fallbackRunner) return '';
    const allowed = modelsForRunner(fallbackRunner);
    return currentModel && allowed.includes(currentModel) ? currentModel : '';
  }
  const allowed = modelsForRunner(runner);
  if (currentModel && allowed.includes(currentModel)) return currentModel;
  return DEFAULT_MODEL[runner] ?? allowed[0] ?? '';
}

// Effort: claude/cursor don't use it. Codex and Grok are runner-specific.
// PI `--thinking` is harness-wide (every PI model; some clamp).
export const EFFORT_BY_RUNNER: Record<string, EffortLevel[]> = {
  claude: [],
  codex: [...codexReasoningEfforts()],
  cursor: [],
  grok: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: [...PI_THINKING_LEVELS],
};

/**
 * Efforts the gateway accepts for the runner and model. When the runner's catalog
 * lists reasoning modes for the model, only accepted modes it also lists are offered.
 */
export function effortsForRunner(
  runner: string,
  model: string,
  catalogModes?: readonly string[],
): EffortLevel[] {
  const accepted =
    runner === 'codex' ? [...codexReasoningEfforts(model)] : [...(EFFORT_BY_RUNNER[runner] ?? [])];
  return catalogModes?.length
    ? accepted.filter((effort) => catalogModes.includes(effort))
    : accepted;
}

/** Launch default when effort is omitted (matches gateway resolveRunnerEffort). */
export const DEFAULT_EFFORT: Record<string, EffortLevel> = {
  claude: '',
  codex: DEFAULT_CODEX_EFFORT as EffortLevel,
  cursor: '',
  grok: DEFAULT_GROK_EFFORT as EffortLevel,
  pi: DEFAULT_PI_THINKING,
};

// Comparison/eval candidates share the same runner allowlist. Cursor is
// included because the runner registry launches Cursor Agent in interactive
// artifact-only lanes with post-launch prompt delivery and no PR publication.
export const COMPARISON_LANE_RUNNERS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'cursor',
  'grok',
  'pi',
]);

// Eval replay defaults to Codex first to match the dispatch cockpit's current
// operator path, while still sharing the same allowed comparison-lane registry.
export const EVAL_CANDIDATE_RUNNERS: ReviewRunnerId[] = [
  'codex',
  'claude',
  'cursor',
  'grok',
  'pi',
].filter((runner): runner is ReviewRunnerId => COMPARISON_LANE_RUNNERS.has(runner));

export function runnerLabel(runner: string): string {
  return runner.charAt(0).toUpperCase() + runner.slice(1);
}
