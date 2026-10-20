import type {
  FarmslotRecipeUiObservation,
  FarmslotRecipeUiObserver,
} from '../farmslot/RecipeBridgeProvider';

/** A partial app observer preserves the host observer and default HUD observations. */
export async function resolveRecipeUiObservation(
  refs: readonly string[],
  local: FarmslotRecipeUiObserver | undefined,
  host: FarmslotRecipeUiObserver | undefined,
  fallback: () => FarmslotRecipeUiObservation,
): Promise<FarmslotRecipeUiObservation> {
  return (await local?.(refs)) ?? (await host?.(refs)) ?? fallback();
}
