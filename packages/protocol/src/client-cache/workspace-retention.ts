import {
  RESOURCE_QUERY_DEFINITIONS,
  type ResourceQuery,
  type ResourceQueryDefinition,
  type ResourceReadMethod,
} from './registry.js';
import type { StoredResourceQueryInfo } from './store.js';

/** Reconstruct only registered identities; malformed/foreign rows do not gain workspace membership. */
export function workspaceRetentionMembership(id: string): readonly string[] | undefined {
  const colon = id.indexOf(':');
  try {
    const definition: ResourceQueryDefinition | undefined =
      RESOURCE_QUERY_DEFINITIONS[id.slice(0, colon) as ResourceReadMethod];
    if (definition?.retention?.cohort !== 'workspace') return undefined;
    const params = JSON.parse(id.slice(colon + 1));
    return definition.retentionGroups?.(
      definition.normalizeParams ? definition.normalizeParams(params) : params,
    );
  } catch {
    return undefined;
  } // Older or removed query definitions are outside this cohort.
}
export function workspaceRetentionEvictions(
  query: ResourceQuery,
  saved: StoredResourceQueryInfo,
  stored: StoredResourceQueryInfo[],
  budget = query.retention?.maxBytes ?? 0,
  contentBytes = 0,
): string[] {
  const retention = query.retention;
  if (retention?.cohort !== 'workspace') return [];
  if (saved.bytes + contentBytes > budget) return [saved.id];
  const rows = [...stored.filter((row) => row.id !== saved.id), saved]
    .filter((row) => workspaceRetentionMembership(row.id) !== undefined)
    .sort(
      (a, b) =>
        (a.accessedAt || a.observedAt) - (b.accessedAt || b.observedAt) || a.id.localeCompare(b.id),
    );
  const removed = new Set<string>();
  // One byte budget across every workspace family in this authenticated portable store.
  let total = rows.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows) {
    if (total + contentBytes <= budget) break;
    if (row.id === saved.id) continue;
    removed.add(row.id);
    total -= row.bytes;
  }
  for (const group of retention.groups ?? []) {
    const members = rows.filter(
      (row) => !removed.has(row.id) && workspaceRetentionMembership(row.id)?.includes(group),
    );
    let excess = members.length - retention.maxEntries;
    for (const row of members) {
      if (excess <= 0) break;
      if (row.id === saved.id) continue;
      removed.add(row.id);
      excess--;
    }
  }
  return [...removed];
}
