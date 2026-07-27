export function concretePlanningProjects(projects: readonly string[]): string[] {
  return [
    ...new Set(
      projects
        .map((project) => project.trim())
        .filter((project) => project && project !== 'global' && project !== 'unassigned'),
    ),
  ];
}

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
 * Keep draft `targetProjects` aligned with global project filters.
 *
 * Only a *single* concrete filter pre-fills targets. Multi-project filters set
 * owner `project=global` for coordination but must not auto-fan-out every filtered
 * farm into `targetProjects` — that forced N backlog drafts for framework-only ideas.
 * Multi-target fan-out is operator-explicit. Clearing all global filters preserves
 * targets the operator selected in the capture form.
 */
export function syncedDraftTargetProjects(input: {
  currentTargets: readonly string[];
  globalProjects: readonly string[];
  preserveCurrentTargets: boolean;
}): string[] {
  const globalProjects = concretePlanningProjects(input.globalProjects);
  if (input.preserveCurrentTargets || globalProjects.length === 0) {
    return [...input.currentTargets];
  }
  return globalProjects.length === 1 ? [globalProjects[0]!] : [];
}
