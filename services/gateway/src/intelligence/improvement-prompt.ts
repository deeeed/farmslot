/**
 * The improvement engine's system prompt: its rules, then the learning, its project
 * and the run whose own record verifies the learning (ADR-026 Amendment 1).
 */
export function improvementSystemPrompt(
  rules: string,
  learning: string,
  project: string,
  runId: string,
): string {
  return `${rules}\n\n## Current Learning\n${learning}\n\n## Project\n${project}\n\n## Run\n${runId}: verify the learning against this run's evidence with read_task_file (run_id "${runId}", file artifacts/report.md, its review feedback or trace) before proposing.`;
}
