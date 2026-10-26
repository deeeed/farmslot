import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import type { ReviewDiffSnapshot } from '../contracts/runs.js';
import {
  reviewSnapshotIdentityText,
  verifiedReviewDiffHash,
} from '../runs/review-diff-identity.js';

import {
  type ContentKey,
  type ResourceContentCohort,
  resourceContentId,
  type ResourceContentOrigin,
  type StoredResourceContentInfo,
  type StoredResourceQueryInfo,
} from './store.js';

const mb = 1024 * 1024;
/** Content rule 4 (initial): larger files, binary files and larger diffs load only when opened. */
export const RESOURCE_CONTENT_LIMITS = {
  fileBytes: 1 * mb,
  diffBytes: 5 * mb,
  imageBytes: 2 * mb,
} as const;

/** The git object id of a file: SHA-1 over the loose-object header and the raw bytes. */
export function gitBlobHash(data: Uint8Array): string {
  const header = new TextEncoder().encode(`blob ${data.byteLength}\0`);
  return bytesToHex(sha1.create().update(header).update(data).digest());
}

/** Content rules 1 and 2: bytes are stored only under the identity they hash to. A diff also
 * verifies against a legacy package's raw SHA-256 `diffHash`. */
export function verifyResourceContent(
  key: ContentKey,
  data: Uint8Array,
  untrackedFiles: ReviewDiffSnapshot['untrackedFiles'] = [],
): boolean {
  switch (key.kind) {
    case 'diff':
      return (
        verifiedReviewDiffHash(
          reviewSnapshotIdentityText(new TextDecoder().decode(data), untrackedFiles),
          key.id,
        ) !== undefined
      );
    case 'blob':
      return gitBlobHash(data) === key.id;
    case 'artifact':
      return bytesToHex(sha256(data)) === key.id;
  }
}

function isImage(data: Uint8Array): boolean {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  return (
    starts(0x89, 0x50, 0x4e, 0x47) ||
    starts(0xff, 0xd8, 0xff) ||
    starts(0x47, 0x49, 0x46, 0x38) ||
    (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP')
  );
}

export function resourceContentWithinLimits(key: ContentKey, data: Uint8Array): boolean {
  const limits = RESOURCE_CONTENT_LIMITS;
  if (key.kind === 'diff') return data.byteLength <= limits.diffBytes;
  if (key.kind === 'blob') return data.byteLength <= limits.fileBytes && !data.includes(0);
  return data.byteLength <= (isImage(data) ? limits.imageBytes : limits.fileBytes);
}

export interface ResourceBudgetEvictions {
  queries: string[];
  content: ContentKey[];
}

interface BudgetRow {
  id: string;
  bytes: number;
  accessedAt: number;
  content?: ContentKey;
  prefetch: boolean;
  gate: boolean;
}

/**
 * Content rules 5 and 6: content and opened workspace snapshots share one least recently used
 * budget. Prefetch uses at most half of it, never evicts what the user opened, and run prefetch
 * never evicts gate content. Undefined refuses the incoming entry without evicting anything.
 */
export function resourceBudgetEvictions(
  incoming: { bytes: number; origin: ResourceContentOrigin; cohort?: ResourceContentCohort },
  content: readonly StoredResourceContentInfo[],
  workspace: readonly StoredResourceQueryInfo[],
  budget: number,
): ResourceBudgetEvictions | undefined {
  const prefetch = incoming.origin === 'prefetch';
  const rows: BudgetRow[] = [
    ...content.map((row) => ({
      id: resourceContentId(row),
      bytes: row.bytes,
      accessedAt: row.accessedAt,
      content: { kind: row.kind, id: row.id },
      prefetch: row.origin === 'prefetch',
      gate: row.cohort === 'gate',
    })),
    ...workspace.map((row) => ({
      id: row.id,
      bytes: row.bytes,
      accessedAt: row.accessedAt || row.observedAt,
      prefetch: false,
      gate: false,
    })),
  ].sort((a, b) => a.accessedAt - b.accessedAt || a.id.localeCompare(b.id));
  const evictable = (row: BudgetRow) =>
    !prefetch || (row.prefetch && (incoming.cohort === 'gate' || !row.gate));
  const removed = new Set<BudgetRow>();
  let total = rows.reduce((sum, row) => sum + row.bytes, incoming.bytes);
  let prefetched = rows.reduce(
    (sum, row) => sum + (row.prefetch ? row.bytes : 0),
    prefetch ? incoming.bytes : 0,
  );
  const evict = (fits: () => boolean, eligible: (row: BudgetRow) => boolean) => {
    for (const row of rows) {
      if (fits()) return;
      if (removed.has(row) || !eligible(row)) continue;
      removed.add(row);
      total -= row.bytes;
      if (row.prefetch) prefetched -= row.bytes;
    }
  };
  if (prefetch) evict(() => prefetched <= budget / 2, evictable);
  evict(() => total <= budget, evictable);
  if (total > budget || (prefetch && prefetched > budget / 2)) return undefined;
  const victims = [...removed];
  return {
    queries: victims.filter((row) => !row.content).map((row) => row.id),
    content: victims.flatMap((row) => (row.content ? [row.content] : [])),
  };
}
