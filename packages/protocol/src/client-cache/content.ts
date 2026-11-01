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
  resourceContentId,
  type ResourceContentPlacement,
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

const HASH_SLICE_BYTES = 16 * 1024;

/** Feeds `data` to `hash` one slice per macrotask, so hashing a large file never holds the JS
 * thread for more than a frame. */
async function updateInSlices(hash: { update(chunk: Uint8Array): unknown }, data: Uint8Array) {
  for (let offset = 0; offset < data.byteLength; offset += HASH_SLICE_BYTES) {
    if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    hash.update(data.subarray(offset, offset + HASH_SLICE_BYTES));
  }
}

/** `gitBlobHash` for background work, yielding between slices. */
export async function gitBlobHashInSlices(data: Uint8Array): Promise<string> {
  const hash = sha1.create().update(new TextEncoder().encode(`blob ${data.byteLength}\0`));
  await updateInSlices(hash, data);
  return bytesToHex(hash.digest());
}

/** `verifyResourceContent` for background work: blobs and artifacts hash between slices. */
export async function verifyResourceContentInSlices(
  key: ContentKey,
  data: Uint8Array,
  untrackedFiles: ReviewDiffSnapshot['untrackedFiles'] = [],
): Promise<boolean> {
  if (key.kind === 'blob') return (await gitBlobHashInSlices(data)) === key.id;
  if (key.kind === 'artifact') {
    const hash = sha256.create();
    await updateInSlices(hash, data);
    return bytesToHex(hash.digest()) === key.id;
  }
  return verifyResourceContent(key, data, untrackedFiles);
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

interface BudgetRow extends ResourceContentPlacement {
  id: string;
  bytes: number;
  accessedAt: number;
  content?: ContentKey;
}

/** Content rule 6: prefetch evicts only prefetch rows, and run prefetch never evicts gate rows. */
export function resourceEvictable(
  incoming: ResourceContentPlacement,
  row: ResourceContentPlacement,
): boolean {
  return (
    incoming.origin !== 'prefetch' ||
    (row.origin === 'prefetch' && (incoming.cohort === 'gate' || row.cohort !== 'gate'))
  );
}

/**
 * Content rules 5 and 6: content and workspace snapshots share one least recently used budget.
 * Prefetch uses at most half of it, never evicts what the user opened, and run prefetch never
 * evicts gate rows. Undefined refuses the incoming entry without evicting anything.
 */
export function resourceBudgetEvictions(
  incoming: ResourceContentPlacement & { bytes: number },
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
      origin: row.origin,
      cohort: row.cohort,
    })),
    ...workspace.map((row) => ({
      id: row.id,
      bytes: row.bytes,
      accessedAt: row.accessedAt || row.observedAt,
      origin: row.origin,
      cohort: row.cohort,
    })),
  ].sort((a, b) => a.accessedAt - b.accessedAt || a.id.localeCompare(b.id));
  const evictable = (row: BudgetRow) => resourceEvictable(incoming, row);
  const removed = new Set<BudgetRow>();
  const prefetchBytes = (row: BudgetRow) => (row.origin === 'prefetch' ? row.bytes : 0);
  let total = rows.reduce((sum, row) => sum + row.bytes, incoming.bytes);
  let prefetched = rows.reduce(
    (sum, row) => sum + prefetchBytes(row),
    prefetch ? incoming.bytes : 0,
  );
  const evict = (fits: () => boolean, eligible: (row: BudgetRow) => boolean) => {
    for (const row of rows) {
      if (fits()) return;
      if (removed.has(row) || !eligible(row)) continue;
      removed.add(row);
      total -= row.bytes;
      prefetched -= prefetchBytes(row);
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
