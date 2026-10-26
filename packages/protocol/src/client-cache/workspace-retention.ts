import { type ResourceBudgetEvictions, resourceBudgetEvictions } from './content.js';
import {
  RESOURCE_QUERY_DEFINITIONS,
  type ResourceQuery,
  type ResourceQueryDefinition,
  type ResourceReadMethod,
} from './registry.js';
import type { StoredResourceContentInfo, StoredResourceQueryInfo } from './store.js';

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
  content: readonly StoredResourceContentInfo[] = [],
): ResourceBudgetEvictions | undefined {
  const retention = query.retention;
  if (retention?.cohort !== 'workspace') return { queries: [], content: [] };
  const rows = [...stored.filter((row) => row.id !== saved.id), saved]
    .filter((row) => workspaceRetentionMembership(row.id) !== undefined)
    .sort(
      (a, b) =>
        (a.accessedAt || a.observedAt) - (b.accessedAt || b.observedAt) || a.id.localeCompare(b.id),
    );
  // One byte budget across content and every workspace family in this authenticated portable store.
  const budgeted = resourceBudgetEvictions(
    { bytes: saved.bytes, origin: 'opened' },
    content,
    rows.filter((row) => row.id !== saved.id),
    budget,
  );
  if (!budgeted) return undefined;
  const removed = new Set(budgeted.queries);
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
  return { queries: [...removed], content: budgeted.content };
}
