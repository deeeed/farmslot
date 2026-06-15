import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_MODEL,
  type ReviewRunnerId,
} from '@farmslot/protocol';

export type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const RUNNER_OPTIONS: ReviewRunnerId[] = ['claude', 'codex', 'cursor', 'grok'];

export const MODELS_BY_RUNNER: Record<string, string[]> = {
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
  codex: ['gpt-5.5', 'gpt-5.4'],
  cursor: [DEFAULT_CURSOR_MODEL],
  grok: [DEFAULT_GROK_MODEL, 'grok-composer-2.5-fast'],
};

export const DEFAULT_MODEL: Record<string, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  codex: 'gpt-5.5',
  cursor: DEFAULT_CURSOR_MODEL,
  grok: DEFAULT_GROK_MODEL,
};

// Effort: claude/cursor don't use it. Codex and Grok expose runner-specific levels.
export const EFFORT_BY_RUNNER: Record<string, EffortLevel[]> = {
  claude: [],
  codex: ['low', 'medium', 'high', 'xhigh'],
  cursor: [],
  grok: ['low', 'medium', 'high', 'xhigh', 'max'],
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
