// runs/list-version.ts — run.list version lists and catch-up pages (ADR-071 Amendment 1)
import { type Run, type RunListVersion, runListVersion, trimRunForList } from '@farmslot/protocol';

export { runListVersion };

/** A catch-up page stops before the row that would take it past this many UTF-8 JSON bytes. */
export const RUN_LIST_PAGE_MAX_BYTES = 2 * 1024 * 1024;

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
