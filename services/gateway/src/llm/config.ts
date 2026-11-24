// llm/config.ts — Gateway-level LLM provider configuration
// Persisted to <FARMSLOT_HOME>/llm-config.json (default ~/.farmslot).
// Cascade: config file → env vars → hardcoded defaults.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ThinkingLevel } from '@earendil-works/pi-ai';

import type { LLMTierModels } from '@farmslot/protocol';
import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { publishConfigurationResources } from '../resources/configuration-changes.js';

import { CODEX_ASTRA_MODEL } from './codex-astra.js';
import { LLM_TIERS, tierProviders } from './tiers.js';

export interface LLMConfig {
  defaultProvider: string;
  copilotModel: string;
  intelligenceModel: string;
  improvementModel: string;
  copilotEffort: ThinkingLevel;
  intelligenceEffort: ThinkingLevel;
  /** Per-provider ids that replace the built-in tier map, so a tier can follow a served model. */
  tierModels?: LLMTierModels;
}

// Resolve at call time, not import time: the gateway loads its .env (which may set
// FARMSLOT_HOME) AFTER this module is imported, so a captured const would miss it.
function configPath(): string {
  return path.join(currentFarmPaths('node').config, 'llm-config.json');
}

const DEFAULTS: LLMConfig = {
  defaultProvider: 'openai-codex',
  copilotModel: CODEX_ASTRA_MODEL,
  intelligenceModel: CODEX_ASTRA_MODEL,
  improvementModel: 'standard',
  copilotEffort: 'low',
  intelligenceEffort: 'low',
};

export function llmDefaultsForProvider(provider: string): LLMConfig {
  return {
    ...DEFAULTS,
    defaultProvider: provider,
    ...(!['openai-codex', 'codex-lb'].includes(provider)
      ? { copilotModel: 'standard', intelligenceModel: 'fast' }
      : {}),
  };
}

let _cache: LLMConfig | null = null;

/** Existing selected-home watcher calls this when an external config writer commits. */
export function invalidateLLMConfig(): void {
  _cache = null;
}

export function getLLMConfig(): LLMConfig {
  if (_cache) return _cache;

  const cfgPath = configPath();
  // 1. Try config file
  try {
    if (existsSync(cfgPath)) {
      const raw = readFileSync(cfgPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const loaded: LLMConfig = {
        ...llmDefaultsForProvider(parsed.defaultProvider ?? DEFAULTS.defaultProvider),
        ...parsed,
      };
      // A hand-edited override the setter would refuse is dropped, not routed: its ids reach
      // provider requests and the CLI fallback.
      if (loaded.tierModels !== undefined) {
        try {
          validateTierModels(loaded.tierModels);
        } catch (error) {
          console.warn(`[llm] ignoring tierModels in ${cfgPath}: ${(error as Error).message}`);
          delete loaded.tierModels;
        }
      }
      _cache = loaded;
      return loaded;
    }
  } catch {
    // fall through
  }

  // 2. Env var fallback
  const defaults = llmDefaultsForProvider(process.env.COPILOT_PROVIDER ?? DEFAULTS.defaultProvider);
  _cache = {
    defaultProvider: defaults.defaultProvider,
    copilotModel: process.env.COPILOT_MODEL ?? defaults.copilotModel,
    intelligenceModel: defaults.intelligenceModel,
    improvementModel: DEFAULTS.improvementModel,
    copilotEffort: DEFAULTS.copilotEffort,
    intelligenceEffort: DEFAULTS.intelligenceEffort,
  };
  return _cache!;
}

const SAFE_VALUE = /^[\w.-]+$/;

/**
 * Tier overrides replace the whole saved map. Providers and tiers must be ones the tier map
 * knows, and every id is a safe value: it reaches provider requests and the CLI fallback.
 */
function validateTierModels(tierModels: unknown): void {
  const providers = tierProviders();
  if (typeof tierModels !== 'object' || tierModels === null || Array.isArray(tierModels))
    throw new Error('[llm] tierModels must be an object of provider → tier → model id');
  for (const [provider, tiers] of Object.entries(tierModels)) {
    if (!providers.includes(provider))
      throw new Error(`[llm] tierModels names an unknown provider: ${provider}`);
    if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers))
      throw new Error(`[llm] tierModels.${provider} must be an object of tier → model id`);
    for (const [tier, model] of Object.entries(tiers)) {
      if (!LLM_TIERS.some((name) => name === tier))
        throw new Error(`[llm] tierModels.${provider} names an unknown tier: ${tier}`);
      if (typeof model !== 'string' || !SAFE_VALUE.test(model))
        throw new Error(`[llm] invalid model id for tierModels.${provider}.${tier}: ${model}`);
    }
  }
}

export function setLLMConfig(partial: Partial<LLMConfig>): LLMConfig {
  // Validate inputs — these flow into shell commands and API calls
  for (const [key, val] of Object.entries(partial)) {
    if (typeof val === 'string' && !SAFE_VALUE.test(val)) {
      throw new Error(`[llm] invalid config value for ${key}: ${val}`);
    }
  }
  if (partial.tierModels !== undefined) validateTierModels(partial.tierModels);
  for (const key of ['copilotEffort', 'intelligenceEffort'] as const) {
    const effort = partial[key];
    if (
      effort !== undefined &&
      !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
    )
      throw new Error(`[llm] invalid reasoning effort for ${key}: ${effort}`);
  }
  const current = getLLMConfig();
  const updated: LLMConfig = { ...current, ...partial };

  const cfgPath = configPath();
  const cfgDir = path.dirname(cfgPath);
  if (!existsSync(cfgDir)) {
    mkdirSync(cfgDir, { recursive: true });
  }
  writeFileSync(cfgPath, JSON.stringify(updated, null, 2) + '\n');
  _cache = updated;
  publishConfigurationResources();
  console.log(`[llm] config updated: ${JSON.stringify(updated)}`);
  return updated;
}
