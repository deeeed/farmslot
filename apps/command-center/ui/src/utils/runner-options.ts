import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
  type ReviewRunnerId,
} from '@farmslot/protocol';

export type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const RUNNER_OPTIONS: ReviewRunnerId[] = ['claude', 'codex', 'cursor', 'grok'];

export const MODELS_BY_RUNNER: Record<string, string[]> = {
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
  // GPT-5.6 family (Codex CLI slugs) first; keep 5.5/5.4 for continuity.
  codex: [DEFAULT_CODEX_MODEL, 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
  // Cursor Agent IDs from `cursor-agent --list-models`. Default stays Composer;
  // Grok-on-Cursor uses `cursor-grok-4.5-*` slugs (not bare `grok-4.5-fast-xhigh`).
  cursor: [
    DEFAULT_CURSOR_MODEL,
    'composer-2.5-fast',
    'cursor-grok-4.5-high-fast',
    'cursor-grok-4.5-high',
  ],
  grok: [DEFAULT_GROK_MODEL, 'grok-composer-2.5-fast'],
};

export const DEFAULT_MODEL: Record<string, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  codex: DEFAULT_CODEX_MODEL,
  cursor: DEFAULT_CURSOR_MODEL,
  grok: DEFAULT_GROK_MODEL,
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

// Effort: claude/cursor don't use it. Codex and Grok expose runner-specific levels.
export const EFFORT_BY_RUNNER: Record<string, EffortLevel[]> = {
  claude: [],
  codex: ['low', 'medium', 'high', 'xhigh'],
  cursor: [],
  grok: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** Launch default when effort is omitted (matches gateway resolveRunnerEffort). */
export const DEFAULT_EFFORT: Record<string, EffortLevel> = {
  claude: '',
  codex: 'xhigh',
  cursor: '',
  grok: 'xhigh',
};

// Comparison/eval candidates share the same runner allowlist. Cursor is
// included because the runner registry launches Cursor Agent in interactive
// artifact-only lanes with post-launch prompt delivery and no PR publication.
export const COMPARISON_LANE_RUNNERS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'cursor',
  'grok',
]);

// Eval replay defaults to Codex first to match the dispatch cockpit's current
// operator path, while still sharing the same allowed comparison-lane registry.
export const EVAL_CANDIDATE_RUNNERS: ReviewRunnerId[] = [
  'codex',
  'claude',
  'cursor',
  'grok',
].filter((runner): runner is ReviewRunnerId => COMPARISON_LANE_RUNNERS.has(runner));

export function runnerLabel(runner: string): string {
  return runner.charAt(0).toUpperCase() + runner.slice(1);
}
