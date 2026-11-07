import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendMessage, getSessionMessages } from '../chat/chat-store.js';

import { COPILOT_TMUX_SESSION } from './launcher.js';
import { CopilotRuntimeStore } from './session-store.js';
import { FakeCopilotTmux, testController } from './test-helpers.js';

test('opening or starting never adopts/replaces an active TUI; explicit stop preserves its history', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-legacy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const seed = testController({ home, checkout: home });
  await seed.controller.status();
  const store = new CopilotRuntimeStore(home);
  const record = (await store.load())!;
  record.session.status = 'running';
  await store.save(record);
  const tmux = new FakeCopilotTmux();
  tmux.sessions.add(COPILOT_TMUX_SESSION);
  const { controller, native } = testController({ home, checkout: home, tmux });
  const archive = `legacy-${path.basename(home)}`;
  appendMessage(archive, {
    id: 'old-message',
    role: 'assistant',
    content: 'immutable old response',
    timestamp: '2026-11-05T00:00:00Z',
  });
  const before = structuredClone(getSessionMessages(archive));
  const status = await controller.status();
  assert.equal(status.session.nativeSession, undefined);
  assert.equal(native.launches, 0);
  await assert.rejects(controller.start(), /legacy Co-Pilot terminal/);
  assert.equal(tmux.killCount, 0);
  assert.deepEqual(getSessionMessages(archive), before);
  await controller.stop();
  assert.equal(tmux.killCount, 1);
  assert.deepEqual(getSessionMessages(archive), before);
  await controller.start();
  assert.equal(native.launches, 1);
  await controller.stop();
});

test('passive status never launches, resumes or sends, including when a bound host is unavailable', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-passive-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = 0;
  const { controller, native } = testController({ home, checkout: home, now: () => new Date(now) });
  await controller.status();
  assert.equal(native.launches, 0);
  assert.equal(native.sends.size, 0);
  await controller.start();
  native.inspect = async () => {
    throw new Error('Host unavailable; refresh in login context');
  };
  now += 5_001;
  const status = await controller.status();
  assert.equal(status.session.status, 'reconnecting');
  assert.match(status.session.terminalReason ?? '', /Host unavailable/);
  assert.equal(native.launches, 1);
  assert.equal(native.sends.size, 1);
});
