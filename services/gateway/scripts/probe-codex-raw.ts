#!/usr/bin/env -S npx tsx
// probe-codex-raw.ts — bypass our wrapper and call pi-ai directly, capturing
// HTTP status / response shape to diagnose codex auth or quota issues.

import * as piAi from '@earendil-works/pi-ai';

import { resolveAuth } from '../src/llm/auth-resolve.js';

async function main() {
  const provider = 'openai-codex';
  const model = process.env.MODEL ?? 'gpt-5.6-sol';
  const auth = await resolveAuth(provider);
  if (!auth) {
    console.error(`no auth resolved for ${provider}`);
    process.exit(1);
  }
  console.log(
    `auth source=${auth.source} keyLen=${auth.apiKey.length} keyPrefix=${auth.apiKey.slice(0, 8)}...`,
  );

  const piModel = piAi.getModel(provider, model);
  if (!piModel) {
    console.error(`unknown model: ${provider}/${model}`);
    process.exit(1);
  }
  console.log(
    `model: ${piModel.id} api=${piModel.api ?? 'default'} baseUrl=${piModel.baseUrl ?? 'default'}`,
  );

  let httpStatus: number | undefined;
  let httpHeaders: Record<string, string> | undefined;

  try {
    const res = await piAi.completeSimple(
      piModel,
      {
        systemPrompt: 'Reply with exactly: OK',
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        maxTokens: 32,
        onResponse: ({ status, headers }: { status: number; headers: Record<string, string> }) => {
          httpStatus = status;
          httpHeaders = headers;
        },
      } as any,
    );

    console.log(`HTTP status: ${httpStatus}`);
    if (httpStatus !== 200) {
      console.log('headers:', JSON.stringify(httpHeaders, null, 2));
    }
    console.log('content type:', typeof res.content, 'isArray:', Array.isArray(res.content));
    console.log('content:', JSON.stringify(res.content).slice(0, 600));
    console.log('usage:', JSON.stringify(res.usage));
    console.log('stopReason:', (res as any).stopReason);
  } catch (err) {
    console.log(`THROWN: ${(err as Error).message}`);
    console.log(`HTTP status (if captured before throw): ${httpStatus}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
