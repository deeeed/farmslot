import type { RecipeActionManifestDocument, UiObserverRef } from '@farmslot/protocol';

import { verifyExecutableSource } from './trust.js';
import type {
  ActionAdapter,
  ActionResult,
  RecipeLogger,
  RecipeObservationResult,
  RecipeObservationWarning,
} from './types.js';

export type DefaultObserverRefs = ReadonlyMap<string, readonly UiObserverRef[]>;

export function defaultObserverRefsFromManifest(
  manifest: RecipeActionManifestDocument,
): DefaultObserverRefs {
  const refsByAction = new Map<string, UiObserverRef[]>();
  for (const observer of manifest.observers ?? []) {
    for (const action of observer.default_for ?? []) {
      const refs = refsByAction.get(action) ?? [];
      refs.push(observer.ref);
      refsByAction.set(action, refs);
    }
  }
  return refsByAction;
}

export function resolveObserveRefs(
  action: string,
  defaultObserverRefs: DefaultObserverRefs,
): UiObserverRef[] {
  return [...(defaultObserverRefs.get(action) ?? [])];
}

export function filterObservationWarnings(
  warnings: RecipeObservationResult['warnings'],
  refs: readonly UiObserverRef[],
): RecipeObservationResult['warnings'] | undefined {
  if (!warnings) return undefined;
  const allowed = new Set<string>(refs);
  const filtered = warnings.filter((warning) => allowed.has(warning.ref));
  return filtered.length ? filtered : undefined;
}

export function finalizeNodeObservations({
  result,
  observationResult,
  observeRefs,
}: {
  result: ActionResult;
  observationResult: RecipeObservationResult;
  observeRefs: readonly UiObserverRef[];
}): {
  observations: RecipeObservationResult['observations'];
  observationWarnings: RecipeObservationWarning[];
} {
  const observations = filterObservations(
    mergeObservations(result.observations, observationResult.observations),
    observeRefs,
  );
  const observationWarnings =
    filterObservationWarnings(
      [...(result.observationWarnings ?? []), ...(observationResult.warnings ?? [])],
      observeRefs,
    ) ?? [];
  return { observations, observationWarnings };
}

export function filterObservations(
  observations: RecipeObservationResult['observations'],
  refs: readonly UiObserverRef[],
): RecipeObservationResult['observations'] | undefined {
  if (!observations) return undefined;
  const allowed = new Set<string>(refs);
  const filtered = Object.fromEntries(
    Object.entries(observations).filter(([ref]) => allowed.has(ref)),
  );
  return Object.keys(filtered).length ? filtered : undefined;
}

export function mergeObservations(
  first: RecipeObservationResult['observations'],
  second: RecipeObservationResult['observations'],
): RecipeObservationResult['observations'] | undefined {
  const merged = { ...(first ?? {}), ...(second ?? {}) };
  return Object.keys(merged).length ? merged : undefined;
}

export async function runPassiveObservers({
  action,
  node,
  adapter,
  context,
  logger,
  refs,
}: {
  action: string;
  node: Record<string, unknown>;
  adapter: ActionAdapter;
  context: Parameters<ActionAdapter['execute']>[1];
  logger: RecipeLogger;
  refs: readonly UiObserverRef[];
}): Promise<RecipeObservationResult> {
  if (refs.length === 0) return {};
  if (!adapter.observe) {
    return {
      warnings: refs.map((ref) => ({
        ref,
        message: `No passive observer registered for ${action}.`,
      })),
    };
  }
  try {
    await verifyExecutableSource(adapter, `Observer ${action}`);
    return await adapter.observe(refs, node, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`passive observation failed for ${action}: ${message}`);
    return {
      warnings: refs.map((ref) => ({ ref, message })),
    };
  }
}
