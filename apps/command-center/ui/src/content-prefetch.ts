import {
  HUMAN_GATE_DECISION_TYPE,
  openHumanGateDecision,
  type PendingDecision,
  type RunListRow,
  withArtifactBundleDigest,
} from '@farmslot/protocol';
import {
  type ContentPrefetchArtifact,
  type ContentPrefetcher,
  type ContentPrefetchOptions,
  type ContentPrefetchTarget,
  createContentPrefetcher,
  type GatewayResourceCache,
} from '@farmslot/protocol/client-cache';
import { createReviewHistoryPrefetch } from '@farmslot/review-dispatch';

import { gatewayHttpFetch } from './utils/gateway-origin.js';

function decisionRunId(decision: Pick<PendingDecision, 'context' | 'runMeta'>): string | undefined {
  const fromContext = decision.context?.runId;
  return decision.runMeta?.runId ?? (typeof fromContext === 'string' ? fromContext : undefined);
}

/** Prefetch rule 1's inputs: pending gates, then active runs, each with its last update. */
export function contentPrefetchTargets(
  decisions: readonly Pick<
    PendingDecision,
    'type' | 'payload' | 'context' | 'runMeta' | 'createdAt'
  >[],
  activeRuns: readonly Pick<RunListRow, 'id' | 'updatedAt' | 'decisions'>[],
): ContentPrefetchTarget[] {
  const runs = new Map(activeRuns.map((run) => [run.id, run]));
  const targets = new Map<string, ContentPrefetchTarget>();
  for (const decision of decisions) {
    const runId = decisionRunId(decision);
    if (!runId || decision.type !== HUMAN_GATE_DECISION_TYPE || decision.payload?.kind !== 'ready')
      continue;
    targets.set(runId, {
      runId,
      gate: true,
      updatedAt: runs.get(runId)?.updatedAt ?? decision.createdAt,
    });
  }
  for (const run of runs.values())
    if (!targets.has(run.id))
      targets.set(run.id, {
        runId: run.id,
        gate: openHumanGateDecision(run)?.payload?.kind === 'ready',
        updatedAt: run.updatedAt,
      });
  return [...targets.values()];
}

/**
 * Raw bytes of a retained run artifact. A refusal rejects with `AUTH_FORBIDDEN`, and an ended
 * person session with `AUTH_REQUIRED`.
 */
export async function fetchRunArtifactBytes(
  { runId, path, bundleDigest }: ContentPrefetchArtifact,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const params = new URLSearchParams({ runId, path });
  const response = await gatewayHttpFetch(
    withArtifactBundleDigest(`/api/run-artifact?${params}`, bundleDigest),
    { signal },
  ).catch((error: unknown) => {
    // An ended person session refuses every later read too, so prefetch stops on it.
    if (error instanceof Error && Reflect.get(error, 'code') === 'AUTH_SESSION_ENDED')
      throw Object.assign(new Error(error.message), { code: 'AUTH_REQUIRED' });
    throw error;
  });
  if (response.status === 401 || response.status === 403)
    throw Object.assign(new Error(`Run artifact refused (${response.status})`), {
      code: 'AUTH_FORBIDDEN',
    });
  if (response.status === 404)
    throw Object.assign(new Error('Artifact not captured yet'), { code: 'ARTIFACT_NOT_CAPTURED' });
  if (!response.ok) throw new Error(`Run artifact unavailable (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

type ReviewHistoryPrefetchListener = (cache: GatewayResourceCache, identity: string) => void;
const reviewHistoryListeners = new Map<string, Set<ReviewHistoryPrefetchListener>>();

export function onReviewHistoryPrefetched(runId: string, listener: ReviewHistoryPrefetchListener) {
  const listeners = reviewHistoryListeners.get(runId) ?? new Set<ReviewHistoryPrefetchListener>();
  reviewHistoryListeners.set(runId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) reviewHistoryListeners.delete(runId);
  };
}

export interface OwnerContentPrefetch {
  /** Keeps one prefetcher for the owned cache while it writes to a persistent store. */
  sync(cache: GatewayResourceCache | undefined, persistent: boolean): void;
  setTargets(targets: readonly ContentPrefetchTarget[]): void;
}

/**
 * Only the tab that owns persistent storage prefetches: a memory store would lose the bytes with
 * the tab. The prefetcher is disposed with the cache it fills.
 */
export function createOwnerContentPrefetch(
  options: Omit<ContentPrefetchOptions, 'cache'>,
): OwnerContentPrefetch {
  let current: { cache: GatewayResourceCache; prefetcher: ContentPrefetcher } | undefined;
  let targets: readonly ContentPrefetchTarget[] = [];
  return {
    sync(cache, persistent) {
      const next = persistent ? cache : undefined;
      if (current?.cache === next) return;
      current?.prefetcher.dispose();
      current = undefined;
      if (!next) return;
      const history = createReviewHistoryPrefetch({ ...options, cache: next });
      const prefetcher = createContentPrefetcher({
        ...options,
        cache: next,
        reviewHistory: {
          ...history,
          async prefetch(run, write) {
            await history.prefetch(run, write);
            if (write.signal.aborted || current?.cache !== next) return;
            const listeners = reviewHistoryListeners.get(run.id);
            if (!listeners?.size) return;
            const identity = history.identity(run);
            for (const listener of listeners) listener(next, identity);
          },
        },
      });
      current = { cache: next, prefetcher };
      prefetcher.setTargets(targets);
    },
    setTargets(next) {
      targets = next;
      current?.prefetcher.setTargets(next);
    },
  };
}
