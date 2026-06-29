export const RUNNER_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  opencode: '#f59e0b',
  cursor: '#8b5cf6',
  grok: '#14b8a6',
  scripted: '#a78bfa',
};

export function runnerColor(runner: string | null | undefined): string | null {
  if (!runner) return null;
  return RUNNER_COLORS[runner] ?? null;
}
