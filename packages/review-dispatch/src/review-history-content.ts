import {
  type FsReadResult,
  type GitDiffResult,
  Methods,
  reviewDiffHash,
  type Run,
} from '@farmslot/protocol';
import {
  type ContentKey,
  type ContentPrefetchOptions,
  type ContentPrefetchWrite,
  createSha256,
  type GatewayResourceCache,
} from '@farmslot/protocol/client-cache';

import {
  loadReviewHistoryArtifacts,
  type ReviewHistoryArtifact,
  reviewHistoryArtifactPaths,
  type ReviewHistoryArtifacts,
  reviewHistoryIdentity,
  reviewHistoryView,
} from './review-history.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function digest(data: Uint8Array): string {
  const hash = createSha256();
  hash.update(data);
  return hash.hex();
}
function alias(run: Run): string {
  return `review-history:${digest(encoder.encode(reviewHistoryIdentity(run)))}`;
}
type ContentReader = Pick<
  GatewayResourceCache,
  'readContentByAlias' | 'openContentByAlias' | 'peekContentByAlias'
>;
interface HistoryContentEntry {
  path: string;
  kind: 'artifact' | 'diff' | 'absent';
  deferred?: true;
}
function isEntry(value: unknown): value is HistoryContentEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'kind' in value &&
    ['artifact', 'diff', 'absent'].includes(String(value.kind)) &&
    (!('deferred' in value) || value.deferred === true),
  );
}
function manifest(data: Uint8Array | undefined): HistoryContentEntry[] | undefined {
  if (!data) return undefined;
  const value: unknown = JSON.parse(decoder.decode(data));
  return Array.isArray(value) && value.every(isEntry) ? value : undefined;
}
function entryAlias(root: string, path: string): string {
  return `${root}:${digest(encoder.encode(path))}`;
}

/** First paint needs the round metadata; large diff bodies are read from the store on open. */
export function peekReviewHistoryContent(
  cache: ContentReader,
  run: Run,
): ReviewHistoryArtifacts | undefined {
  const root = alias(run);
  const entries = manifest(cache.peekContentByAlias?.(root));
  if (!entries) return undefined;
  const result: Record<string, ReviewHistoryArtifact> = {};
  for (const entry of entries) {
    if (entry.kind === 'absent') {
      result[entry.path] = { notCaptured: true };
      continue;
    }
    const data = cache.peekContentByAlias?.(entryAlias(root, entry.path));
    if (data) result[entry.path] = { content: decoder.decode(data) };
    else if (entry.kind !== 'diff') return undefined;
  }
  return result;
}

/** Hydrates the bounded working set during prefetch; opening protects these same store rows. */
export async function readReviewHistoryContent(
  cache: ContentReader,
  run: Run,
  opened = false,
): Promise<ReviewHistoryArtifacts | undefined> {
  const root = alias(run);
  const read = (name: string) =>
    opened ? cache.openContentByAlias(name) : cache.readContentByAlias(name);
  const entries = manifest(await read(root));
  if (!entries) return undefined;
  const result: Record<string, ReviewHistoryArtifact> = {};
  // Diff bodies are hydrated first so the bounded resident set keeps metadata for first paint.
  for (const entry of [...entries].sort(
    (a, b) => Number(b.kind === 'diff') - Number(a.kind === 'diff'),
  )) {
    if (entry.kind === 'absent') {
      result[entry.path] = { notCaptured: true };
      continue;
    }
    if (entry.deferred) return undefined;
    const data = await read(entryAlias(root, entry.path));
    if (!data) return undefined;
    result[entry.path] = { content: decoder.decode(data) };
  }
  await read(root);
  return result;
}

function hasHistory(run: Run): boolean {
  return Boolean(
    reviewHistoryArtifactPaths(run).length ||
    run.reviewResult ||
    run.steps?.some((step) => step.name.includes('review')) ||
    run.engineState?.publishGate?.reviews?.length ||
    run.decisions.some(
      (decision) => decision.payload?.kind === 'ready' && decision.payload.reviews?.length,
    ),
  );
}
type ReviewPrefetchOptions = Pick<ContentPrefetchOptions, 'request' | 'readArtifact'> & {
  cache: Pick<
    GatewayResourceCache,
    'storeContent' | 'readContentByAlias' | 'openContentByAlias' | 'peekContentByAlias'
  >;
};

/** Both clients attach the same domain loader to the existing two-run prefetch queue. */
export function createReviewHistoryPrefetch(
  options: ReviewPrefetchOptions,
): NonNullable<ContentPrefetchOptions['reviewHistory']> {
  const { cache } = options;
  return {
    identity: (run) => (hasHistory(run) ? reviewHistoryIdentity(run) : ''),
    async prefetch(run: Run, write: ContentPrefetchWrite) {
      if (!hasHistory(run)) return;
      const held = await readReviewHistoryContent(cache, run);
      let refusal: unknown;
      const read = async <T>(method: string, params: unknown): Promise<T> => {
        try {
          return await options.request<T>(method, params, write.signal);
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            ['AUTH_REQUIRED', 'AUTH_FORBIDDEN'].includes(String(Reflect.get(error, 'code')))
          )
            refusal = error;
          throw error;
        }
      };
      const artifacts =
        held ??
        (await loadReviewHistoryArtifacts(
          run,
          async (path) => {
            try {
              return decoder.decode(
                await options.readArtifact(
                  { runId: run.id, path, bundleDigest: run.artifactBundle?.bundleDigest },
                  write.signal,
                ),
              );
            } catch (error) {
              const code =
                error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
              if (code === 'ARTIFACT_NOT_CAPTURED') return null;
              if (code === 'AUTH_REQUIRED' || code === 'AUTH_FORBIDDEN') refusal = error;
              throw error;
            }
          },
          async (params) => (await read<FsReadResult>(Methods.FS_READ, params)).content,
          async (params) => (await read<GitDiffResult>(Methods.GIT_DIFF, params)).diff,
        ));
      if (refusal) throw refusal;
      if (write.signal.aborted) return;
      const root = alias(run);
      const store = (name: string, data: Uint8Array, kind: ContentKey['kind']) =>
        cache.storeContent({
          key: { kind, id: kind === 'diff' ? reviewDiffHash(decoder.decode(data)) : digest(data) },
          data,
          alias: name,
          origin: 'prefetch',
          cohort: write.cohort,
          token: write.token,
        });
      const diffPaths = new Set(
        reviewHistoryView(run, artifacts).checks.flatMap((check) =>
          check.rounds.flatMap((round) => [round.diffPath, round.fixDiffPath]),
        ),
      );
      const entries: HistoryContentEntry[] = [];
      const ordered = Object.entries(artifacts).sort(
        ([a], [b]) => Number(diffPaths.has(b)) - Number(diffPaths.has(a)),
      );
      for (const [path, value] of ordered) {
        if (write.signal.aborted) return;
        if (value.error) continue;
        if (value.content === undefined) {
          entries.push({ path, kind: 'absent' });
          continue;
        }
        const kind = diffPaths.has(path) ? 'diff' : 'artifact';
        const stored = await store(entryAlias(root, path), encoder.encode(value.content), kind);
        entries.push({ path, kind, ...(stored ? {} : { deferred: true }) });
      }
      const failed = Object.values(artifacts).find((value) => value.error);
      if (failed) throw new Error(failed.error);
      await store(root, encoder.encode(JSON.stringify(entries)), 'artifact');
    },
  };
}
