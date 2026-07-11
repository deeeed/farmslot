import type { RecipeActionManifestDocument, UiObserverRef } from '@farmslot/protocol';

import type { ActionAdapter, RecipeLogger, RecipeObservationResult } from './types.js';

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

export function declaredObserverRefsFromManifest(
  manifest: RecipeActionManifestDocument,
): readonly UiObserverRef[] {
  return (manifest.observers ?? []).map((observer) => observer.ref);
}

export function resolveObserveRefs(
  action: string,
  node: Record<string, unknown>,
  defaultObserverRefs: DefaultObserverRefs,
  declaredObserverRefs: readonly UiObserverRef[],
): UiObserverRef[] {
  const policy = node.observe;
  if (policy === false) return [];
  if (Array.isArray(policy)) {
    return policy.filter(
      (ref): ref is UiObserverRef => typeof ref === 'string' && ref.trim() !== '',
    );
  }
  if (policy === true) return [...declaredObserverRefs];
  return [...(defaultObserverRefs.get(action) ?? [])];
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
  defaultObserverRefs,
  declaredObserverRefs,
}: {
  action: string;
  node: Record<string, unknown>;
  adapter: ActionAdapter;
  context: Parameters<ActionAdapter['execute']>[1];
  logger: RecipeLogger;
  defaultObserverRefs: DefaultObserverRefs;
  declaredObserverRefs: readonly UiObserverRef[];
}): Promise<RecipeObservationResult> {
  const refs = resolveObserveRefs(action, node, defaultObserverRefs, declaredObserverRefs);
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
    return await adapter.observe(refs, node, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`passive observation failed for ${action}: ${message}`);
    return {
      warnings: refs.map((ref) => ({ ref, message })),
    };
  }
}
