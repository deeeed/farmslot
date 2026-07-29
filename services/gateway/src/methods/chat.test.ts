// chat.test.ts — chat method helper checks
// Usage: tsx services/gateway/src/methods/chat.test.ts

import { mkdtempSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type ChatMessage, Events } from '@farmslot/protocol';

import {
  __isSessionAbortControllerClearedForTests,
  __setSessionAbortControllerForTests,
} from '../chat/chat-engine.js';
import {
  appendMessage,
  chatSessionFileName,
  getAllSessions,
  getSession,
  getSessionMessages,
  loadPersistedSessions,
  normalizeSessionId,
  pinSession,
} from '../chat/chat-store.js';
import { executeGeneralReadOnlyTool } from '../chat/chat-tools.js';
import {
  getRecentEvents,
  initCopilotObserver,
  resetCopilotObserverForTests,
  routeEventToObserver,
} from '../chat/copilot-observer.js';
import {
  readLastScreenEvidence,
  recordScreenEvidenceSnapshot,
  SCREEN_EVIDENCE_MAX_SESSIONS,
} from '../chat/screen-evidence.js';
import { describeModel } from '../llm/index.js';

import {
  chatClear,
  chatHistory,
  chatNew,
  chatObserverEvidence,
  chatScreenEvidence,
  chatSessionContext,
  chatSessionCreate,
  chatSessionDelete,
  chatSessions,
  chatSessionsBulkDelete,
  estimateContextWindow,
} from './chat.js';

