#!/usr/bin/env -S npx tsx
// probe-llm-providers.ts — sanity-check each LLM provider/model pair with a
// minimal prompt to confirm whether they respond at all.

import { callLLM } from '../src/llm/index.js';

// Cover every alias the gateway emits via TIER_MAP + MODEL_ALIASES at least
// once so a pi-ai upgrade that fails to register a model surfaces here
// (e.g. claude-opus-4-7 didn't land until Anthropic shipped it; if the
// runtime is on an older pi-ai, this probe is the early-warning siren).
const TARGETS: Array<{ provider: string; model: string }> = [
  { provider: 'anthropic', model: 'haiku' },
  { provider: 'anthropic', model: 'sonnet' },
  { provider: 'anthropic', model: 'opus' },
  { provider: 'openai-codex', model: 'gpt-5.4' },
  { provider: 'openai-codex', model: 'gpt-5.5' },
  { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  { provider: 'openai-codex', model: 'gpt-5.6-terra' },
  { provider: 'openai-codex', model: 'gpt-5.6-luna' },
];

async function probe(provider: string, model: string) {
  const t0 = Date.now();
  try {
    const res = await callLLM({
      provider,
      model,
      systemPrompt: 'Reply with the single word OK and nothing else.',
      userPrompt: 'ping',
      maxTokens: 32,
    });
    const dt = Date.now() - t0;
    const text = (res.text ?? '').trim();
    const verdict =
      text.length === 0 ? 'EMPTY' : text.toLowerCase().includes('ok') ? 'OK' : 'NON-OK';
    console.log(
      `[${provider}/${model}] ${verdict.padEnd(7)} ${dt}ms in=${res.usage.inputTokens ?? '?'} out=${res.usage.outputTokens ?? '?'} text=${JSON.stringify(text.slice(0, 80))}`,
    );
  } catch (err) {
    console.log(`[${provider}/${model}] THROWN ${(err as Error).message}`);
  }
}

async function main() {
  for (const t of TARGETS) await probe(t.provider, t.model);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
