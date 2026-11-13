// runs/list-version.ts — run.list rows, version lists and catch-up pages (ADR-071 Amendment 1)
import { createHash } from 'node:crypto';

import {
  type Run,
  type RunListRow,
  runListRow,
  type RunListVersion,
  trimRunForList,
} from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

import { runChangeStamp } from '../resources/run-changes.js';

/** A catch-up page stops before the row that would take it past this many UTF-8 JSON bytes. */
export const RUN_LIST_PAGE_MAX_BYTES = 2 * 1024 * 1024;

interface ListedRun {
  /** The run's resource revision and `updatedAt` when the row was derived. */
  stamp: string;
  version: string;
  /** The row run.list serves. Every request shares this object: readers must not change it. */
  row: RunListRow;
  /** UTF-8 bytes of the row's JSON, which the catch-up page cap counts. */
  bytes: number;
}

/** A run's served row, its size and its version are derived once per change, not once per read. */
const listed = new Map<string, ListedRun>();

/** sha256 of the row's canonical JSON: the same digest as the protocol's `runListVersion`. */
function rowVersion(row: Run): string {
  return createHash('sha256').update(canonicalResourceJson(row)).digest('hex');
}

/** A run's list row, size and version, derived only when the run changed since the last ones. */
function listedRun(run: Run): ListedRun {
  const stamp = runChangeStamp(run);
  const known = listed.get(run.id);
  if (known?.stamp === stamp) return known;
  const row = runListRow(run);
  const derived: ListedRun = {
    stamp,
    version: rowVersion(trimRunForList(run)),
    row,
    bytes: Buffer.byteLength(JSON.stringify(row)),
  };
  listed.set(run.id, derived);
  return derived;
}

/** The version of a run's list row. */
export function runListVersion(run: Run): string {
  return listedRun(run).version;
}

/** The row run.list serves for a run. The object is shared between requests: do not change it. */
export function servedRunListRow(run: Run): RunListRow {
  return listedRun(run).row;
}

/** Drop a run's row and version. The run store calls this when the run leaves the live set. */
export function forgetRunListRow(id: string): void {
  listed.delete(id);
}

/** Whether the memo holds a row for `id`. For tests. */
export function runListRowHeld(id: string): boolean {
  return listed.has(id);
}

/**
 * Derive every live run's row and version after startup, one run per macrotask, so the first
 * read after a restart finds them ready instead of deriving all of them in one turn. A run that
 * left the live store while the warm-up waited is skipped: its row must not come back.
 */
export async function warmRunListVersions(
  liveRuns: () => readonly Run[],
  liveRun: (id: string) => Run | undefined,
): Promise<void> {
  for (const { id } of liveRuns()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const run = liveRun(id);
    if (run) runListVersion(run);
  }
}

/** Every live run's version, in the order the store holds them. */
export function runListVersions(runs: readonly Run[]): RunListVersion[] {
  const versions = runs.map((run) => ({ id: run.id, version: runListVersion(run) }));
  // Rows of deleted or archived runs leave the map once the live set no longer has them.
  if (listed.size > runs.length) {
    const live = new Set(runs.map((run) => run.id));
    for (const id of listed.keys()) if (!live.has(id)) listed.delete(id);
  }
  return versions;
}

/**
 * One catch-up page: rows in the order asked. The page stops before the row that would take
 * it past the byte cap, but its first row is always served, so an oversized row goes alone.
 * Rows, their sizes and their versions come from the same per-change memo as the versions list.
 */
export function runListIdsPage(runs: readonly Run[]): {
  runs: RunListRow[];
  versions: RunListVersion[];
} {
  const page: RunListRow[] = [];
  const pageVersions: RunListVersion[] = [];
  let bytes = 0;
  for (const run of runs) {
    const { row, bytes: rowBytes, version } = listedRun(run);
    bytes += rowBytes;
    if (page.length > 0 && bytes > RUN_LIST_PAGE_MAX_BYTES) break;
    page.push(row);
    pageVersions.push({ id: row.id, version });
  }
  return { runs: page, versions: pageVersions };
}
