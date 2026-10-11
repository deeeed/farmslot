import type { ReviewRunnerId } from '@farmslot/protocol';

export type EffortLevel = string;
export const RUNNER_OPTIONS: ReviewRunnerId[] = ['claude', 'codex', 'cursor', 'grok', 'pi'];

export function isRestorableModelId(model: unknown): model is string {
  return typeof model === 'string' && /^[A-Za-z0-9][^\s]*$/.test(model);
}

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
