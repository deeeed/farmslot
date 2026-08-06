import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptAcceptedFromCodexSession } from './codex-observability.js';

const prompt = 'Read SELF-REVIEW-FIX.md';

function record(timestamp: string, text: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

test('Codex native session history accepts the exact post-baseline prompt', () => {
  const before = '2026-08-06T09:00:00.000Z';
  const after = '2026-08-06T09:01:00.000Z';
  const reading = promptAcceptedFromCodexSession(
    [`partial-json`, record(before, prompt), record(after, prompt)].join('\n'),
    prompt,
    Date.parse('2026-08-06T09:00:30.000Z'),
  );

  assert.deepEqual(reading, {
    value: true,
    source: 'signal',
    confidence: 'high',
    observedAt: Date.parse(after),
    exactPromptMatch: true,
  });
});

test('Codex native session history rejects old and non-exact prompts', () => {
  const raw = [
    record('2026-08-06T09:00:00.000Z', prompt),
    record('2026-08-06T09:02:00.000Z', `${prompt} please`),
  ].join('\n');

  assert.equal(
    promptAcceptedFromCodexSession(raw, prompt, Date.parse('2026-08-06T09:01:00.000Z')),
    null,
  );
});
