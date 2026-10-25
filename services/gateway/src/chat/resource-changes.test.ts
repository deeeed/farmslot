import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type ChatSession, Events, type MonitorViolation } from '@farmslot/protocol';

import { resourceRevisions } from '../resources/revisions.js';

import {
  appendMessage,
  chatSessionFileName,
  clearSession,
  deleteSession,
  getSession,
  getSessionMessages,
  loadPersistedSessions,
} from './chat-store.js';
import {
  readObserverEvidence,
  resetCopilotObserverForTests,
  routeEventToObserver,
} from './copilot-observer.js';

const runtimeKey = { family: 'copilot', ownerId: 'gateway-copilot' } as const;

test('conversation usage writers publish the exact readable session, including clear and delete', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-context-writers-'));
  const original = process.env.FARMSLOT_COPILOT_DIR;
  process.env.FARMSLOT_COPILOT_DIR = home;
  t.after(async () => {
    if (original === undefined) delete process.env.FARMSLOT_COPILOT_DIR;
    else process.env.FARMSLOT_COPILOT_DIR = original;
    await rm(home, { recursive: true, force: true });
  });
  const sessionId = 'manual:canonical-copilot-context';
  const key = { ...runtimeKey, sessionId };
  const other = { ...runtimeKey, sessionId: 'manual:unrelated-copilot-context' };
  const before = resourceRevisions.revision(key);
  const unrelated = resourceRevisions.revision(other);
  appendMessage(sessionId, {
    id: 'usage-message',
    role: 'assistant',
    content: 'Usage belongs to this session.',
    timestamp: '2026-10-24T00:00:00Z',
    usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.5 },
  });
  assert(resourceRevisions.revision(key) > before);
  assert.equal(getSessionMessages(sessionId)[0]?.usage?.inputTokens, 12);
  assert.equal(resourceRevisions.revision(other), unrelated);
  const appended = resourceRevisions.revision(key);
  clearSession(sessionId);
  assert(resourceRevisions.revision(key) > appended);
  assert.deepEqual(getSessionMessages(sessionId), []);
  const cleared = resourceRevisions.revision(key);
  await deleteSession(sessionId);
  assert(resourceRevisions.revision(key) > cleared);
  assert.equal(resourceRevisions.revision(other), unrelated);
});

test('restoring a real session source publishes its readable usage under only the exact session key', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-restored-resource-'));
  const original = process.env.FARMSLOT_COPILOT_DIR;
  process.env.FARMSLOT_COPILOT_DIR = home;
  t.after(async () => {
    if (original === undefined) delete process.env.FARMSLOT_COPILOT_DIR;
    else process.env.FARMSLOT_COPILOT_DIR = original;
    await rm(home, { recursive: true, force: true });
  });
  const sessionId = 'manual:restored-resource-source';
  const key = { ...runtimeKey, sessionId };
  const unrelated = { ...runtimeKey, sessionId: 'manual:unrelated-restored-source' };
  const session: ChatSession = {
    id: sessionId,
    title: 'Restored source',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    messages: [
      {
        id: 'restored-usage-message',
        role: 'assistant',
        content: 'Private restored context bytes.',
        timestamp: '2026-10-26T00:00:00.000Z',
        usage: { inputTokens: 37, outputTokens: 8, costUsd: 0.5 },
      },
    ],
  };
  const directory = path.join(home, 'sessions');
  await mkdir(directory);
  const file = path.join(directory, chatSessionFileName(sessionId));
  const bytes = JSON.stringify(session);
  await writeFile(file, bytes, { flag: 'wx' });
  const before = resourceRevisions.revision(key);
  const beforeUnrelated = resourceRevisions.revision(unrelated);
  const beforeRuntime = resourceRevisions.revision(runtimeKey);
  const keys: unknown[] = [];
  const advance = resourceRevisions.advance.bind(resourceRevisions);
  const publication = t.mock.method(
    resourceRevisions,
    'advance',
    (...args: Parameters<typeof resourceRevisions.advance>) => {
      assert.deepEqual(args[0], key);
      assert.deepEqual(getSession(sessionId), { ...session, pinned: true });
      assert.equal(readFileSync(file, 'utf8'), bytes, 'The existing source is already readable');
      keys.push(structuredClone(args[0]));
      advance(...args);
    },
  );
  try {
    await loadPersistedSessions();
    assert.equal(resourceRevisions.revision(key), before + 1);
    assert.deepEqual(keys, [key]);
    assert.equal(getSessionMessages(sessionId)[0]?.usage?.inputTokens, 37);
    assert.equal(resourceRevisions.revision(unrelated), beforeUnrelated);
    assert.equal(resourceRevisions.revision(runtimeKey), beforeRuntime);
    assert(!JSON.stringify(keys).includes(home));
    assert(!JSON.stringify(keys).includes(session.messages[0].content));
  } finally {
    publication.mock.restore();
    await deleteSession(sessionId);
  }
});

test('observer evidence changes on source writes and time expiry, never resource.changed itself', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-24T00:00:00Z') });
  resetCopilotObserverForTests();
  t.after(() => {
    resourceRevisions.scheduleInvalidation('copilot-observer-window:1000', runtimeKey, undefined);
    resetCopilotObserverForTests();
  });
  const violation: MonitorViolation = {
    slotId: 'source-slot',
    type: 'error',
    message: 'Actual source violation',
    nudgeSent: null,
    timestamp: new Date().toISOString(),
  };
  const before = resourceRevisions.revision(runtimeKey);
  routeEventToObserver(Events.MONITOR_VIOLATION, { violation });
  assert(resourceRevisions.revision(runtimeKey) > before);
  assert.equal(readObserverEvidence({ windowMs: 1000 }).events.length, 1);
  const sourceRevision = resourceRevisions.revision(runtimeKey);
  routeEventToObserver(Events.RESOURCE_CHANGED, { version: 1, epoch: 'test', changes: [] });
  assert.equal(resourceRevisions.revision(runtimeKey), sourceRevision);
  t.mock.timers.tick(1000);
  assert(resourceRevisions.revision(runtimeKey) > sourceRevision);
  assert.deepEqual(readObserverEvidence({ windowMs: 1000 }).events, []);
});
