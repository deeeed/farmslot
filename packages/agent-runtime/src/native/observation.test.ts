import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { NativeProfileStatusResult } from '@farmslot/protocol';

import { NativeSessionClient } from './client.js';
import { type HostIdentity, socketDirectory } from './ipc.js';
import {
  NativeHostObservation,
  type NativeSourceReceipt,
  NativeSourceUnavailable,
  sameNativeSource,
} from './observation.js';
import { alive, appendDurable, readJson } from './storage.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'native-source-'));
  const root = join(home, 'host');
  mkdirSync(join(root, 'sessions'), { recursive: true, mode: 0o700 });
  const notices: unknown[] = [];
  const source = new NativeHostObservation(
    new NativeSessionClient(root),
    'A',
    (notice) => notices.push(notice),
    home,
    async () => [],
  );
  return {
    source,
    home,
    root,
    notices,
    close() {
      source.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('source admits the actual supervisor and its separately registered ready host', async () => {
  const fixture = setup();
  let supervisorPid: number | undefined;
  try {
    assert.deepEqual(await new NativeSessionClient(fixture.root).list('A'), []);
    const supervisor = readJson<HostIdentity>(join(fixture.root, 'host.json'));
    supervisorPid = supervisor.pid;
    const worker = readJson<{ pid: number }>(join(fixture.root, 'worker.json'));
    const ready = readJson<{ pid: number }>(join(fixture.root, 'ready.json'));
    assert.notEqual(supervisor.pid, worker.pid);
    assert.equal(ready.pid, worker.pid);
    await fixture.source.start();
    assert.equal(fixture.source.fence().ready, true);
    writeFileSync(join(fixture.root, 'ready.json'), JSON.stringify({ pid: supervisor.pid }));
    assert.throws(() => fixture.source.fence(), NativeSourceUnavailable);
  } finally {
    fixture.source.stop();
    if (supervisorPid && alive(supervisorPid)) process.kill(supervisorPid, 'SIGTERM');
    const deadline = Date.now() + 4000;
    while (existsSync(join(fixture.root, 'lock')) && Date.now() < deadline) await delay(20);
    assert.equal(existsSync(join(fixture.root, 'lock')), false, 'Private native owner must stop');
    rmSync(socketDirectory(fixture.root), { recursive: true, force: true });
    fixture.close();
  }
});

test('armed source sees real journal appends before fs.watch callback; no command or host launch', async () => {
  const fixture = setup();
  try {
    assert.throws(() => fixture.source.fence(), NativeSourceUnavailable);
    await fixture.source.start();
    const before = fixture.source.fence();
    for (const entry of [
      { info: { id: 'session', ownerPrincipalId: 'A', state: 'idle' } },
      { event: { sequence: 1, type: 'message.delta', text: 'fragment' } },
      { pending: [{ id: 'approval' }] },
      { commands: [{ commandId: 'receipt', state: 'accepted' }] },
      { info: { id: 'session', ownerPrincipalId: 'A', state: 'closed' } },
    ])
      appendDurable(join(fixture.root, 'sessions', 'session.journal'), entry);
    const after = fixture.source.fence();
    assert.equal(after.ready, true);
    assert.ok(after.revision > before.revision);
    assert.equal(sameNativeSource(before, after), false);
    assert.ok(fixture.notices.length >= 2);
    assert.equal(JSON.stringify(after).includes('fragment'), false);
  } finally {
    fixture.close();
  }
});

test('healthy journal append supersedes a held read without revoking source admission', async (t) => {
  const fixture = setup();
  const notices: unknown[][] = [];
  t.mock.method(console, 'info', (...args: unknown[]) => notices.push(args));
  try {
    await fixture.source.start();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = fixture.source.read(async () => {
      await held;
      return { text: 'old' };
    });
    appendDurable(join(fixture.root, 'sessions', 's.journal'), { pending: [] });
    release();
    await assert.rejects(pending, { code: 'RESOURCE_OBSERVATION_CHANGED' });
    assert.equal(fixture.source.current().ready, true);
    assert.ok(notices.some((args) => String(args[1]).includes('"reason":"node-read"')));
    assert.equal((await fixture.source.read(async () => 'fresh')).value, 'fresh');
    await assert.rejects(
      fixture.source.read(async () => {
        throw Object.assign(new Error('Missing'), { code: 'NOT_FOUND' });
      }),
      { code: 'NOT_FOUND' },
    );
    await assert.rejects(
      fixture.source.read(async () => {
        throw Object.assign(new Error('Offline'), { code: 'NATIVE_SESSION_ERROR' });
      }),
      { code: 'NATIVE_SESSION_ERROR' },
    );
  } finally {
    fixture.close();
  }
});

test('partial append revokes admission without truncation; fresh armed receipt recovers', async (t) => {
  const fixture = setup();
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args));
  try {
    await fixture.source.start();
    const old = fixture.source.current();
    const journal = join(fixture.root, 'sessions', 's.journal');
    writeFileSync(journal, '{', { mode: 0o600 });
    assert.throws(() => fixture.source.fence(), NativeSourceUnavailable);
    assert.ok(
      logs.some((args) => String(args[1]).includes('"reason":"incomplete-journal-append"')),
    );
    assert.equal(fixture.source.current().ready, false);
    writeFileSync(journal, '{}\n', { mode: 0o600 });
    await fixture.source.start();
    assert.equal(fixture.source.current().ready, true);
    assert.notEqual(old.incarnation, fixture.source.current().incarnation);
  } finally {
    fixture.close();
  }
});

