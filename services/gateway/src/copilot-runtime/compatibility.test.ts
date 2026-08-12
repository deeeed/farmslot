import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Events } from '@farmslot/protocol';

import { getSessionMessages } from '../chat/chat-store.js';
import { readLastScreenEvidence } from '../chat/screen-evidence.js';
import {
  chatAbort,
  chatHistory,
  chatSessionCreate,
  chatSessionDelete,
  chatSend,
} from '../methods/chat.js';
import { setCopilotRuntimeForTests } from './controller.js';
import { testController } from './test-helpers.js';

test('existing chat entry points use one tmux runtime and preserve streaming/history/session APIs', async () => {
  process.env.NODE_ENV = 'test';
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-compatibility-'));
  const emitted: Array<{ event: string; payload: unknown }> = [];
  let deliveredInstruction = '';
  const { controller, tmux } = testController({
    home,
    checkout: process.cwd(),
    emit: (event, payload) => emitted.push({ event, payload }),
    sendInstruction: async (_vars, _target, _runner, instruction) => {
      deliveredInstruction = instruction;
      return true;
    },
  });
  setCopilotRuntimeForTests(controller);

  await controller.start({ runner: 'cursor', model: 'test-model' });
  const contextual = chatSessionCreate({ title: 'Contextual Ask Co-Pilot' }).session;
  const sent = await chatSend(
    {
      sessionId: contextual.id,
      message: 'Explain the selected run',
      intent: 'general',
      clientContext: { route: 'run-detail', selectedRunId: 'run-1' },
    },
    () => undefined,
  );
  assert.equal(sent.delivery?.state, 'accepted');
  assert.match(deliveredInstruction, /Explain the selected run/);
  assert.match(deliveredInstruction, /Current Command Center View/);
  assert.match(deliveredInstruction, /"route": "run-detail"/);
  assert.match(deliveredInstruction, /"selectedRunId": "run-1"/);
  assert.equal(readLastScreenEvidence(contextual.id)?.selectedRunId, 'run-1');
  assert.equal(tmux.launchCount, 1);
  assert.deepEqual(chatHistory({ sessionId: contextual.id }).messages, getSessionMessages(contextual.id));
  assert.ok(emitted.some(({ event }) => event === Events.CHAT_RESPONSE));
  assert.deepEqual(await chatAbort({ sessionId: contextual.id }), { ok: true });

  const deleted = await chatSessionDelete({ sessionId: contextual.id });
  assert.deepEqual(deleted, { ok: true, deleted: true });
  assert.equal(tmux.launchCount, 1);

  await controller.stop({ reason: 'compatibility-test' });
  await assert.rejects(
    () => chatSend({ sessionId: 'global', message: 'must not fall back' }, () => undefined),
    /start or reconnect it before sending/,
  );
  assert.equal(tmux.launchCount, 1);
  setCopilotRuntimeForTests(null);
});
