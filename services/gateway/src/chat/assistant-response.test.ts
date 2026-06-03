// assistant-response.test.ts — deterministic parser checks
// Usage: tsx services/gateway/src/chat/assistant-response.test.ts

import { parseAssistantResponse, parseNextSteps } from './assistant-response.js';

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

await test('valid next_steps JSON attaches normalized ChatNextStep items', () => {
  const parsed = parseNextSteps(`Answer.
<next_steps>[
  {"id":"bundle","label":"Read bundle","kind":"read","safety":"read-only","params":{"prompt":"Read run bundle"}},
  {"id":"confirm","label":"Cancel run","kind":"confirmed-action","safety":"requires-confirmation","params":{"actionType":"run.cancel"}}
]</next_steps>`);

  assert(parsed.cleanText === 'Answer.', `unexpected clean text: ${parsed.cleanText}`);
  assert(parsed.nextSteps.length === 1, `expected 1 next step, got ${parsed.nextSteps.length}`);
  assert(parsed.nextSteps[0].params.prompt === 'Read run bundle', 'missing params');
});

await test('unsupported confirmed-action next steps are rejected', () => {
  const parsed = parseNextSteps(`<next_steps>[
    {"id":"confirm","label":"Cancel run","kind":"confirmed-action","safety":"requires-confirmation","params":{"actionType":"run.cancel"}}
  ]</next_steps>`);
  assert(
    parsed.nextSteps.length === 0,
    `expected unsupported confirmed-action to be rejected, got ${parsed.nextSteps.length}`,
  );
});

await test('malformed next_steps JSON is non-fatal and preserves answer text', () => {
  const parsed = parseNextSteps('Answer.<next_steps>[bad json</next_steps>');
  assert(parsed.cleanText === 'Answer.', `unexpected clean text: ${parsed.cleanText}`);
  assert(parsed.nextSteps.length === 0, `expected no next steps, got ${parsed.nextSteps.length}`);
});

await test('unknown next step kind and safety are rejected', () => {
  const parsed = parseNextSteps(`<next_steps>[
    {"id":"bad-kind","label":"Bad kind","kind":"write","safety":"read-only","params":{}},
    {"id":"bad-safety","label":"Bad safety","kind":"prompt","safety":"unsafe","params":{}},
    {"id":"ok","label":"OK","kind":"prompt","safety":"read-only","params":{}}
  ]</next_steps>`);
  assert(
    parsed.nextSteps.length === 1,
    `expected 1 valid next step, got ${parsed.nextSteps.length}`,
  );
  assert(parsed.nextSteps[0].id === 'ok', `unexpected accepted step ${parsed.nextSteps[0].id}`);
});

await test('suggestedActions remain separate from nextSteps', () => {
  const parsed = parseAssistantResponse(`Answer.
<actions>[{"type":"memory.update","label":"Save","params":{"content":"x"}}]</actions>
<next_steps>[{"id":"follow","label":"Follow up","kind":"prompt","safety":"read-only","params":{"prompt":"Explain"}}]</next_steps>`);

  assert(parsed.cleanText === 'Answer.', `unexpected clean text: ${parsed.cleanText}`);
  assert(parsed.actions.length === 1, `expected 1 action, got ${parsed.actions.length}`);
  assert(parsed.nextSteps.length === 1, `expected 1 next step, got ${parsed.nextSteps.length}`);
  assert(parsed.actions[0].type === 'memory.update', 'action was not preserved');
  assert(parsed.nextSteps[0].kind === 'prompt', 'next step was not preserved');
});

await test('multiple tagged action and next-step blocks are all parsed', () => {
  const parsed = parseAssistantResponse(`Answer.
<actions>[{"type":"memory.update","label":"Save","params":{"content":"x"}}]</actions>
Middle.
<actions>[{"type":"run.cancel","label":"Cancel","params":{"runId":"run-1"}}]</actions>
<next_steps>[{"id":"one","label":"One","kind":"prompt","safety":"read-only","params":{"prompt":"one"}}]</next_steps>
<next_steps>[{"id":"two","label":"Two","kind":"read","safety":"read-only","params":{"prompt":"two"}}]</next_steps>`);

  assert(
    parsed.cleanText === 'Answer.\n\nMiddle.',
    `unexpected clean text: ${JSON.stringify(parsed.cleanText)}`,
  );
  assert(parsed.actions.length === 2, `expected 2 actions, got ${parsed.actions.length}`);
  assert(parsed.nextSteps.length === 2, `expected 2 next steps, got ${parsed.nextSteps.length}`);
  assert(parsed.nextSteps[1].id === 'two', 'second next step was not preserved');
});

await test('orphan control tags are stripped from displayed assistant text', () => {
  const parsed = parseAssistantResponse('Answer <actions>[not json</next_steps> tail');
  assert(
    !parsed.cleanText.includes('<actions>'),
    `clean text leaked actions tag: ${parsed.cleanText}`,
  );
  assert(
    !parsed.cleanText.includes('</next_steps>'),
    `clean text leaked next_steps tag: ${parsed.cleanText}`,
  );
});

await test('parseAssistantResponse strips unclosed action tag bodies', () => {
  const truncated = 'Hello operator <actions>[{"type":"foo","label":"L","params":{}}';
  const result = parseAssistantResponse(truncated);
  assert(!result.cleanText.includes('<actions>'), `orphan opener leaked: ${result.cleanText}`);
  assert(!result.cleanText.includes('"type":"foo"'), `orphan body leaked: ${result.cleanText}`);
  assert(
    result.cleanText.startsWith('Hello operator'),
    `pre-tag content lost: ${result.cleanText}`,
  );
  assert(
    result.actions.length === 0,
    `unclosed block should not yield actions, got ${result.actions.length}`,
  );
});

if (failed > 0) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
