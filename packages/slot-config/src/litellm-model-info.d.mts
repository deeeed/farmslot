export interface PiModelCostRates {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite1h?: number | null;
  reasoningOutput?: number | null;
}

/** USD per million tokens; null is an unreported price, not a free category. */
export interface PiModelCostMetadata extends PiModelCostRates {
  tiers?: Array<PiModelCostRates & { inputTokensAbove: number }>;
}

export function normalizeLiteLlmModelInfo(
  info: Record<string, unknown>,
  reasoning?: boolean,
): PiModelCostMetadata | null;
export function isLiteLlmPriceField(key: string): boolean;
