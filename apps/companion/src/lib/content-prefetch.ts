import {
  type ConfigProjectsResult,
  type DecisionListResult,
  HUMAN_GATE_DECISION_TYPE,
  openHumanGateDecision,
  type Run,
  type RunListResult,
} from '@farmslot/protocol';
import {
  activeRunDiffBase,
  type ContentPrefetchOptions,
  type ContentPrefetchTarget,
  createContentPrefetcher,
  type GatewayResourceCache,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { decisionRunId } from './decision-run-context';
import type { EvidenceMediaHolder } from './evidence-media';
import {
  configurationProjectsQuery,
  nativeActiveRunsQuery,
  nativeDecisionsQuery,
} from './gateway-run-sync';

/** The project's default branch, from the projects observation; undefined without one. */
export function projectDefaultBranch(projects: ConfigProjectsResult | undefined) {
  return (run: Pick<Run, 'project'>): string | undefined =>
    projects?.projects.find((project) => project.name === run.project)?.defaultBranch || undefined;
}

/**
 * The base prefetch and the diff screens give an active run's diff: the stack base, then the
 * project's default branch, then main. `projects` is the farm owner's projects observation, and
 * absent without farm access. Undefined while it is still loading, so no read starts at a base
 * that is about to change.
 */
export function companionRunDiffBase(
  run: Pick<Run, 'project' | 'stack'>,
  projects: ResourceQueryState<ConfigProjectsResult> | undefined,
): string | undefined {
  if (projects?.status === 'loading') return undefined;
  return activeRunDiffBase(run, projectDefaultBranch(projects?.data));
}

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

/**
 * The gates whose media stays on the device: undefined until both lists are known, so a cold
 * start that has not read them yet drops nothing.
 */
export function heldGateRunIds(
  active: RunListResult | undefined,
  decisions: DecisionListResult | undefined,
): Set<string> | undefined {
  if (!active || !decisions) return undefined;
  return new Set(
    contentPrefetchTargets(active, decisions)
      .filter((target) => target.gate)
      .map((target) => target.runId),
  );
}

/**
 * Feeds one prefetcher from the shared active-run and decision observations; nothing polls. A
 * farm owner also observes its projects, and runs start once their default branches are known.
 */
export function startContentPrefetch(
  options: Omit<ContentPrefetchOptions, 'defaultBranch' | 'media'> & {
    cache: GatewayResourceCache;
    farm: boolean;
    media?: EvidenceMediaHolder;
  },
): () => void {
  const { cache, farm, media } = options;
  const projects = () => (farm ? cache.read(configurationProjectsQuery) : undefined);
  const prefetcher = createContentPrefetcher({
    ...options,
    // The same base companionRunDiffBase gives the diff screens.
    defaultBranch: (run) => projectDefaultBranch(projects()?.data)(run),
  });
  const update = () => {
    if (projects()?.status === 'loading') return;
    const active = cache.read(nativeActiveRunsQuery).data;
    const decisions = cache.read(nativeDecisionsQuery).data;
    prefetcher.setTargets(contentPrefetchTargets(active, decisions));
    // A decided gate's media goes.
    const keep = heldGateRunIds(active, decisions);
    if (media && keep)
      media.keep(keep).catch((error: unknown) => {
        // The next decision update keeps again; a failed drop leaves files inside the bound.
        console.warn(
          `Held evidence was not trimmed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const stops = [
    cache.observe(nativeActiveRunsQuery, update),
    cache.observe(nativeDecisionsQuery, update),
    ...(farm ? [cache.observe(configurationProjectsQuery, update)] : []),
  ];
  update();
  return () => {
    for (const stop of stops) stop();
    prefetcher.dispose();
  };
}
