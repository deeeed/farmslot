import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { allEvents, setup, testRepository } from './durability.test-support.js';
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
    const sessions: unknown = Reflect.get(manager, 'sessions');
    const append: unknown = Reflect.get(manager, 'append');
    assert.ok(sessions instanceof Map && typeof append === 'function');
    const record: unknown = sessions.get(closed);
    assert.deepEqual(manager.archiveSessions('owner', [closed]), [
      { sessionId: closed, outcome: 'archived' },
    ]);
    // A late event from its stopped adapter does not recreate the journal in startup replay.
    append.call(manager, record, { type: 'session.closed' });
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
