import {
  type DecisionListResult,
  HUMAN_GATE_DECISION_TYPE,
  openHumanGateDecision,
  type RunListResult,
} from '@farmslot/protocol';
import {
  type ContentPrefetchOptions,
  type ContentPrefetchTarget,
  createContentPrefetcher,
  type GatewayResourceCache,
} from '@farmslot/protocol/client-cache';

import { decisionRunId } from './decision-run-context';
import { nativeActiveRunsQuery, nativeDecisionsQuery } from './gateway-run-sync';

/** Prefetch rule 1's inputs: pending gates, then active runs, each with its last update. */
export function contentPrefetchTargets(
  active: RunListResult | undefined,
  decisions: DecisionListResult | undefined,
): ContentPrefetchTarget[] {
  const runs = new Map((active?.runs ?? []).map((run) => [run.id, run]));
  const targets = new Map<string, ContentPrefetchTarget>();
  for (const decision of decisions?.decisions ?? []) {
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

/** Feeds one prefetcher from the shared active-run and decision observations; nothing polls. */
export function startContentPrefetch(
  options: ContentPrefetchOptions & { cache: GatewayResourceCache },
): () => void {
  const { cache } = options;
  const prefetcher = createContentPrefetcher(options);
  const update = () =>
    prefetcher.setTargets(
      contentPrefetchTargets(
        cache.read(nativeActiveRunsQuery).data,
        cache.read(nativeDecisionsQuery).data,
      ),
    );
  const stops = [
    cache.observe(nativeActiveRunsQuery, update),
    cache.observe(nativeDecisionsQuery, update),
  ];
  update();
  return () => {
    for (const stop of stops) stop();
    prefetcher.dispose();
  };
}
