// pr.list entity reads (ADR-071 Amendment 3): `{ versions: true }` and `{ ids }` answer from the
// scope's served list, after starting its collector exactly as the full read does. A versions
// read projects the list again; an ids read serves the rows that listing named.
import type { PREntityPage, PRVersionsResult } from '@farmslot/protocol';

import { resourceRevisions } from '../../resources/revisions.js';
import { servedPRListFor } from '../pr.js';

import { type PRListClientInterest, prListResourceKey } from './list-cache.js';

/** An ids page stops before the row that would take it past this many UTF-8 JSON bytes. */
export const PR_ENTITY_PAGE_MAX_BYTES = 2 * 1024 * 1024;

type ServedDeps = Parameters<typeof servedPRListFor>[3];

/** `pr.list { versions: true }`: stored versions and the list's freshness fields. */
export async function prListVersions(
  project: string | undefined,
  interest: PRListClientInterest = {},
  deps: ServedDeps = {},
): Promise<PRVersionsResult> {
  const list = await servedPRListFor(project, true, interest, deps);
  return {
    versions: [...list.rows].map(([id, row]) => ({ id, version: row.version })),
    ...list.meta,
    membershipRevision: resourceRevisions.membershipRevision(prListResourceKey(project)),
  };
}

/** `pr.list { ids }`: the named PRs that exist, in request order, within the byte cap. */
export async function prListIds(
  project: string | undefined,
  ids: readonly string[],
  interest: PRListClientInterest = {},
  deps: ServedDeps = {},
): Promise<PREntityPage> {
  const list = await servedPRListFor(project, false, interest, deps);
  const page: PREntityPage = { entities: [], versions: [] };
  let bytes = 0;
  for (const id of ids) {
    const row = list.rows.get(id);
    if (!row) continue;
    if (page.entities.length > 0 && bytes + row.bytes > PR_ENTITY_PAGE_MAX_BYTES) break;
    bytes += row.bytes;
    page.entities.push(row.pr);
    page.versions.push({ id, version: row.version });
  }
  return page;
}
