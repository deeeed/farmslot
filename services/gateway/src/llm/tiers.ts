// llm/tiers.ts — the built-in cross-provider tier map.
import type { LLMTierName } from '@farmslot/protocol';

import { CODEX_ASTRA_MODEL } from './codex-astra.js';

export const LLM_TIERS: readonly LLMTierName[] = ['fast', 'standard', 'smart'];

// Tiers resolve to provider-specific alias names, then through MODEL_ALIASES.
// This lets callers use `model: 'fast'` regardless of provider.
export const TIER_MAP: Record<string, Record<string, string>> = {
  fast: {
    anthropic: 'haiku',
    openai: 'gpt-4.1-mini',
    'openai-codex': 'gpt-5.6-luna',
    'codex-lb': CODEX_ASTRA_MODEL,
    google: 'gemini-flash',
  },
  standard: {
    anthropic: 'sonnet',
    openai: 'gpt-4.1',
    'openai-codex': 'gpt-5.6-terra',
    'codex-lb': CODEX_ASTRA_MODEL,
    google: 'gemini-pro',
  },
  smart: {
    anthropic: 'opus',
    openai: 'gpt-4.1',
    'openai-codex': 'gpt-5.6-sol',
    'codex-lb': CODEX_ASTRA_MODEL,
    google: 'gemini-pro',
  },
};

/** Providers the tier map names: the only ones a tier override may name. */
export function tierProviders(): string[] {
  return [...new Set(LLM_TIERS.flatMap((tier) => Object.keys(TIER_MAP[tier])))];
}