test('a failed profile sample keeps sessions observable; profile reads recover on a later sample', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings: unknown[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const fixture = setup();
  const receipts: NativeSourceReceipt[] = [];
  let fail = true;
  const status: NativeProfileStatusResult = {
    profile: {
      id: 'profile',
      runner: 'grok',
      directory: fixture.home,
      accountContextId: 'context',
      state: 'active' as const,
    },
    account: {
      runner: 'grok',
      installed: true,
      login: 'authenticated',
      observedAt: '2026-11-02T00:00:00.000Z',
      mode: 'unknown',
      identityQuality: 'unavailable',
    },
    loginCommand: 'login',
  };
  const source = new NativeHostObservation(
    new NativeSessionClient(fixture.root),
    'A',
    (receipt) => receipts.push(receipt),
    fixture.home,
    async () => {
      if (fail) throw new Error('Account capability unavailable');
      return [status];
    },
  );
  try {
    await source.start();
    assert.equal(source.fence().ready, true);
    assert.throws(() => source.profileStatus('profile'), { code: 'NATIVE_PROFILES_UNAVAILABLE' });
    assert.match(JSON.stringify(warnings), /Account capability unavailable/);
    fail = false;
    const before = receipts.length;
    // The next 60 s account sample. setImmediate is not mocked, so polling lets it settle.
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 50 && receipts.length === before; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(receipts.at(-1)?.changed, ['profiles']);
    assert.equal(source.profileStatus('profile').account.login, 'authenticated');
    assert.equal(source.fence().ready, true);
  } finally {
    source.stop();
    fixture.close();
  }
});

test('an unreadable profile file leaves sessions observable until it is repaired', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const fixture = setup();
  try {
    const file = join(fixture.home, 'provider-accounts.json');
    writeFileSync(file, '{not json', { mode: 0o600 });
    const source = new NativeHostObservation(
      new NativeSessionClient(fixture.root),
      'A',
      () => undefined,
      fixture.home,
    );
    try {
      await source.start();
      assert.equal(source.fence().ready, true);
      assert.throws(() => source.profileStatus('profile'), { code: 'NATIVE_PROFILES_UNAVAILABLE' });
      // The repaired file re-arms the source through its watcher; profile reads come back.
      writeFileSync(file, JSON.stringify({ version: 1, accounts: {} }), { mode: 0o600 });
      for (let i = 0; i < 100; i++) {
        try {
          source.profileStatus('profile');
        } catch (error) {
          // Re-arming briefly reports the whole source unavailable, then profiles return.
          if ((error as { code?: string }).code === 'NOT_FOUND') break;
        }
        await delay(20);
      }
      assert.throws(() => source.profileStatus('profile'), { code: 'NOT_FOUND' });
      assert.equal(source.fence().ready, true);
    } finally {
      source.stop();
    }
  } finally {
    fixture.close();
  }
});

test('manager missing identity is structured and indistinguishable from foreign identity', async () => {
  const { NativeSessionManager } = await import('./manager.js');
  const fixture = setup();
  try {
    const manager = new NativeSessionManager(join(fixture.root, 'sessions'));
    for (const owner of ['A', 'B'])
      assert.throws(() => manager.read(owner, 'missing'), { code: 'NOT_FOUND' });
  } finally {
    fixture.close();
  }
});

test('marked profile readers reuse one real capability sample and preserve its observed time', async () => {
  const fixture = setup();
  let probes = 0;
  const status: NativeProfileStatusResult = {
    profile: {
      id: 'profile',
      runner: 'codex',
      directory: fixture.home,
      accountContextId: 'context',
      state: 'active' as const,
    },
    account: {
      runner: 'codex',
      installed: true,
      login: 'signed-out',
      observedAt: '2026-10-23T00:00:00.000Z',
      mode: 'unknown',
      identityQuality: 'unavailable',
    },
    loginCommand: 'login',
  };
  const source = new NativeHostObservation(
    new NativeSessionClient(fixture.root),
    'A',
    () => undefined,
    fixture.home,
    async () => {
      probes++;
      return [status];
    },
  );
  try {
    await source.start();
    assert.equal(source.profileStatus('profile').account.observedAt, status.account.observedAt);
    assert.equal(source.profileStatus('profile').account.observedAt, status.account.observedAt);
    assert.equal(probes, 1);
    assert.throws(() => source.profileStatus('deleted'), { code: 'NOT_FOUND' });
  } finally {
    source.stop();
    fixture.close();
  }
});
