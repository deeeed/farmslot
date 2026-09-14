// llm/config.ts — Gateway-level LLM provider configuration
// Persisted to <FARMSLOT_HOME>/llm-config.json (default ~/.farmslot).
// Cascade: config file → env vars → hardcoded defaults.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ThinkingLevel } from '@earendil-works/pi-ai';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { CODEX_ASTRA_MODEL } from './codex-astra.js';

export interface LLMConfig {
  defaultProvider: string;
  copilotModel: string;
  intelligenceModel: string;
  improvementModel: string;
  copilotEffort: ThinkingLevel;
  intelligenceEffort: ThinkingLevel;
}

// Resolve at call time, not import time: the gateway loads its .env (which may set
// FARMSLOT_HOME) AFTER this module is imported, so a captured const would miss it.
function configPath(): string {
  return path.join(farmslotHome(), 'llm-config.json');
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

export function getLLMConfig(): LLMConfig {
  if (_cache) return _cache;

  const cfgPath = configPath();
  // 1. Try config file
  try {
    if (existsSync(cfgPath)) {
      const raw = readFileSync(cfgPath, 'utf-8');
      const parsed = JSON.parse(raw);
      _cache = {
        ...llmDefaultsForProvider(parsed.defaultProvider ?? DEFAULTS.defaultProvider),
        ...parsed,
      };
      return _cache!;
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

export function setLLMConfig(partial: Partial<LLMConfig>): LLMConfig {
  // Validate inputs — these flow into shell commands and API calls
  for (const [key, val] of Object.entries(partial)) {
    if (typeof val === 'string' && !SAFE_VALUE.test(val)) {
      throw new Error(`[llm] invalid config value for ${key}: ${val}`);
    }
  }
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
  console.log(`[llm] config updated: ${JSON.stringify(updated)}`);
  return updated;
}
