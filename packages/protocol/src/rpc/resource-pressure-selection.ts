import type { ProcessAttributionGroup } from './resources.js';

/** Keep the hottest tree plus managed ownership evidence within a bounded display budget. */
export function selectResourcePressureGroups(
  groups: ProcessAttributionGroup[],
  limit: number,
): ProcessAttributionGroup[] {
  if (limit <= 0) return [];
  const keyFor = (group: ProcessAttributionGroup) =>
    `${group.rootPid}:${group.classification}:${group.slotId ?? ''}:${group.runId ?? ''}:${group.resourceId ?? ''}`;
  const indexByKey = new Map(groups.map((group, index) => [keyFor(group), index]));
  const hottest = groups[0] ? [groups[0]] : [];
  const hottestKeys = new Set(hottest.map(keyFor));
  const managedCandidates = groups.filter(
    (group) =>
      !hottestKeys.has(keyFor(group)) &&
      ['active', 'retained', 'stale'].includes(group.classification),
  );
  const managed = managedCandidates.slice(0, Math.max(0, limit - hottest.length));
  const pinned = [...hottest, ...managed];
  const pinnedKeys = new Set(pinned.map(keyFor));
  return [
    ...groups
      .filter((group) => !pinnedKeys.has(keyFor(group)))
      .slice(0, Math.max(0, limit - pinned.length)),
    ...pinned,
  ].sort((a, b) => (indexByKey.get(keyFor(a)) ?? 0) - (indexByKey.get(keyFor(b)) ?? 0));
}
