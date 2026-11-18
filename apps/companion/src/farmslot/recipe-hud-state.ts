import { hudPlacement, isRecipeFlowUpdate, type RecipeFlowUpdate } from '@farmslot/protocol/recipe';

import type { FarmslotRecipeHudState } from './RecipeHud';

interface CompanionRecipeHudState extends FarmslotRecipeHudState {
  recipeFlow?: RecipeFlowUpdate;
}

export function formatRecipeHudIntent(
  state: CompanionRecipeHudState,
  intent = state.intent,
): string {
  const breadcrumbs = state.recipeFlow?.ancestry?.breadcrumbs;
  if (!breadcrumbs || breadcrumbs.length < 2) return intent;
  return `${intent} · ${breadcrumbs.map(({ label }) => label).join(' › ')}`;
}

export function normalizeHudState(
  payload: Record<string, unknown> | undefined,
): CompanionRecipeHudState {
  const status = parseStatus(payload?.status);
  const progress = isRecord(payload?.progress) ? payload.progress : undefined;
  const recipeFlow = isRecipeFlowUpdate(payload?.recipe_flow) ? payload.recipe_flow : undefined;
  return {
    status,
    intent: asString(
      payload?.intent ?? payload?.text,
      status === 'fail' ? 'Recipe failed' : 'Recipe HUD missing intent',
    ),
    currentStep:
      recipeFlow?.progress.current ??
      asOptionalNumber(payload?.currentStep ?? payload?.current_step ?? progress?.current),
    totalSteps: asOptionalNumber(
      recipeFlow
        ? recipeFlow.progress.total
        : (payload?.totalSteps ?? payload?.total_steps ?? progress?.total),
    ),
    ...(recipeFlow ? { recipeFlow } : {}),
    error: asOptionalString(payload?.error),
    position: hudPlacement(payload?.display),
  };
}

function parseStatus(value: unknown): FarmslotRecipeHudState['status'] {
  if (value === 'idle' || value === 'running' || value === 'pass' || value === 'fail') return value;
  return 'running';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
