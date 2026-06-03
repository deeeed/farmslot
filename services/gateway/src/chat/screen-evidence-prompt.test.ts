// screen-evidence-prompt.test.ts — prompt compaction checks for cached screen evidence
// Usage: tsx services/gateway/src/chat/screen-evidence-prompt.test.ts

import type { ScreenEvidenceSnapshot } from '@farmslot/protocol';

import {
  SCREEN_EVIDENCE_PROMPT_MAX_BYTES,
  serializeScreenEvidenceForPrompt,
} from './screen-evidence-prompt.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`${GREEN}PASS${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}FAIL${RESET} ${name}: ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

await test('screen evidence prompt JSON is byte capped', () => {
  const snapshot: ScreenEvidenceSnapshot = {
    snapshotId: 'snapshot-large',
    sessionId: 'manual:test',
    surfaceId: 'pr-dashboard',
    visibleTextSnippets: ['A'.repeat(20_000)],
    visibleControls: ['B'.repeat(20_000)],
    capturedAt: new Date().toISOString(),
    ttlMs: 300_000,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    freshness: 'fresh',
    provenance: ['ui-client-context', 'visible-dom-snippets'],
    uncertainty: ['none'],
  };
  const json = serializeScreenEvidenceForPrompt(snapshot);
  assert(
    Buffer.byteLength(json, 'utf-8') <= SCREEN_EVIDENCE_PROMPT_MAX_BYTES,
    `screen evidence prompt exceeded cap: ${Buffer.byteLength(json, 'utf-8')}`,
  );
});

if (failed > 0) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
