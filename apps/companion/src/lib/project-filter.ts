export const LEGACY_FARMSLOT_PROJECT = 'farmslot';
export const FARMSLOT_FARM_PROJECT = 'farmslot-farm';

const FARMSLOT_PROJECT_IDS = new Set([LEGACY_FARMSLOT_PROJECT, FARMSLOT_FARM_PROJECT]);

export function isFarmslotFamilyProject(project: string): boolean {
  return FARMSLOT_PROJECT_IDS.has(project);
}

export function projectMatchesGlobalFilter(
  runProject: string,
  filterProjects: readonly string[],
): boolean {
  if (filterProjects.length === 0) return true;
  if (filterProjects.includes(runProject)) return true;
  if (!isFarmslotFamilyProject(runProject)) return false;
  return filterProjects.some((candidate) => isFarmslotFamilyProject(candidate));
}

export function normalizeFarmslotProjectFilter(project: string): string {
  return project === LEGACY_FARMSLOT_PROJECT ? FARMSLOT_FARM_PROJECT : project;
}