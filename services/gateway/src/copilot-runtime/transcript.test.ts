import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getSessionMessages } from '../chat/chat-store.js';
import { normalizeTmuxTranscript, tmuxTranscriptMessage } from './transcript.js';
import { testController } from './test-helpers.js';

test('normalized tmux transcript has stable offset identity across restart', () => {
  const input = {
    runtimeId: 'gateway-copilot',
    offsetStart: 10,
    offsetEnd: 42,
    content: '\u001b[32mshared pane output\u001b[0m\r\nshared pane output\r\n',
    timestamp: '2026-08-12T00:00:00.000Z',
  };
  const first = tmuxTranscriptMessage(input);
  const afterRestart = tmuxTranscriptMessage(input);
  assert.ok(first);
  assert.equal(first.id, afterRestart?.id);
  assert.equal(first.source, 'tmux');
  assert.equal(first.content, 'shared pane output');
});

test('transcript ingestion redacts credentials and preserves direct pane text once', () => {
  const normalized = normalizeTmuxTranscript(
    'Acknowledge COPILOT_DIRECT_TMUX_PROOF once.\nAcknowledge COPILOT_DIRECT_TMUX_PROOF once.\n',
  );
  assert.equal(normalized.match(/COPILOT_DIRECT_TMUX_PROOF/g)?.length, 1);
  const message = tmuxTranscriptMessage({
    runtimeId: 'gateway-copilot',
    offsetStart: 0,
    offsetEnd: 100,
    content: 'authorization=Bearer ghp_12345678901234567890',
  });
  assert.ok(message);
  assert.doesNotMatch(message.content, /ghp_/);
  assert.match(message.content, /\[REDACTED\]/);
  assert.equal(normalizeTmuxTranscript('⏺\n✻\n────────────────\n❯\n'), '');
});

test('Command Center and direct canonical-tmux input share one ordered history across reconnect', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-shared-transcript-'));
  const sessionId = `manual:shared-${Date.now()}`;
  const first = testController({ home, checkout: process.cwd() });
  await first.controller.start({ runner: 'cursor', model: 'test-model' });
  await first.controller.send({ sessionId, message: 'COMMAND_CENTER_TRANSCRIPT_PROOF' });
  await appendFile(
    first.tmux.transcriptPath,
    'COPILOT_DIRECT_TMUX_PROOF\nCOPILOT_DIRECT_TMUX_PROOF\n',
  );
  await (
    first.controller as unknown as { pollTranscript(): Promise<void> }
  ).pollTranscript();
  await appendFile(first.tmux.transcriptPath, 'COPILOT_DIRECT_TMUX_PROOF\n');
  await (
    first.controller as unknown as { pollTranscript(): Promise<void> }
  ).pollTranscript();

  const beforeRestart = getSessionMessages(sessionId);
  assert.deepEqual(
    beforeRestart.map(({ role, source, content }) => ({ role, source, content })),
    [
      {
        role: 'user',
        source: 'command-center',
        content: 'COMMAND_CENTER_TRANSCRIPT_PROOF',
      },
      { role: 'assistant', source: 'tmux', content: 'COPILOT_DIRECT_TMUX_PROOF' },
    ],
  );

  const restarted = testController({ home, checkout: process.cwd(), tmux: first.tmux });
  await restarted.controller.initialize();
  const afterRestart = getSessionMessages(sessionId);
  assert.deepEqual(
    afterRestart.map(({ id }) => id),
    beforeRestart.map(({ id }) => id),
  );
  assert.equal((await restarted.controller.status()).session.transcriptId, sessionId);
  assert.equal(first.tmux.launchCount, 1);
  await restarted.controller.stop({ reason: 'transcript-test' });
});
