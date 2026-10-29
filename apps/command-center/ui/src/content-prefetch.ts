import {
  HUMAN_GATE_DECISION_TYPE,
  openHumanGateDecision,
  type PendingDecision,
  type Run,
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
  activeRuns: readonly Pick<Run, 'id' | 'updatedAt' | 'decisions'>[],
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
  if (!response.ok) throw new Error(`Run artifact unavailable (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
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
      const prefetcher = createContentPrefetcher({ ...options, cache: next });
      current = { cache: next, prefetcher };
      prefetcher.setTargets(targets);
    },
    setTargets(next) {
      targets = next;
      current?.prefetcher.setTargets(next);
    },
  };
}
