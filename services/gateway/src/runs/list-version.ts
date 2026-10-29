// runs/list-version.ts — run.list version lists and catch-up pages (ADR-071 Amendment 1)
import { createHash } from 'node:crypto';

import type { Run, RunListVersion } from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

import { trimRunForList } from './list-trim.js';

/** A catch-up page stops before the row that would take it past this many UTF-8 JSON bytes. */
export const RUN_LIST_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The version of a row as served: no gateway state, so an unchanged row keeps it across
 * restarts. `row` is the trimmed list row, the same object the reply carries.
 */
export function runListVersion(row: Run): string {
  return createHash('sha256').update(canonicalResourceJson(row)).digest('hex');
}

/** Every live run's version, in the order the store holds them. */
export function runListVersions(runs: readonly Run[]): RunListVersion[] {
  return runs.map((run) => ({ id: run.id, version: runListVersion(trimRunForList(run)) }));
}

/**
 * One catch-up page: rows in the order asked. The page stops before the row that would take
 * it past the byte cap, but its first row is always served, so an oversized row goes alone.
 */
export function runListIdsPage(runs: readonly Run[]): {
  runs: Run[];
  versions: RunListVersion[];
} {
  const page: Run[] = [];
  const versions: RunListVersion[] = [];
  let bytes = 0;
  for (const run of runs) {
    const row = trimRunForList(run);
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (page.length > 0 && bytes > RUN_LIST_PAGE_MAX_BYTES) break;
    page.push(row);
    versions.push({ id: row.id, version: runListVersion(row) });
  }
  return { runs: page, versions };
}
