import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { NativeSessionEvent, NativeSessionInfo } from '@farmslot/protocol';

import {
  allEvents,
  appendLateEvent,
  sessionRecordOf,
  setup,
  testRepository,
} from './durability.test-support.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';

const ID = '11111111-2222-4333-8444-555555555555';

async function closedSession(manager: NativeSessionManager, cwd: string) {
  const session = await manager.create('owner', { runner: 'codex', cwd });
  await manager.close('owner', session.id);
  const { state, processStopped } = manager.read('owner', session.id).session;
  assert.equal(state, 'closed');
  assert.equal(processStopped, true);
  return session.id;
}

test('one-event reads keep the latest 100 receipts without scanning the command journal', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-receipt-window-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  const info: NativeSessionInfo = {
    id: ID,
    generation: 'receipt-generation',
    hostPid: process.pid,
    processStopped: true,
    runner: 'codex',
    nativeSessionId: ID,
    ownerPrincipalId: 'owner',
    executionNodeId: 'local',
    accountContextId: 'default',
    cwd: root,
    executable: 'codex',
    version: 'fixture',
    mode: 'default',
    accountMode: 'native',
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: true,
      interrupt: true,
      resume: true,
    },
    state: 'closed',
  };
  const event: NativeSessionEvent = {
    type: 'session.closed',
    sessionId: ID,
    generation: info.generation,
    sequence: 1,
    at: new Date().toISOString(),
  };
  const receipts = Array.from({ length: 120 }, (_, index) => ({
    commandId: `command-${index}`,
    generation: info.generation,
    text: 'private draft',
    state: 'completed',
    submitted: true,
    accepted: true,
  }));
  writeFileSync(
    join(state, `${ID}.journal`),
    [
      { info, context: {}, commands: receipts, event },
      { commands: [{ ...receipts[0], state: 'failed' }] },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
    { mode: 0o600 },
  );

  const replayed = new NativeSessionManager(state);
  const record = sessionRecordOf(replayed, ID);
  assert(record && typeof record === 'object');
  const commands: unknown = Reflect.get(record, 'commands');
  assert(commands instanceof Map);
  t.mock.method(commands, 'values', () => assert.fail('bounded read scanned the full command map'));
  const page = replayed.read('owner', ID, 0, 1);
  assert.equal(page.events.length, 1);
  assert.deepEqual(
    page.commands,
    receipts.slice(-100).map(({ text: _text, ...receipt }) => receipt),
  );
  assert.equal(replayed.commandStatus('owner', ID, 'command-0').receipt?.state, 'failed');
});

