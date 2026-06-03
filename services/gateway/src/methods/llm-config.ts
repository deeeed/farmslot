// methods/llm-config.ts — Gateway methods for LLM config management

import type {
  LLMConfigGetResult,
  LLMConfigSetParams,
  LLMConfigSetResult,
  LLMTiersResult,
} from '@farmslot/protocol';

import { getLLMConfig, setLLMConfig } from '../llm/config.js';
import { TIER_MAP } from '../llm/index.js';

export function llmConfigGet(): LLMConfigGetResult {
  return getLLMConfig();
}

export function llmConfigSet(params: LLMConfigSetParams): LLMConfigSetResult {
  setLLMConfig(params);
  return { ok: true };
}

export function llmTiers(): LLMTiersResult {
  return { tiers: TIER_MAP };
}
