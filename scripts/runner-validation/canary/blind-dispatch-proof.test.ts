import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorkerSessionHistoryMessage } from '../../../packages/protocol/src/index.js';

import { firstBlindTool } from './blind-dispatch-proof.js';

test('blind dispatch needs an assistant tool in the structured transcript', () => {
  const claimed: WorkerSessionHistoryMessage = {
    id: 'text',
    role: 'assistant',
    text: 'I called bash and reached the model.',
  };
  const user: WorkerSessionHistoryMessage = {
    id: 'user',
    role: 'user',
    text: '',
    tools: [{ name: 'bash' }],
  };
  const tool: WorkerSessionHistoryMessage = {
    id: 'call',
    role: 'assistant',
    text: '',
    tools: [{ name: 'exec_command' }],
  };
  assert.equal(firstBlindTool({ source: 'transcript', messages: [claimed, user] }), undefined);
  for (const source of ['pane-degraded', 'unavailable', 'transcript-archive'] as const)
    assert.equal(firstBlindTool({ source, messages: [tool] }), undefined);
  assert.equal(firstBlindTool({ source: 'transcript', messages: [claimed, tool] }), tool);
});
