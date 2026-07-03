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
