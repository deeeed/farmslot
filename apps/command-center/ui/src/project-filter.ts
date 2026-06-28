import type { GlobalFilters } from './state.js';

/** Legacy first-party project id before `{name}-farm` rename. */
export const LEGACY_FARMSLOT_PROJECT = 'farmslot';

/** Canonical first-party pool project id. */
export const FARMSLOT_FARM_PROJECT = 'farmslot-farm';

const FARMSLOT_PROJECT_IDS = new Set([LEGACY_FARMSLOT_PROJECT, FARMSLOT_FARM_PROJECT]);

export function isFarmslotFamilyProject(project: string): boolean {
  return FARMSLOT_PROJECT_IDS.has(project);
}

/** Match a run/slot project against global filter chips, including farmslot rename aliases. */
export function projectMatchesGlobalFilter(runProject: string, filterProjects: readonly string[]): boolean {
  if (filterProjects.length === 0) return true;
  if (filterProjects.includes(runProject)) return true;
  if (!isFarmslotFamilyProject(runProject)) return false;
  return filterProjects.some((candidate) => isFarmslotFamilyProject(candidate));
}

/** Normalize persisted filters after the farmslot → farmslot-farm rename. */
export function normalizeGlobalFilters(filters: GlobalFilters): GlobalFilters {
  const projects = filters.projects.map((project) =>
    project === LEGACY_FARMSLOT_PROJECT ? FARMSLOT_FARM_PROJECT : project,
  );
  const deduped = [...new Set(projects)];
  if (
    deduped.length === filters.projects.length &&
    deduped.every((project, index) => project === filters.projects[index])
  ) {
    return filters;
  }
  return { projects: deduped, machines: filters.machines };
}