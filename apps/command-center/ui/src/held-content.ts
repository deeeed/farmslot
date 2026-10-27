/**
 * Content this browser holds by identity (ADR-071 Content rules): gate and review diffs by
 * `diffHash` or a frozen-diff alias, files by git blob id, and artifacts by manifest `sha256`.
 * Views read held bytes first, offline and online; what they read live is kept as opened.
 */
import {
  decisionArtifactBundleRef,
  type GitBranchDiffFile,
  type ReviewDiffSnapshot,
  type Run,
  type RunDecisionPayload,
} from '@farmslot/protocol';
import {
  type ContentKey,
  type ContentPrefetchArtifact,
  gitBlobHash,
  parseUnifiedDiff as parseDiffFiles,
  type ResourceContentCohort,
  verifyResourceContent,
} from '@farmslot/protocol/client-cache';

import { parseUnifiedDiff } from './utils/unified-diff.js';
import { getResourceCache } from './resource-cache.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FULL_BLOB_ID = /^[0-9a-f]{40}$/;

/** The alias a prefetched frozen review diff is stored under. */
export function frozenDiffAlias(runId: string, baseSha: string, headSha: string): string {
  return `frozen-diff:${runId}:${baseSha}:${headSha}`;
}

/**
 * A decision's retained diff as an artifact read, pinned to the bundle its payload records.
 * Older payloads record none and read the run's current artifact.
 */
export function decisionDiffArtifact(
  runId: string,
  path: string,
  payload: RunDecisionPayload | undefined,
  run: Pick<Run, 'output'> = {},
): ContentPrefetchArtifact {
  const bundleDigest = decisionArtifactBundleRef(run, payload)?.bundleDigest;
  return { runId, path, ...(bundleDigest ? { bundleDigest } : {}) };
}

/** The owner content reads belong to: its cache, which a principal or profile change replaces. */
export function contentOwner(): object | undefined {
  return getResourceCache();
}

/** Held bytes the user opened: refreshes recency and protects them from prefetch eviction. */
export async function openHeldContent(key: ContentKey | string): Promise<Uint8Array | undefined> {
  const cache = getResourceCache();
  if (!cache) return undefined;
  const opened = typeof key === 'string' ? cache.openContentByAlias(key) : cache.openContent(key);
  return opened.catch(() => undefined);
}

export async function openHeldText(key: ContentKey | string): Promise<string | undefined> {
  const data = await openHeldContent(key);
  return data && decoder.decode(data);
}

/**
 * Keeps what the user opened live, as opened content. The write token is taken before the
 * read, so a reply from a former connection or owner is never stored.
 */
export function openedContentKeeper(cohort: ResourceContentCohort) {
  const cache = getResourceCache();
  const token = cache?.contentWriteToken();
  return (
    key: ContentKey,
    data: Uint8Array | string,
    untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'],
  ): void => {
    if (!cache) return;
    void cache
      .storeContent({
        key,
        data: typeof data === 'string' ? encoder.encode(data) : data,
        origin: 'opened',
        cohort,
        token,
        ...(untrackedFiles?.length ? { untrackedFiles } : {}),
      })
      .catch(() => false);
  };
}

/** Live bytes that do not hash to the identity they were read for: never shown or kept. */
export const CONTENT_MISMATCH = Symbol('content mismatch');
/** Identity-bearing text to show, a mismatch, or nothing (not held, or the read failed). */
export type VerifiedText = string | typeof CONTENT_MISMATCH | undefined;

/**
 * Content rules 1 and 2 for a live read: bytes are shown and kept only when they hash to the
 * identity they were read for, at any size. The caps decide only whether they are kept.
 */
export async function readVerifiedContent(
  key: ContentKey,
  read: () => Promise<Uint8Array>,
  cohort: ResourceContentCohort,
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'],
): Promise<Uint8Array | typeof CONTENT_MISMATCH> {
  const keep = openedContentKeeper(cohort);
  const data = await read();
  if (!verifyResourceContent(key, data, untrackedFiles)) return CONTENT_MISMATCH;
  keep(key, data, untrackedFiles);
  return data;
}

/** A diff read live: its verified text, a mismatch, or nothing when the read fails. */
export async function readVerifiedText(
  key: ContentKey,
  read: () => Promise<Uint8Array>,
  cohort: ResourceContentCohort,
  untrackedFiles?: ReviewDiffSnapshot['untrackedFiles'],
): Promise<VerifiedText> {
  try {
    const data = await readVerifiedContent(key, read, cohort, untrackedFiles);
    return data === CONTENT_MISMATCH ? data : decoder.decode(data);
  } catch {
    return undefined;
  }
}

/** A file read as text is kept by the git blob hash of its bytes. */
export function blobKey(content: string): ContentKey {
  return { kind: 'blob', id: gitBlobHash(encoder.encode(content)) };
}

/** The changed files of a held diff, listed like a branch diff. */
export function heldDiffFiles(text: string): GitBranchDiffFile[] {
  return parseDiffFiles(text).flatMap((file): GitBranchDiffFile[] => {
    const path = file.newPath ?? file.oldPath;
    if (!path) return [];
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    const renamed = Boolean(file.oldPath && file.newPath && file.oldPath !== file.newPath);
    return [
      {
        path,
        status: !file.oldPath ? 'A' : !file.newPath ? 'D' : renamed ? 'R' : 'M',
        ...(renamed ? { oldPath: file.oldPath } : {}),
        additions: lines.filter((line) => line.op === '+').length,
        deletions: lines.filter((line) => line.op === '-').length,
      },
    ];
  });
}

/** One file's section of a held diff. */
export function heldFileDiff(text: string, path: string): string | undefined {
  return parseUnifiedDiff(text).find((file) => file.path === path)?.diff;
}

/** The full blob id of a file side the held diff names; abbreviated ids cannot be looked up. */
export function heldBlobId(text: string, path: string, side: 'base' | 'head'): string | undefined {
  const file = parseDiffFiles(text).find(
    (entry) => (side === 'head' ? entry.newPath : entry.oldPath) === path,
  );
  const id = side === 'head' ? file?.newId : file?.oldId;
  return id && FULL_BLOB_ID.test(id) ? id : undefined;
}
