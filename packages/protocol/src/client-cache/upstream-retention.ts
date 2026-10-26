import {
  RESOURCE_QUERY_DEFINITIONS,
  type ResourceQueryDefinition,
  type ResourceReadMethod,
  UPSTREAM_QUERY_MAX_BYTES,
} from './registry.js';
import type { StoredResourceQueryInfo } from './store.js';

/** Stored IDs carry registered methods; persisted rows cannot declare their own retention group. */
export function isUpstreamStoredQuery(id: string): boolean {
  const method = id.slice(0, id.indexOf(':'));
  if (!Object.hasOwn(RESOURCE_QUERY_DEFINITIONS, method)) return false;
  const definition: ResourceQueryDefinition =
    RESOURCE_QUERY_DEFINITIONS[method as ResourceReadMethod];
  return definition.retention?.cohort === 'upstream';
}

/** Apply the same family byte bound before cold hydration as after a live read. */
export function upstreamRetentionEvictions(rows: readonly StoredResourceQueryInfo[]): string[] {
  const members = rows
    .filter((row) => isUpstreamStoredQuery(row.id))
    .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
  const evicted = members
    .filter((row) => row.bytes > UPSTREAM_QUERY_MAX_BYTES)
    .map((row) => row.id);
  const retained = members.filter((row) => row.bytes <= UPSTREAM_QUERY_MAX_BYTES);
  let total = retained.reduce((sum, row) => sum + row.bytes, 0);
  for (const oldest of retained) {
    if (total <= UPSTREAM_QUERY_MAX_BYTES) break;
    evicted.push(oldest.id);
    total -= oldest.bytes;
  }
  return evicted;
}
