import type { UiObserverRef } from '@farmslot/protocol';

import type { ActionAdapter, RecipeLogger, RecipeObservationResult } from './types.js';

const DEFAULT_UI_OBSERVER_REFS = ['ui.screen', 'ui.visible'] as const;
const DEFAULT_OBSERVED_UI_ACTIONS = new Set([
  'ui.navigate',
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.scroll',
  'ui.gesture',
  'ui.wait_for',
]);

function resolveObserveRefs(action: string, node: Record<string, unknown>): UiObserverRef[] {
  const policy = node.observe;
  if (policy === false) return [];
  if (Array.isArray(policy)) {
    return policy.filter(
      (ref): ref is UiObserverRef => typeof ref === 'string' && ref.trim() !== '',
    );
  }
  if (policy === true) return [...DEFAULT_UI_OBSERVER_REFS];
  if (!DEFAULT_OBSERVED_UI_ACTIONS.has(action)) return [];
  return [...DEFAULT_UI_OBSERVER_REFS];
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
}: {
  action: string;
  node: Record<string, unknown>;
  adapter: ActionAdapter;
  context: Parameters<ActionAdapter['execute']>[1];
  logger: RecipeLogger;
}): Promise<RecipeObservationResult> {
  const refs = resolveObserveRefs(action, node);
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