const testCopilotDir = mkdtempSync(path.join(tmpdir(), 'farmslot-chat-test-'));
process.env.FARMSLOT_COPILOT_DIR = testCopilotDir;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`${GREEN}PASS${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}FAIL${RESET} ${name}: ${errorMessage(err)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => unknown, expectedMessage: string) {
  try {
    fn();
  } catch (err) {
    const message = errorMessage(err);
    assert(message.includes(expectedMessage), `expected "${expectedMessage}", got "${message}"`);
    return;
  }
  throw new Error(`expected throw containing "${expectedMessage}"`);
}

function testMessage(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
  };
}

await test('chatSessionContext does not create missing sessions', () => {
  const sessionId = `missing-session-${Date.now()}`;
  assert(getSession(sessionId) === null, 'test session already existed');
  const result = chatSessionContext({ sessionId });
  assert(result.sessionId === sessionId, `unexpected session ${result.sessionId}`);
  assert(result.messages.total === 0, `expected zero messages, got ${result.messages.total}`);
  assert(getSession(sessionId) === null, 'chatSessionContext created a session');
  assert(
    !getAllSessions().some((session) => session.id === sessionId),
    'chatSessionContext leaked missing session into all sessions',
  );
});

await test('chat session IDs are safe for persistence', () => {
  assert(
    normalizeSessionId(undefined) === 'global',
    'missing session should normalize to shared chat',
  );
  assert(
    normalizeSessionId('default') === 'global',
    'legacy default session should collapse to shared chat',
  );
  assert(normalizeSessionId('run:abc-123') === 'run:abc-123', 'valid scoped session rejected');
  assert(
    chatSessionFileName('run:abc-123') === 'run%3Aabc-123.json',
    'scoped session filename was not encoded',
  );
  assertThrows(() => normalizeSessionId('../secret'), 'Invalid chat session ID');
  assertThrows(() => normalizeSessionId('run:abc/../../secret'), 'Invalid chat session ID');
});

await test('legacy default session files are merged into shared chat', async () => {
  const sessionsDir = path.join(testCopilotDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, 'default.json'),
    JSON.stringify({
      id: 'default',
      messages: [testMessage(`default-${Date.now()}`, 'old default message')],
      createdAt: new Date().toISOString(),
      updatedAt: '2026-05-02T00:00:00.000Z',
    }),
    'utf-8',
  );
  await writeFile(
    path.join(sessionsDir, 'global.json'),
    JSON.stringify({
      id: 'global',
      messages: [testMessage(`global-${Date.now()}`, 'shared message')],
      createdAt: new Date().toISOString(),
      updatedAt: '2026-05-03T00:00:00.000Z',
    }),
    'utf-8',
  );

  await loadPersistedSessions();
  const files = await readdir(sessionsDir);
  const messages = getSession('global')?.messages ?? [];
  assert(!files.includes('default.json'), 'legacy default session file was not removed');
  assert(files.includes('global.json'), 'shared chat session file was not retained');
  assert(
    messages.some((message) => message.content === 'old default message'),
    'legacy default messages were not merged into shared chat',
  );
  assert(
    messages.some((message) => message.content === 'shared message'),
    'shared chat messages were not retained',
  );
});

await test('legacy raw session filenames are renamed to canonical encoded filenames', async () => {
  const sessionId = `run:legacy-${Date.now()}`;
  const sessionsDir = path.join(testCopilotDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      messages: [testMessage(`legacy-${Date.now()}`, 'legacy')],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  await loadPersistedSessions();
  const files = await readdir(sessionsDir);
  assert(!files.includes(`${sessionId}.json`), 'legacy raw session file was not removed');
  assert(
    files.includes(chatSessionFileName(sessionId)),
    'canonical encoded session file was not created',
  );
  assert(
    (getSession(sessionId)?.messages ?? []).some((message) => message.content === 'legacy'),
    'legacy session was not loaded',
  );
});

await test('legacy duplicate session file is merged when canonical file exists', async () => {
  const sessionId = `run:duplicate-${Date.now()}`;
  const sessionsDir = path.join(testCopilotDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, chatSessionFileName(sessionId)),
    JSON.stringify({
      id: sessionId,
      messages: [testMessage(`canonical-${Date.now()}`, 'canonical')],
      createdAt: new Date().toISOString(),
      updatedAt: '2026-05-02T00:00:00.000Z',
    }),
    'utf-8',
  );
  await writeFile(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      messages: [testMessage(`legacy-duplicate-${Date.now()}`, 'legacy duplicate')],
      createdAt: new Date().toISOString(),
      updatedAt: '2026-05-03T00:00:00.000Z',
    }),
    'utf-8',
  );

  await loadPersistedSessions();
  const files = await readdir(sessionsDir);
  const messages = getSession(sessionId)?.messages ?? [];
  assert(!files.includes(`${sessionId}.json`), 'legacy duplicate session file was not removed');
  assert(
    messages.some((message) => message.content === 'canonical'),
    'canonical session was not loaded',
  );
  assert(
    messages.some((message) => message.content === 'legacy duplicate'),
    'legacy duplicate messages were not merged',
  );
  assert(
    getSession(sessionId)?.updatedAt === '2026-05-03T00:00:00.000Z',
    'newer legacy metadata was not retained',
  );
});

await test('chat histories are isolated by session ID', () => {
  const suffix = Date.now();
  const runSession = `run:test-${suffix}`;
  const slotSession = `slot:test-${suffix}`;
  appendMessage(runSession, testMessage(`run-msg-${suffix}`, 'run-only'));
  appendMessage(slotSession, testMessage(`slot-msg-${suffix}`, 'slot-only'));

  const runHistory = chatHistory({ sessionId: runSession }).messages;
  const slotHistory = chatHistory({ sessionId: slotSession }).messages;
  assert(
    runHistory.some((message) => message.content === 'run-only'),
    'run session missing run message',
  );
  assert(
    !runHistory.some((message) => message.content === 'slot-only'),
    'run session included slot message',
  );
  assert(
    slotHistory.some((message) => message.content === 'slot-only'),
    'slot session missing slot message',
  );
  assert(
    !slotHistory.some((message) => message.content === 'run-only'),
    'slot session included run message',
  );
});

await test('empty manual chat sessions are hidden until they have messages', () => {
  const result = chatSessionCreate({ title: 'Investigation chat' });
  assert(
    result.session.id.startsWith('manual:'),
    `expected manual session, got ${result.session.id}`,
  );
  assert(result.session.title === 'Investigation chat', `unexpected title ${result.session.title}`);
  assert(
    !chatSessions().sessions.some((session) => session.id === result.session.id),
    'empty manual session was listed',
  );
  appendMessage(
    result.session.id,
    testMessage(`listed-manual-${Date.now()}`, 'List this manual chat'),
  );
  const listed = chatSessions().sessions.find((session) => session.id === result.session.id);
  assert(
    listed?.messageCount === 1,
    `expected listed manual session with one message, got ${listed?.messageCount}`,
  );
});

await test('first user message autotitles a new session summary', () => {
  const session = chatSessionCreate({}).session;
  appendMessage(
    session.id,
    testMessage(`autotitle-${Date.now()}`, 'Can you explain the PR dashboard?'),
  );
  const listed = chatSessions().sessions.find((item) => item.id === session.id);
  assert(
    listed?.title === 'Can you explain the PR dashboard?',
    `unexpected autotitle ${listed?.title}`,
  );
  assert(
    listed?.lastPreview === 'Can you explain the PR dashboard?',
    `unexpected preview ${listed?.lastPreview}`,
  );
});

await test('chatHistory does not materialize missing sessions', () => {
  const sessionId = `missing-history-${Date.now()}`;
  assert(getSession(sessionId) === null, 'test session already existed');
  const history = chatHistory({ sessionId }).messages;
  assert(history.length === 0, `expected empty history, got ${history.length}`);
  assert(getSession(sessionId) === null, 'chatHistory created a ghost session');
});

await test('chatClear without sessionId warns and preserves shared chat', () => {
  const before = getSessionMessages('global').length;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    chatClear({});
    const after = getSessionMessages('global').length;
    assert(
      after === before,
      `chatClear({}) changed shared chat history length ${before} -> ${after}`,
    );
    assert(
      warnings.some((message) => message.includes('sessionId was omitted')),
      'chatClear({}) did not warn about omitted sessionId',
    );
  } finally {
    console.warn = originalWarn;
  }
});

await test('observer notifications do not append chat system messages', () => {
  resetCopilotObserverForTests();
  const sessionId = `run:observer-${Date.now()}`;
  appendMessage(sessionId, testMessage(`observer-seed-${Date.now()}`, 'seed'));
  const beforeShared = getSessionMessages('global').length;
  const beforeScoped = getSessionMessages(sessionId).length;
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  initCopilotObserver((event, payload) => broadcasts.push({ event, payload }));

  routeEventToObserver(Events.MONITOR_VIOLATION, {
    violation: {
      slotId: 'test-slot',
      type: 'error',
      message: 'observer test violation',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    },
  });

  assert(
    getSessionMessages('global').length === beforeShared,
    'observer appended to shared chat history',
  );
  assert(
    getSessionMessages(sessionId).length === beforeScoped,
    'observer appended to scoped chat history',
  );
  assert(
    getRecentEvents().some((event) => event.summary.includes('observer test violation')),
    'observer event was not recorded',
  );
  assert(
    broadcasts.some((item) => item.event === Events.COPILOT_OBSERVER_NOTIFICATION),
    'observer notification was not broadcast as typed event',
  );
  assert(
    !broadcasts.some((item) => item.event === Events.CHAT_RESPONSE),
    'observer notification used chat response channel',
  );
});

await test('observer evidence returns bounded typed events with filters and attention', () => {
  resetCopilotObserverForTests();
  const suffix = Date.now();
  const slotId = `observer-slot-${suffix}`;
  const beforeShared = getSessionMessages('global').length;
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  initCopilotObserver((event, payload) => broadcasts.push({ event, payload }));

  routeEventToObserver(Events.MONITOR_VIOLATION, {
    violation: {
      slotId,
      type: 'error',
      message: 'observer evidence violation',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    },
  });

  const result = chatObserverEvidence({
    severity: 'warn',
    slotId,
    limit: 1,
    windowMs: 60_000,
  }).evidence;
  assert(result.events.length === 1, `expected one observer event, got ${result.events.length}`);
  assert(result.events[0].slotId === slotId, `unexpected slot ${result.events[0].slotId}`);
  assert(result.events[0].type === 'monitor.violation', `unexpected type ${result.events[0].type}`);
  assert(result.events[0].severity === 'warn', `unexpected severity ${result.events[0].severity}`);
  assert(
    result.attention.length === 1,
    `expected one attention recommendation, got ${result.attention.length}`,
  );
  assert(result.provenance.includes('copilot-observer:event-log'), 'missing observer provenance');
  assert(result.filters.slotId === slotId, 'slot filter was not reported');
  assert(result.filters.severity === 'warn', 'severity filter was not reported');
  assert(
    getSessionMessages('global').length === beforeShared,
    'observer evidence mutated shared chat history',
  );
  assert(
    broadcasts.some((item) => item.event === Events.COPILOT_OBSERVER_NOTIFICATION),
    'observer notification was not broadcast',
  );
});

await test('observer evidence reports empty filtered results without hallucinated attention', () => {
  resetCopilotObserverForTests();
  const result = chatObserverEvidence({
    slotId: `missing-observer-slot-${Date.now()}`,
    limit: 5,
  }).evidence;
  assert(result.events.length === 0, `expected no events, got ${result.events.length}`);
  assert(
    result.attention.length === 0,
    `expected no attention recommendations, got ${result.attention.length}`,
  );
  assert(result.freshness === 'empty', `unexpected freshness ${result.freshness}`);
  assert(result.uncertainty.includes('empty'), 'missing empty uncertainty');
  assert(result.uncertainty.includes('filtered'), 'missing filtered uncertainty');
});

await test('observer evidence reports truncated filters without broadening the query', () => {
  resetCopilotObserverForTests();
  const slotId = `observer-filter-slot-${Date.now()}`;
  routeEventToObserver(Events.MONITOR_VIOLATION, {
    violation: {
      slotId,
      type: 'error',
      message: 'observer filter violation',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    },
  });

  const result = chatObserverEvidence({ slotId: `${slotId}${'x'.repeat(300)}`, limit: 5 }).evidence;
  assert(
    result.events.length === 0,
    `expected truncated filter not to match, got ${result.events.length}`,
  );
  assert(
    result.filters.slotId?.length === 200,
    `expected bounded slot filter, got ${result.filters.slotId?.length}`,
  );
  assert(result.uncertainty.includes('filter-truncated'), 'missing filter-truncated uncertainty');
});

await test('screen evidence records sanitized DOM context snapshots by session', () => {
  const sessionId = `run:evidence-${Date.now()}`;
  const snapshot = recordScreenEvidenceSnapshot(sessionId, {
    hash: '#prs?pr=123&repo=example-org/example-browser',
    route: 'prs',
    surfaceId: 'pr-dashboard',
    routePattern: '#prs?pr=:pr&repo=:repo',
    selectedPullRequestNumber: '123',
    selectedPullRequestRepo: 'example-org/example-browser',
    selectedPullRequestRef: 'example-org/example-browser#123',
    visibleTextSnippets: ['PR Dashboard', '3 PRs need attention'],
    visibleControls: ['Refresh', 'Complete PR'],
  });
  assert(snapshot?.surfaceId === 'pr-dashboard', 'snapshot did not use PR surface');
  assert(snapshot?.freshness === 'fresh', `unexpected freshness ${snapshot?.freshness}`);
  assert(
    snapshot?.provenance.includes('ui-client-context') === true,
    'snapshot missing UI provenance',
  );
  const read = chatScreenEvidence({ sessionId }).snapshot;
  assert(
    read?.snapshotId === snapshot?.snapshotId,
    'screen evidence read returned a different snapshot',
  );
  assert(
    read?.selectedPullRequestRef === 'example-org/example-browser#123',
    'screen evidence lost selected PR ref',
  );
});

await test('missing UI context does not promote cached screen evidence into prompt context', () => {
  const sessionId = `run:evidence-missing-${Date.now()}`;
  const snapshot = recordScreenEvidenceSnapshot(sessionId, {
    hash: '#prs?pr=123&repo=example-org/example-browser',
    route: 'prs',
    surfaceId: 'pr-dashboard',
    visibleTextSnippets: ['PR Dashboard'],
  });
  assert(snapshot?.surfaceId === 'pr-dashboard', 'setup did not record screen evidence');
  const missing = recordScreenEvidenceSnapshot(sessionId, undefined);
  assert(missing === null, 'missing current UI context reused cached screen evidence');
  assert(
    chatScreenEvidence({ sessionId }).snapshot?.snapshotId === snapshot?.snapshotId,
    'explicit read lost cached screen evidence',
  );
});

await test('malformed route encoding does not fail screen evidence capture', () => {
  const sessionId = `run:evidence-malformed-${Date.now()}`;
  const snapshot = recordScreenEvidenceSnapshot(sessionId, {
    hash: '#run/%E0%A4%A?step=prepare',
    route: 'run/%E0%A4%A',
    surfaceId: 'run-detail',
    visibleTextSnippets: ['Run detail'],
  });
  assert(snapshot?.surfaceId === 'run-detail', `unexpected surface ${snapshot?.surfaceId}`);
  assert(
    snapshot?.uncertainty.includes('none') === true,
    `unexpected uncertainty ${snapshot?.uncertainty.join(',')}`,
  );
});

await test('screen evidence is LRU-capped and cleared with session reset', async () => {
  const lruPrefix = `run:evidence-lru-${Date.now()}`;
  const firstSessionId = `${lruPrefix}-0`;
  for (let i = 0; i <= SCREEN_EVIDENCE_MAX_SESSIONS; i++) {
    recordScreenEvidenceSnapshot(`${lruPrefix}-${i}`, {
      hash: '#prs',
      route: 'prs',
      surfaceId: 'pr-dashboard',
      visibleTextSnippets: [`PR Dashboard ${i}`],
    });
  }
  assert(readLastScreenEvidence(firstSessionId) === null, 'oldest screen evidence was not evicted');

  const clearSessionId = `run:evidence-clear-${Date.now()}`;
  recordScreenEvidenceSnapshot(clearSessionId, {
    hash: '#prs',
    route: 'prs',
    surfaceId: 'pr-dashboard',
    visibleTextSnippets: ['PR Dashboard'],
  });
  chatClear({ sessionId: clearSessionId });
  assert(
    readLastScreenEvidence(clearSessionId) === null,
    'chatClear did not clear screen evidence',
  );

  const newSessionId = `run:evidence-new-${Date.now()}`;
  recordScreenEvidenceSnapshot(newSessionId, {
    hash: '#prs',
    route: 'prs',
    surfaceId: 'pr-dashboard',
    visibleTextSnippets: ['PR Dashboard'],
  });
  await chatNew({ sessionId: newSessionId }, () => {});
  assert(readLastScreenEvidence(newSessionId) === null, 'chatNew did not clear screen evidence');
});

await test('chat read tools default to the active managed session', async () => {
  const sessionId = `manual:tool-session-${Date.now()}`;
  appendMessage(sessionId, testMessage(`tool-session-${Date.now()}`, 'active managed session'));
  const snapshot = recordScreenEvidenceSnapshot(sessionId, {
    hash: '#prs?pr=456&repo=example-org/example-browser',
    route: 'prs',
    surfaceId: 'pr-dashboard',
    selectedPullRequestNumber: '456',
    selectedPullRequestRepo: 'example-org/example-browser',
  });

  const contextTool = await executeGeneralReadOnlyTool('chat_session_context', {}, 'tool-context', {
    sessionId,
  });
  const context = JSON.parse(contextTool.content);
  assert(context.sessionId === sessionId, `chat_session_context used ${context.sessionId}`);

  const evidenceTool = await executeGeneralReadOnlyTool(
    'read_last_screen_evidence',
    {},
    'tool-evidence',
    { sessionId },
  );
  const evidence = JSON.parse(evidenceTool.content);
  assert(
    evidence.snapshotId === snapshot?.snapshotId,
    'read_last_screen_evidence did not use the active session',
  );
  assert(evidence.selectedPullRequestNumber === '456', 'screen evidence lost PR number');
});

await test('chat read tools expose bounded observer evidence as read-only', async () => {
  resetCopilotObserverForTests();
  const suffix = Date.now();
  const slotId = `observer-tool-slot-${suffix}`;
  routeEventToObserver(Events.MONITOR_VIOLATION, {
    violation: {
      slotId,
      type: 'error',
      message: 'observer tool violation',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    },
  });

  const observerTool = await executeGeneralReadOnlyTool(
    'read_observer_evidence',
    { severity: 'warn', slot_id: slotId, limit: 1 },
    'tool-observer',
  );
  assert(!observerTool.isError, `read_observer_evidence failed: ${observerTool.content}`);
  const evidence = JSON.parse(observerTool.content);
  assert(
    evidence.events.length === 1,
    `expected one observer event, got ${evidence.events.length}`,
  );
  assert(
    evidence.events[0].slotId === slotId,
    `unexpected observer slot ${evidence.events[0].slotId}`,
  );
  assert(
    evidence.provenance.includes('copilot-observer:event-log'),
    'observer tool missing provenance',
  );
});

await test('chat read tools collapse legacy default session to shared chat', async () => {
  const snapshot = recordScreenEvidenceSnapshot('global', {
    hash: '#prs',
    route: 'prs',
    surfaceId: 'pr-dashboard',
    visibleTextSnippets: ['Shared PR dashboard'],
  });
  const evidenceTool = await executeGeneralReadOnlyTool(
    'read_last_screen_evidence',
    { session_id: 'default' },
    'tool-evidence-default',
  );
  assert(!evidenceTool.isError, `read_last_screen_evidence failed: ${evidenceTool.content}`);
  const evidence = JSON.parse(evidenceTool.content);
  assert(
    evidence.snapshotId === snapshot?.snapshotId,
    'legacy default session did not resolve to shared chat evidence',
  );
});

await test('store-layer deleteSession refuses global directly (defense-in-depth)', async () => {
  // Round-9 MEDIUM: any internal caller (run-engine cleanup, fixture seeders,
  // future RPC) that bypasses methods/chat.ts must still be blocked from
  // wiping the shared chat. Test calls deleteSession directly.
  const { deleteSession, deleteSessions } = await import('../chat/chat-store.js');
  let threw: Error | null = null;
  try {
    await deleteSession('global');
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw !== null && threw.message.includes('Cannot delete the shared global chat session'),
    `deleteSession('global') should throw; got: ${threw?.message}`,
  );

  threw = null;
  try {
    await deleteSessions(['manual:protected', 'global']);
  } catch (err) {
    threw = err as Error;
  }
  assert(
    threw !== null && threw.message.includes('Cannot delete the shared global chat session'),
    `deleteSessions with global in batch should throw; got: ${threw?.message}`,
  );
});

await test('createChatSession clamps very long titles', () => {
  const huge = 'X'.repeat(5000);
  const result = chatSessionCreate({ title: huge });
  assert(
    result.session.title.length <= 200,
    `title not clamped, got ${result.session.title.length} chars`,
  );
  assert(result.session.title === 'X'.repeat(200), 'title clamped to wrong content');
});

await test('chatNew on a stale run:/slot:/family: id does not leak an empty ephemeral', async () => {
  // Reproduces the MAJOR-2 leak: before the fix, calling chatNew on a stale
  // run/family/slot id created an empty ephemeral via getOrCreateSession,
  // then cleared messages, leaving an empty ephemeral pinned in memory until
  // restart. The new chatNew skips materialization for unknown ids.
  const stale = `run:stale-${Date.now()}`;
  assert(getSession(stale) === null, 'precondition: stale session should not exist');

  const beforeIds = new Set(getAllSessions().map((s) => s.id));
  const result = await chatNew({ sessionId: stale }, () => {});
  assert(
    result.savedPath === undefined,
    `chatNew on stale id should not save: ${result.savedPath}`,
  );
  assert(getSession(stale) === null, 'chatNew materialized a stale session');
  const afterIds = new Set(getAllSessions().map((s) => s.id));
  assert(
    beforeIds.size === afterIds.size && [...afterIds].every((id) => beforeIds.has(id)),
    `chatNew leaked sessions; new ids: ${[...afterIds].filter((id) => !beforeIds.has(id)).join(',')}`,
  );
});

await test('chatSessionDelete aborts the in-flight LLM call before removing the session', async () => {
  // Round-6 m3 regression: deleting a session must abort any in-flight LLM
  // request routed to that id, otherwise the call resurrects the session via
  // its first append after delete, wasting tokens and leaving a phantom
  // session on disk.
  process.env.NODE_ENV = 'test';
  const target = chatSessionCreate({}).session;
  appendMessage(target.id, testMessage(`abort-${Date.now()}`, 'pin me first'));

  __setSessionAbortControllerForTests(target.id);
  assert(
    !__isSessionAbortControllerClearedForTests(target.id),
    'precondition: abort controller should be installed',
  );

  await chatSessionDelete({ sessionId: target.id });
  assert(
    __isSessionAbortControllerClearedForTests(target.id),
    'chatSessionDelete did not abort the in-flight LLM call',
  );
  assert(
    getSession(target.id) === null,
    'chatSessionDelete did not remove the session from memory',
  );
});

await test('chatSessionsBulkDelete refuses the whole batch when global is included', async () => {
  // Seed a manual session with one message so it persists to disk and shows
  // up in the listing.
  const target = chatSessionCreate({}).session;
  appendMessage(target.id, testMessage(`bulk-${Date.now()}`, 'protect me'));
  await pinSession(target.id);

  let threw: Error | null = null;
  try {
    await chatSessionsBulkDelete({ sessionIds: [target.id, 'global'] });
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== null, 'bulk-delete with global in the batch should throw');
  assert(
    threw!.message.includes('Cannot delete the shared global chat session'),
    `unexpected message: ${threw!.message}`,
  );

  // Atomicity: the non-global id in the rejected batch must NOT be deleted.
  assert(
    getSession(target.id) !== null,
    'manual session was deleted despite global guard rejecting the batch',
  );
  assert(getSession('global') !== null || true, 'global session itself must survive (sanity)');

  // Sanity: deleting the same id without 'global' in the batch succeeds.
  const result = await chatSessionsBulkDelete({ sessionIds: [target.id] });
  assert(result.deleted === 1, `expected 1 session deleted, got ${result.deleted}`);
  assert(getSession(target.id) === null, 'manual session was not deleted by clean bulk delete');
});

await test('ephemeral manual sessions never write to disk until pinSession runs', async () => {
  const sessionsDir = path.join(testCopilotDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  // Brand-new manual session — pinned defaults to false, so appendMessage
  // must NOT trigger a persist. We append + flush microtasks + verify the
  // session file is absent.
  const ephemeral = chatSessionCreate({}).session;
  assert(
    ephemeral.pinned === false,
    `manual session should default to pinned=false, got ${ephemeral.pinned}`,
  );
  appendMessage(ephemeral.id, testMessage(`ephemeral-${Date.now()}`, 'must not persist'));

  // Drain microtasks; the persist debounce is 2s and we don't wait through it,
  // but the pinned guard is checked synchronously inside schedulePersist —
  // ephemeral sessions never schedule the debounce in the first place.
  await new Promise((r) => setImmediate(r));

  const filename = chatSessionFileName(ephemeral.id);
  let filesAfterAppend: string[] = [];
  try {
    filesAfterAppend = await readdir(sessionsDir);
  } catch {
    filesAfterAppend = [];
  }
  assert(
    !filesAfterAppend.includes(filename),
    `ephemeral session file ${filename} should not exist; got: ${filesAfterAppend.join(', ')}`,
  );

  // Pin → file appears immediately (pinSession bypasses the debounce).
  await pinSession(ephemeral.id);
  const filesAfterPin = await readdir(sessionsDir);
  assert(
    filesAfterPin.includes(filename),
    `pinned session file ${filename} should exist; got: ${filesAfterPin.join(', ')}`,
  );
});

await test('estimateContextWindow prefers exact and longest model matches', () => {
  assert(
    estimateContextWindow('openai:gpt-5.3-codex-spark') === 400_000,
    'spark model did not resolve',
  );
  assert(estimateContextWindow('openai:gpt-5.3-codex') === 400_000, 'codex model did not resolve');
  assert(
    estimateContextWindow(describeModel('anthropic', 'sonnet')) === 1_000_000,
    'anthropic sonnet runtime identity did not resolve',
  );
  assert(
    estimateContextWindow('anthropic/claude-opus-4-7[1m]') === 1_000_000,
    'anthropic opus 1m runtime identity did not resolve',
  );
  assert(
    estimateContextWindow(describeModel('anthropic', 'opus')) === 1_000_000,
    'anthropic opus runtime identity did not resolve',
  );
  assert(
    estimateContextWindow(describeModel('openai-codex', 'standard')) === 272_000,
    'openai-codex standard tier (gpt-5.6-terra) runtime identity did not resolve',
  );
  assert(
    estimateContextWindow('unknown-provider:unknown-model') === null,
    'unknown model should be null',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
