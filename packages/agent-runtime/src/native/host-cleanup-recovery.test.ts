import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { recoverStoppedNativeHost } from './host-cleanup-recovery.js';

const supervisor = 100039801;
const host = 100039802;
const runner = 100039840;
const marker = {
  hostPid: host,
  state: 'unknown',
  error: 'spawnSync ps ETIMEDOUT',
  observedProcesses: [
    { pid: host, parent: supervisor, group: supervisor, identity: 'old host start' },
  ],
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'native-host-recovery-'));
  for (const name of ['lock', 'sessions']) mkdirSync(join(root, name), { mode: 0o700 });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
  write('lock/owner.json', { pid: supervisor });
  write('worker.json', { pid: host });
  write('cleanup.json', marker);
  const info = {
    id: 'retained-session',
    generation: 'retained-generation',
    nativeSessionId: 'saved-conversation',
    ownerPrincipalId: 'owner',
    hostPid: host,
    processPid: runner,
    state: 'closed',
    processStopped: true,
  };
  const journal =
    JSON.stringify({
      info,
      context: { cwd: 'retained-workspace' },
      commands: [{ commandId: 'original', state: 'accepted' }],
      pending: [],
    }) + '\n';
  writeFileSync(join(root, 'sessions/session.journal'), journal, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let census = `${process.pid} 1 ${process.pid} current inspector start\n`;
  let censusError: Error | undefined;
  let beforeCensus: (() => void) | undefined;
  const live = new Set<number>();
  t.mock.method(childProcess, 'execFileSync', () => {
    if (censusError) throw censusError;
    beforeCensus?.();
    return census;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', (value: number, signal?: number | NodeJS.Signals) => {
    assert.equal(signal, 0, 'recovery must never signal a process');
    if (live.has(value)) return true;
    throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
  });
  return {
    root,
    write,
    info,
    journal,
    live,
    setCensus: (value: string) => {
      census = value;
    },
    failCensus: (error: Error) => {
      censusError = error;
    },
    beforeCensus: (callback: () => void) => {
      beforeCensus = callback;
    },
  };
}

test('recovers the stopped-host timeout shape and preserves native journals and original failure', (t) => {
  const f = fixture(t);
  recoverStoppedNativeHost(f.root, supervisor, host);
  assert.equal(readFileSync(join(f.root, 'sessions/session.journal'), 'utf8'), f.journal);
  assert.equal(
    readFileSync(join(f.root, 'lock/owner.json'), 'utf8'),
    JSON.stringify({ pid: supervisor }),
  );
  const cleanup = JSON.parse(readFileSync(join(f.root, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.state, 'complete');
  const receipt = JSON.parse(readFileSync(join(f.root, cleanup.recoveryReceipt), 'utf8'));
  assert.deepEqual(receipt.originalCleanup, marker);
  assert.equal(
    receipt.journalSha256['session.journal'],
    createHash('sha256').update(f.journal).digest('hex'),
  );
  assert.deepEqual(receipt.verifiedEmptyGroups, [supervisor, runner]);
  assert.equal(readdirSync(join(f.root, 'cleanup-recoveries')).length, 1);
});

for (const kind of ['host', 'supervisor', 'runner', 'descendant-group', 'pid-reuse'] as const) {
  test(`refuses surviving ${kind} without clearing cleanup or writing a receipt`, (t) => {
    const f = fixture(t);
    const id =
      kind === 'host' || kind === 'pid-reuse' ? host : kind === 'supervisor' ? supervisor : runner;
    const group = kind === 'descendant-group' ? supervisor : id;
    f.setCensus(
      `${process.pid} 1 ${process.pid} inspector\n${kind === 'descendant-group' ? runner + 1 : id} 1 ${group} unrelated or surviving start\n`,
    );
    assert.throws(
      () => recoverStoppedNativeHost(f.root, supervisor, host),
      /surviving process or group/,
    );
    assert.equal(readFileSync(join(f.root, 'cleanup.json'), 'utf8'), JSON.stringify(marker));
    assert.equal(readFileSync(join(f.root, 'sessions/session.journal'), 'utf8'), f.journal);
    assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
  });
}

test('fresh census failure and independently living groups stay unconfirmed', (t) => {
  const f = fixture(t);
  f.failCensus(Object.assign(new Error('Census timed out'), { code: 'ETIMEDOUT' }));
  assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /Census timed out/);
  assert.equal(readFileSync(join(f.root, 'cleanup.json'), 'utf8'), JSON.stringify(marker));
});

test('independent process-group probe catches a survivor absent from the census', (t) => {
  const f = fixture(t);
  f.live.add(-runner);
  assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /recorded group stopped/);
  assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
});

test('a detached descendant recorded only in the session journal blocks recovery', (t) => {
  const f = fixture(t);
  const detached = runner + 10;
  writeFileSync(
    join(f.root, 'sessions/session.journal'),
    f.journal +
      JSON.stringify({
        processesAdded: [
          { pid: detached, parent: runner, group: detached, identity: 'detached start' },
        ],
      }) +
      '\n',
    { mode: 0o600 },
  );
  f.live.add(-detached);
  assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /recorded group stopped/);
  assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
});

for (const changed of ['cleanup', 'owner', 'host', 'journal'] as const) {
  test(`refuses ${changed} changes during verification without writing recovery`, (t) => {
    const f = fixture(t);
    f.beforeCensus(() => {
      if (changed === 'cleanup') f.write('cleanup.json', { ...marker, error: 'changed' });
      if (changed === 'owner') f.write('lock/owner.json', { pid: supervisor + 1 });
      if (changed === 'host') f.write('worker.json', { pid: host + 1 });
      if (changed === 'journal')
        writeFileSync(join(f.root, 'sessions/session.journal'), f.journal + '{}\n');
    });
    assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /changed during/);
    assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
  });
}

test('a census without the inspector cannot prove absence', (t) => {
  const f = fixture(t);
  f.setCensus('');
  assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /census is incomplete/);
  assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
});

for (const bad of [
  'active',
  'unconfirmed',
  'torn',
  'host-mismatch',
  'missing-observation',
  'empty-journal',
  'malformed-journal',
] as const) {
  test(`refuses ${bad} evidence while preserving the retained journal`, (t) => {
    const f = fixture(t);
    if (bad === 'active' || bad === 'unconfirmed') {
      writeFileSync(
        join(f.root, 'sessions/session.journal'),
        JSON.stringify({
          info: {
            ...f.info,
            state: bad === 'active' ? 'running' : 'closed',
            processStopped: bad !== 'unconfirmed',
          },
        }) + '\n',
        { mode: 0o600 },
      );
    } else if (bad === 'torn')
      writeFileSync(join(f.root, 'sessions/session.journal'), f.journal.trimEnd(), { mode: 0o600 });
    else if (bad === 'empty-journal' || bad === 'malformed-journal')
      writeFileSync(
        join(f.root, 'sessions/session.journal'),
        bad === 'empty-journal' ? '' : 'invalid\n',
      );
    else
      f.write('cleanup.json', {
        ...marker,
        ...(bad === 'host-mismatch' ? { hostPid: host + 1 } : { observedProcesses: [] }),
      });
    const before = readFileSync(join(f.root, 'sessions/session.journal'));
    assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host));
    assert.deepEqual(readFileSync(join(f.root, 'sessions/session.journal')), before);
    assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
  });
}
