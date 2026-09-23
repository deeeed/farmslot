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
} from '@farmslot/protocol';

export type EffortLevel = '' | CodexReasoningEffort | PiThinkingLevel;

export const RUNNER_OPTIONS: ReviewRunnerId[] = ['claude', 'codex', 'cursor', 'grok', 'pi'];

// Pi's Anthropic OAuth provider uses Anthropic model IDs. Keep the provider
// prefix so launch-command.ts cannot mistake them for xAI's bare model IDs.
export const PI_ANTHROPIC_MODELS = [
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-fable-5-1',
] as const;

export const MODELS_BY_RUNNER: Record<string, string[]> = {
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
  // Astra first; retain earlier Codex models for explicit selections.
  codex: [
    DEFAULT_CODEX_MODEL,
    'gpt-6-sol',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
  ],
  // Cursor Agent IDs from `cursor-agent --list-models`. The first entry is the
  // shared protocol default used by every client.
  cursor: [
    DEFAULT_CURSOR_MODEL,
    'composer-2.5',
    'composer-2.5-fast',
    'cursor-grok-4.6-high',
    'cursor-grok-4.6-xhigh',
    'grok-4.7-high',
    'grok-4.7-xhigh',
    'gpt-5.6-sol-medium',
    'gpt-5.6-sol-high',
    'gpt-5.6-sol-max',
  ],
  grok: [DEFAULT_GROK_MODEL, 'grok-4.7'],
  pi: [DEFAULT_PI_MODEL, ...PI_ANTHROPIC_MODELS],
};

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

/** Canonical selectable models for a runner. Never mixes models across runners. */
export function modelsForRunner(runner: string): string[] {
  return [...(MODELS_BY_RUNNER[runner] ?? [])];
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

/** Select efforts supported by the runner and the selected model. */
export function effortsForRunner(runner: string, model: string): EffortLevel[] {
  return runner === 'codex'
    ? [...codexReasoningEfforts(model)]
    : [...(EFFORT_BY_RUNNER[runner] ?? [])];
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
