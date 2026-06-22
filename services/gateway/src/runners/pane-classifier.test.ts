import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePaneClassifierResult } from './pane-classifier.js';

test('parsePaneClassifierResult accepts strict classifier JSON', () => {
  assert.deepEqual(
    parsePaneClassifierResult(
      JSON.stringify({
        state: 'command_not_submitted',
        confidence: 0.91,
        suggestedAction: 'send_enter',
        reason: 'shell prompt contains the launch command',
      }),
    ),
    {
      state: 'command_not_submitted',
      confidence: 0.91,
      suggestedAction: 'send_enter',
      reason: 'shell prompt contains the launch command',
    },
  );
});

test('parsePaneClassifierResult extracts JSON from fenced prose and clamps confidence', () => {
  assert.deepEqual(
    parsePaneClassifierResult(
      '```json\n{"state":"ready","confidence":2,"suggestedAction":"wait","reason":"prompt visible"}\n```',
    ),
    {
      state: 'ready',
      confidence: 1,
      suggestedAction: 'wait',
      reason: 'prompt visible',
    },
  );
});

test('parsePaneClassifierResult rejects invalid enum values', () => {
  assert.equal(
    parsePaneClassifierResult(
      '{"state":"looks_good","confidence":1,"suggestedAction":"rm_rf","reason":"bad"}',
    ),
    null,
  );
});
