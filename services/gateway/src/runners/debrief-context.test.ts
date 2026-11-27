import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codexDebriefRoute, piDebriefRoute, projectPiDebriefText } from './debrief-context.js';
import { getRunnerSessionHistoryProvider } from './worker-session-history.js';

test('a retained Pi model change supplies its exact provider and latest model', () => {
  const lines = [
    { type: 'model_change', provider: 'openai', modelId: 'earlier' },
    { type: 'model_change', provider: 'anthropic', modelId: 'current' },
    { type: 'message', message: { role: 'user', content: 'Why was proof rerun?' } },
    { type: 'message', message: { role: 'toolResult', content: 'Excluded tool result.' } },
  ].map((row) => JSON.stringify(row));
  assert.deepEqual(piDebriefRoute(lines), { provider: 'anthropic', model: 'current' });
  assert.deepEqual(
    projectPiDebriefText(lines).map(({ text }) => text),
    ['Why was proof rerun?'],
  );
  assert.equal(getRunnerSessionHistoryProvider('pi'), undefined);
  assert.equal(
    piDebriefRoute([...lines, '{"type":"model_change","modelId":"unknown"}']),
    undefined,
  );
});

test('a generic Codex provider label does not establish authorization', () => {
  const turn = '{"type":"turn_context","payload":{"model":"gpt-6-codex"}}';
  assert.equal(
    codexDebriefRoute(['{"type":"session_meta","payload":{"model_provider":"openai"}}', turn]),
    undefined,
  );
  assert.deepEqual(
    codexDebriefRoute(['{"type":"session_meta","payload":{"model_provider":"codex-lb"}}', turn]),
    { provider: 'codex-lb', model: 'gpt-6-codex' },
  );
});
