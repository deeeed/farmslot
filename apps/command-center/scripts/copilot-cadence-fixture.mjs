// Setup only: seed one private pinned transcript through the owning store before startup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  appendMessage,
  createChatSession,
  persistChatSession,
} from '../../../services/gateway/src/chat/chat-store.js';

assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const directory = await realpath(process.env.FARMSLOT_PLANNING_RACE_ARTIFACTS);
assert.equal(path.resolve(process.env.FARMSLOT_COPILOT_DIR), path.join(directory, 'copilot'));
await mkdir(process.env.FARMSLOT_COPILOT_DIR, { recursive: false });
const sessionId = `manual:cadence-${randomUUID()}`;
createChatSession({ sessionId, title: 'Private cadence proof', pinned: true });
appendMessage(sessionId, {
  id: randomUUID(),
  role: 'assistant',
  content: 'Private setup message. No provider is invoked.',
  timestamp: new Date().toISOString(),
  usage: { inputTokens: 123, outputTokens: 7, costUsd: 0 },
});
await persistChatSession(sessionId);
await writeFile(path.join(directory, 'setup.json'), JSON.stringify({ sessionId }) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
