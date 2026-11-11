// runs/list-version.ts — run.list version lists and catch-up pages (ADR-071 Amendment 1)
import { createHash } from 'node:crypto';

import { type Run, type RunListVersion, trimRunForList } from '@farmslot/protocol';
import { canonicalResourceJson } from '@farmslot/protocol/client-cache';

import { resourceRevisions } from '../resources/revisions.js';

/** A catch-up page stops before the row that would take it past this many UTF-8 JSON bytes. */
export const RUN_LIST_PAGE_MAX_BYTES = 2 * 1024 * 1024;

interface RowVersion {
  /** The run's resource revision and `updatedAt` when the version was taken. */
  stamp: string;
  version: string;
}

/**
 * A row's version is derived once per change, not once per read. Every run writer advances the
 * run's resource revision after the facts are readable (resources/run-changes.ts); the few
 * in-place writers that skip it stamp `updatedAt`. Either one changes the stamp.
 */
const versions = new Map<string, RowVersion>();

const stampOf = (run: Run) =>
  `${resourceRevisions.revision({ family: 'run', runId: run.id })}|${run.updatedAt}`;

/** sha256 of the row's canonical JSON: the same digest as the protocol's `runListVersion`. */
function rowVersion(row: Run): string {
  return createHash('sha256').update(canonicalResourceJson(row)).digest('hex');
}

/** The version of a live run's list row, derived only when the run changed since the last one. */
export function runListVersion(run: Run): string {
  const stamp = stampOf(run);
  const known = versions.get(run.id);
  if (known?.stamp === stamp) return known.version;
  const version = rowVersion(trimRunForList(run));
  versions.set(run.id, { stamp, version });
  return version;
}

/**
 * Derive every live run's version after startup, one run per macrotask, so the first versions
 * read after a restart finds them ready instead of deriving all of them in one turn.
 */
export async function warmRunListVersions(liveRuns: () => readonly Run[]): Promise<void> {
  for (const run of liveRuns()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    runListVersion(run);
  }
}

/** Every live run's version, in the order the store holds them. */
export function runListVersions(runs: readonly Run[]): RunListVersion[] {
  const listed = runs.map((run) => ({ id: run.id, version: runListVersion(run) }));
  // Rows of deleted or archived runs leave the map once the live set no longer has them.
  if (versions.size > runs.length) {
    const live = new Set(runs.map((run) => run.id));
    for (const id of versions.keys()) if (!live.has(id)) versions.delete(id);
  }
  return listed;
}

/**
 * One catch-up page: rows in the order asked. The page stops before the row that would take
 * it past the byte cap, but its first row is always served, so an oversized row goes alone.
 * Rows are versioned through the same per-change memo as the versions list.
 */
export function runListIdsPage(runs: readonly Run[]): {
  runs: Run[];
  versions: RunListVersion[];
} {
  const page: Run[] = [];
  const pageVersions: RunListVersion[] = [];
  let bytes = 0;
  for (const run of runs) {
    const row = trimRunForList(run);
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (page.length > 0 && bytes > RUN_LIST_PAGE_MAX_BYTES) break;
    page.push(row);
    pageVersions.push({ id: row.id, version: runListVersion(run) });
  }
  return { runs: page, versions: pageVersions };
}