test('archiving moves a settled journal out of startup replay; live or unknown sessions are not', async () => {
  const fixture = setup();
  const { repo } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const closed = await closedSession(manager, repo);
    const open = (await manager.create('owner', { runner: 'codex', cwd: repo })).id;
    assert.deepEqual(manager.archiveSessions('owner', [closed, open, ID]), [
      { sessionId: closed, outcome: 'archived' },
      { sessionId: open, outcome: 'kept', reason: 'state idle' },
      { sessionId: ID, outcome: 'missing' },
    ]);
    assert.equal(existsSync(join(fixture.root, `${closed}.journal`)), false);
    assert.equal(existsSync(join(dirname(fixture.root), 'archive', `${closed}.journal`)), true);
    // Idempotent: asked again, it reports the archive, and another owner cannot archive.
    assert.deepEqual(manager.archiveSessions('owner', [closed]), [
      { sessionId: closed, outcome: 'already-archived' },
    ]);
    assert.deepEqual(manager.archiveSessions('other', [open]), [
      { sessionId: open, outcome: 'kept', reason: 'owned by another principal' },
    ]);
    await manager.close('owner', open);
    // A restarted host never replays the archived journal.
    const restarted = new NativeSessionManager(fixture.root);
    assert.deepEqual(
      restarted.list('owner').map((session) => session.id),
      [open],
    );
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a failed session whose process stop is unconfirmed is kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'native-archive-'));
  const root = join(home, 'state');
  try {
    new NativeSessionManager(root);
    const info = {
      id: ID,
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      runner: 'codex',
      cwd: home,
      state: 'failed',
      processPid: 2_000_000_000,
    };
    writeFileSync(join(root, `${ID}.journal`), `${JSON.stringify({ info, context: {} })}\n`, {
      mode: 0o600,
    });
    const manager = new NativeSessionManager(root);
    assert.deepEqual(manager.archiveSessions('owner', [ID]), [
      { sessionId: ID, outcome: 'kept', reason: 'process stop unconfirmed' },
    ]);
    assert.equal(existsSync(join(root, `${ID}.journal`)), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  'a restarted host replays a settled session only when something reads it',
  // An unreadable journal is what proves it was not read; root reads it anyway.
  { skip: process.getuid?.() === 0 },
  async () => {
    const fixture = setup();
    const { repo } = testRepository();
    const manager = new NativeSessionManager(fixture.root);
    const journal = (id: string) => join(fixture.root, `${id}.journal`);
    try {
      const closed = await closedSession(manager, repo);
      // The first restart replays the journal and records the settled session's summary.
      const first = new NativeSessionManager(fixture.root);
      const listed = first.list('owner');
      const events = allEvents(first, closed);
      // Later restarts do not read the journal: an unreadable one still starts and lists.
      chmodSync(journal(closed), 0o000);
      const second = new NativeSessionManager(fixture.root);
      assert.deepEqual(second.list('owner'), listed);
      // Reading it replays it then, with the same history as before.
      assert.throws(() => second.read('owner', closed));
      chmodSync(journal(closed), 0o600);
      assert.deepEqual(allEvents(second, closed), events);
      // A journal that changed after its summary is replayed in full at startup.
      writeFileSync(journal(closed), `${JSON.stringify({ context: { changed: '1' } })}\n`, {
        flag: 'a',
      });
      chmodSync(journal(closed), 0o000);
      assert.throws(() => new NativeSessionManager(fixture.root));
      chmodSync(journal(closed), 0o600);
      // Archiving also removes its summary.
      const third = new NativeSessionManager(fixture.root);
      assert.deepEqual(third.archiveSessions('owner', [closed]), [
        { sessionId: closed, outcome: 'archived' },
      ]);
      assert.equal(existsSync(join(fixture.root, 'summaries', `${closed}.json`)), false);
    } finally {
      fixture.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  },
);

test('host IPC decodes a bounded archive request of session IDs', () => {
  assert.deepEqual(decodeRequest({ method: 'archiveSessions', owner: 'owner', ids: [ID] }), {
    method: 'archiveSessions',
    owner: 'owner',
    ids: [ID],
  });
  for (const ids of [undefined, ['../x'], Array.from({ length: 51 }, () => ID)])
    assert.throws(
      () => decodeRequest({ method: 'archiveSessions', owner: 'owner', ids }),
      /Invalid IPC ids/,
    );
});

test('an archived session stays archived: no late write, no reuse of its id, no overwrite', async () => {
  const fixture = setup();
  const { repo } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const closed = await closedSession(manager, repo);
    const record = sessionRecordOf(manager, closed);
    assert.deepEqual(manager.archiveSessions('owner', [closed]), [
      { sessionId: closed, outcome: 'archived' },
    ]);
    // A late event from its stopped adapter does not recreate the journal in startup replay.
    appendLateEvent(manager, record, 'session.closed');
    assert.equal(existsSync(join(fixture.root, `${closed}.journal`)), false);
    new NativeSessionManager(fixture.root);
    // Its reserved id is never reused for a new session.
    await assert.rejects(
      manager.ensure('owner', { runner: 'codex', cwd: repo, sessionId: closed }),
      /belongs to an archived native session/,
    );
    // A session that reappears under an archived id is kept, never replacing the archive.
    writeFileSync(
      join(fixture.root, `${closed}.journal`),
      `${JSON.stringify({ info: { id: closed, ownerPrincipalId: 'owner', executionNodeId: 'local', runner: 'codex', cwd: repo, state: 'closed', processStopped: true }, context: {} })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(new NativeSessionManager(fixture.root).archiveSessions('owner', [closed]), [
      { sessionId: closed, outcome: 'kept', reason: 'archive exists' },
    ]);
  } finally {
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('host startup removes summaries whose journals are gone', async () => {
  const fixture = setup();
  const { repo } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const closed = await closedSession(manager, repo);
    new NativeSessionManager(fixture.root);
    const summary = join(fixture.root, 'summaries', `${closed}.json`);
    assert.equal(existsSync(summary), true);
    rmSync(join(fixture.root, `${closed}.journal`));
    new NativeSessionManager(fixture.root);
    assert.equal(existsSync(summary), false);
  } finally {
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});
