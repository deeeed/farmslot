import type { LLMTierModels, LLMTierName } from '@farmslot/protocol';

/** The edited tier cells, provider → tier → typed text. */
export type TierModelEdits = Record<string, Partial<Record<string, string>>>;

const TIERS: readonly LLMTierName[] = ['fast', 'standard', 'smart'];

/** The override a cell shows: the saved id, or empty when the tier uses its built-in id. */
export function tierModelOverride(
  saved: LLMTierModels | undefined,
  provider: string,
  tier: string,
): string {
  const name = TIERS.find((candidate) => candidate === tier);
  return name ? (saved?.[provider]?.[name] ?? '') : '';
}

/**
 * The full `tierModels` to save. A cell left empty, or set to its built-in id, is no override.
 * The gateway replaces every saved override with this map, so it starts from the saved one.
 */
export function tierModelsToSave(
  saved: LLMTierModels | undefined,
  edits: TierModelEdits,
  builtIn: Record<string, Record<string, string>>,
): LLMTierModels {
  const result: LLMTierModels = {};
  const providers = new Set([...Object.keys(saved ?? {}), ...Object.keys(edits)]);
  for (const provider of providers) {
    const tiers: Partial<Record<LLMTierName, string>> = {};
    for (const tier of TIERS) {
      const edited = edits[provider]?.[tier];
      const value = (edited ?? saved?.[provider]?.[tier] ?? '').trim();
      if (value && value !== builtIn[tier]?.[provider]) tiers[tier] = value;
    }
    if (Object.keys(tiers).length > 0) result[provider] = tiers;
  }
  return result;
}
