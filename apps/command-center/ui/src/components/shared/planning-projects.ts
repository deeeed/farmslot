export function syncedDraftProject(input: {
  currentProject: string;
  availableProjects: readonly string[];
  globalProjects: readonly string[];
  fallbackProjects?: readonly string[];
}): string {
  const fallbackProjects = new Set(input.fallbackProjects ?? []);
  const globalProjects = [...new Set(input.globalProjects.map((project) => project.trim()))].filter(
    Boolean,
  );
  if (globalProjects.length === 1) return globalProjects[0]!;

  const current = input.currentProject.trim();
  if (current && !fallbackProjects.has(current)) return current;

  return input.availableProjects[0] ?? '';
}

/**
 * Default `targetProjects` for a new roadmap capture from global project filters.
 *
 * Only a *single* concrete filter pre-fills targets. Multi-project filters set
 * owner `project=global` for coordination but must not auto-fan-out every filtered
 * farm into `targetProjects` — that forced N backlog drafts for framework-only ideas.
 * Multi-target fan-out is operator-explicit.
 */
export function defaultTargetProjectsForGlobalFilters(globalProjects: readonly string[]): string[] {
  const concrete = [...new Set(globalProjects.map((project) => project.trim()).filter(Boolean))];
  return concrete.length === 1 ? [concrete[0]!] : [];
}
