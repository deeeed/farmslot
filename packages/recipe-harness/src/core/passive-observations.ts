import {
  BUILT_IN_UI_OBSERVERS,
  type RecipeActionManifestDocument,
  type UiObserverRef,
} from '@farmslot/protocol';

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

function resolveObserveRefs(
  action: string,
  node: Record<string, unknown>,
  defaultObserverRefs: DefaultObserverRefs,
): UiObserverRef[] {
  const policy = node.observe;
  if (policy === false) return [];
  if (Array.isArray(policy)) {
    return policy.filter(
      (ref): ref is UiObserverRef => typeof ref === 'string' && ref.trim() !== '',
    );
  }
  if (policy === true) return [...BUILT_IN_UI_OBSERVERS];
  return [...(defaultObserverRefs.get(action) ?? [])];
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
}: {
  action: string;
  node: Record<string, unknown>;
  adapter: ActionAdapter;
  context: Parameters<ActionAdapter['execute']>[1];
  logger: RecipeLogger;
  defaultObserverRefs: DefaultObserverRefs;
}): Promise<RecipeObservationResult> {
  const refs = resolveObserveRefs(action, node, defaultObserverRefs);
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
