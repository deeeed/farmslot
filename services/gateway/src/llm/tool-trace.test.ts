// llm/tool-trace.test.ts — Sanitized Co-Pilot tool trace tests
// Usage: tsx services/gateway/src/llm/tool-trace.test.ts

import assert from 'node:assert/strict';

import { buildToolResults, summarizeToolTraceEntry } from './index.js';

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

function assistantWithTool(name: string, args: Record<string, unknown>, id: string) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
  } as any;
}

await test('file-like tool traces never persist raw content or sentinel text', async () => {
  const entry = summarizeToolTraceEntry({
    callId: 'call-file',
    toolName: 'read_farmslot_file',
    round: 1,
    args: {
      path: 'services/gateway/src/chat/chat-tools.ts',
      apiKey: 'SENTINEL_SECRET_DO_NOT_PERSIST',
    },
    content: JSON.stringify({
      path: 'services/gateway/src/chat/chat-tools.ts',
      content: 'SENTINEL_FILE_SNIPPET_DO_NOT_PERSIST\nconst raw = true;',
      truncated: false,
    }),
    isError: false,
    startedAt: new Date('2026-05-01T00:00:00.000Z'),
    completedAt: new Date('2026-05-01T00:00:00.010Z'),
    durationMs: 10,
  });

  const persisted = JSON.stringify(entry);
  assert.equal(entry.summaryKind, 'file-read');
  assert.equal(entry.status, 'ok');
  assert.match(entry.resultSummary, /contentChars=/);
  assert.doesNotMatch(persisted, /SENTINEL_SECRET_DO_NOT_PERSIST/);
  assert.doesNotMatch(persisted, /SENTINEL_FILE_SNIPPET_DO_NOT_PERSIST/);
  assert.doesNotMatch(entry.resultSummary, /const raw/);
  assert.match(entry.argsSummary ?? '', /apiKey=<redacted>/);
});

await test('error tool traces are bounded and marked error', async () => {
  const entry = summarizeToolTraceEntry({
    callId: 'call-error',
    toolName: 'get_run',
    round: 2,
    args: { run_id: 'missing-run' },
    content: `Run not found: missing-run ${'x'.repeat(1000)} SENTINEL_SECRET_DO_NOT_PERSIST`,
    isError: true,
    startedAt: new Date('2026-05-01T00:00:00.000Z'),
    completedAt: new Date('2026-05-01T00:00:00.025Z'),
    durationMs: 25,
  });

  assert.equal(entry.status, 'error');
  assert.equal(entry.summaryKind, 'error');
  assert(entry.resultSummary.length <= 700);
  assert.doesNotMatch(JSON.stringify(entry), /SENTINEL_SECRET_DO_NOT_PERSIST/);
});

await test('buildToolResults accumulates trace entries by round without changing tool result content', async () => {
  const executor = async (name: string, _args: Record<string, unknown>, callId: string) => ({
    toolCallId: callId,
    toolName: name,
    content: JSON.stringify({
      counts: { activeRuns: 0, pendingDecisions: 6 },
      secret: 'SENTINEL_SECRET_DO_NOT_PERSIST',
    }),
    isError: false,
  });

  const first = await buildToolResults(
    assistantWithTool('operator_snapshot', { scope: 'all' }, 'call-1'),
    executor,
    1,
  );
  const second = await buildToolResults(
    assistantWithTool('chat_session_context', { sessionId: 'default' }, 'call-2'),
    executor,
    2,
  );

  const trace = [...first.trace, ...second.trace];
  const firstToolText = (first.results[0]?.content[0] as { text?: string } | undefined)?.text ?? '';
  assert.equal(firstToolText.includes('SENTINEL_SECRET_DO_NOT_PERSIST'), true);
  assert.deepEqual(
    trace.map((t) => t.round),
    [1, 2],
  );
  assert.deepEqual(
    trace.map((t) => t.toolName),
    ['operator_snapshot', 'chat_session_context'],
  );
  assert.doesNotMatch(JSON.stringify(trace), /SENTINEL_SECRET_DO_NOT_PERSIST/);
});

await test('investigator trace is summarized as an outer report only', async () => {
  const entry = summarizeToolTraceEntry({
    callId: 'call-investigate',
    toolName: 'investigate_gateway_issue',
    round: 1,
    args: { question: 'why are decisions showing?', focus: 'decisions' },
    content: JSON.stringify({
      worker: { kind: 'gateway-readonly-investigator', runtime: 'openai-codex/gpt-5.5' },
      report:
        'Evidence: operator_snapshot, list_pending_decisions. SENTINEL_FILE_SNIPPET_DO_NOT_PERSIST',
      usage: { inputTokens: 123, outputTokens: 45 },
    }),
    isError: false,
    startedAt: new Date('2026-05-01T00:00:00.000Z'),
    completedAt: new Date('2026-05-01T00:00:00.050Z'),
    durationMs: 50,
  });

  assert.equal(entry.summaryKind, 'investigation-report');
  assert.match(entry.resultSummary, /reportChars=/);
  assert.doesNotMatch(entry.resultSummary, /operator_snapshot/);
  assert.doesNotMatch(JSON.stringify(entry), /SENTINEL_FILE_SNIPPET_DO_NOT_PERSIST/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
