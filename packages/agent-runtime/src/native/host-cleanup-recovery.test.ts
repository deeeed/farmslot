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
  const birth = new Map<number, string>();
  t.mock.method(childProcess, 'execFileSync', (_file: string, args: string[]) => {
    if (censusError) throw censusError;
    if (args.includes('lstart=')) return birth.get(Number(args[1])) ?? 'unknown';
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
    birth,
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
  assert.deepEqual(receipt.verifiedStoppedGroups, [supervisor, runner]);
  assert.equal(readdirSync(join(f.root, 'cleanup-recoveries')).length, 1);
});

for (const kind of ['host', 'supervisor', 'runner', 'descendant-group'] as const) {
  test(`refuses surviving ${kind} without clearing cleanup or writing a receipt`, (t) => {
    const f = fixture(t);
    const id = kind === 'host' ? host : kind === 'supervisor' ? supervisor : runner;
    const group = kind === 'descendant-group' ? supervisor : id;
    f.setCensus(
      `${process.pid} 1 ${process.pid} inspector\n${kind === 'descendant-group' ? runner + 1 : id} 1 ${group} ${kind === 'host' ? 'old host start' : 'surviving start'}\n`,
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

for (const sameIdentity of [true, false]) {
  test(`${sameIdentity ? 'original' : 'reused'} runner PID and group are distinguished by birth identity`, (t) => {
    const f = fixture(t);
    const saved = { pid: runner, parent: host, group: runner, identity: 'old runner birth' };
    writeFileSync(
      join(f.root, 'sessions/session.journal'),
      f.journal + JSON.stringify({ processes: [saved] }) + '\n',
    );
    const current = sameIdentity ? saved.identity : 'new unrelated birth';
    f.setCensus(`${process.pid} 1 ${process.pid} inspector\n${runner} 1 ${runner} ${current}\n`);
    f.live.add(runner);
    f.live.add(-runner);
    f.birth.set(runner, current);
    if (sameIdentity)
      assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /surviving/);
    else {
      recoverStoppedNativeHost(f.root, supervisor, host);
      assert.equal(
        JSON.parse(readFileSync(join(f.root, 'cleanup.json'), 'utf8')).state,
        'complete',
      );
    }
  });
}

for (const historical of ['older-host', 'older-generation'] as const) {
  test(`ignores confirmed stopped ${historical} observations while preserving their journal`, (t) => {
    const f = fixture(t);
    const historicalPid = runner + 20;
    const old =
      JSON.stringify({
        info: {
          ...f.info,
          hostPid: historical === 'older-host' ? host - 1 : host,
          generation: 'old',
          processPid: historicalPid,
        },
        processes: [
          { pid: historicalPid, parent: host - 1, group: historicalPid, identity: 'old birth' },
        ],
      }) + '\n';
    const path =
      historical === 'older-host' ? 'sessions/older.journal' : 'sessions/session.journal';
    const bytes = historical === 'older-host' ? old : old + f.journal;
    writeFileSync(join(f.root, path), bytes, { mode: 0o600 });
    f.live.add(historicalPid);
    f.live.add(-historicalPid);
    f.setCensus(
      `${process.pid} 1 ${process.pid} inspector\n${historicalPid} 1 ${historicalPid} new birth\n`,
    );
    recoverStoppedNativeHost(f.root, supervisor, host);
    assert.equal(readFileSync(join(f.root, path), 'utf8'), bytes);
  });
}

test('an orphaned runner group still refuses when its leader is absent', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, 'sessions/session.journal'),
    f.journal +
      JSON.stringify({
        processes: [{ pid: runner, parent: host, group: runner, identity: 'old runner birth' }],
      }) +
      '\n',
  );
  f.setCensus(
    `${process.pid} 1 ${process.pid} inspector\n${runner + 1} 1 ${runner} orphan birth\n`,
  );
  assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /surviving/);
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

// macwork 10-18: the census timed out under load, so the supervisor killed the host while a
// native reviewer session was still open and its cleanup could not record that runner's stop.
for (const survivor of [undefined, 'runner', 'descendant'] as const) {
  test(`a session the failed host still ran ${survivor ? `refuses a surviving ${survivor}` : 'is verified stopped instead of refusing recovery'}`, (t) => {
    const f = fixture(t);
    const descendant = runner + 10;
    const journal =
      JSON.stringify({
        info: { ...f.info, state: 'idle', processStopped: false },
        context: { cwd: 'retained-workspace' },
      }) +
      '\n' +
      JSON.stringify({
        processes: [
          { pid: runner, parent: host, group: runner, identity: 'runner birth' },
          { pid: descendant, parent: runner, group: runner, identity: 'descendant birth' },
        ],
      }) +
      '\n';
    writeFileSync(join(f.root, 'sessions/session.journal'), journal, { mode: 0o600 });
    if (survivor) {
      const [pid, identity] =
        survivor === 'runner' ? [runner, 'runner birth'] : [descendant, 'descendant birth'];
      f.setCensus(`${process.pid} 1 ${process.pid} inspector\n${pid} 1 ${runner} ${identity}\n`);
      assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /surviving/);
      assert.equal(readFileSync(join(f.root, 'cleanup.json'), 'utf8'), JSON.stringify(marker));
      assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
    } else {
      recoverStoppedNativeHost(f.root, supervisor, host);
      const cleanup = JSON.parse(readFileSync(join(f.root, 'cleanup.json'), 'utf8'));
      assert.equal(cleanup.state, 'complete');
      const receipt = JSON.parse(readFileSync(join(f.root, cleanup.recoveryReceipt), 'utf8'));
      assert.deepEqual(receipt.verifiedStoppedGroups, [supervisor, runner]);
      assert.ok(receipt.verifiedStoppedPids.includes(descendant));
    }
    assert.equal(readFileSync(join(f.root, 'sessions/session.journal'), 'utf8'), journal);
  });
}

for (const bad of [
  'older-host active',
  'older-host unconfirmed',
  'torn',
  'host-mismatch',
  'missing-observation',
  'empty-journal',
  'malformed-journal',
] as const) {
  test(`refuses ${bad} evidence while preserving the retained journal`, (t) => {
    const f = fixture(t);
    if (bad === 'older-host active' || bad === 'older-host unconfirmed') {
      writeFileSync(
        join(f.root, 'sessions/session.journal'),
        JSON.stringify({
          info: {
            ...f.info,
            hostPid: host - 1,
            state: bad === 'older-host active' ? 'running' : 'closed',
            processStopped: bad !== 'older-host unconfirmed',
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

for (const observations of [undefined, []]) {
  test(`quarantines ${observations ? 'empty' : 'missing'} first-census evidence without resetting historical sessions`, (t) => {
    const f = fixture(t);
    const original = {
      hostPid: host,
      state: observations ? 'unknown' : 'pending',
      error: 'spawnSync ps ETIMEDOUT',
      ...(observations ? { observedProcesses: observations } : {}),
    };
    f.write('cleanup.json', original);
    const historical = JSON.stringify({ info: { ...f.info, hostPid: host - 1 } }) + '\n';
    writeFileSync(join(f.root, 'sessions/session.journal'), historical, { mode: 0o600 });
    recoverStoppedNativeHost(f.root, supervisor, host);
    const cleanup = JSON.parse(readFileSync(join(f.root, 'cleanup.json'), 'utf8'));
    assert.equal(cleanup.state, 'complete');
    assert.match(cleanup.recoveryReceipt, /^cleanup-quarantine\//);
    const receipt = JSON.parse(readFileSync(join(f.root, cleanup.recoveryReceipt), 'utf8'));
    assert.equal(receipt.quarantined, true);
    assert.deepEqual(receipt.originalCleanup, original);
    assert.equal(
      Buffer.from(receipt.originalCleanupBytesBase64, 'base64').toString(),
      JSON.stringify(original),
    );
    assert.equal(readFileSync(join(f.root, 'sessions/session.journal'), 'utf8'), historical);
    assert.deepEqual(receipt.verifiedStoppedPids, [supervisor, host]);
  });
}

test('unobserved startup refuses a surviving supervisor group and keeps the marker intact', (t) => {
  const f = fixture(t);
  const original = { ...marker, observedProcesses: [] };
  f.write('cleanup.json', original);
  writeFileSync(
    join(f.root, 'sessions/session.journal'),
    JSON.stringify({ info: { ...f.info, hostPid: host - 1 } }) + '\n',
    { mode: 0o600 },
  );
  f.live.add(-supervisor);
  assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), /recorded group stopped/);
  assert.equal(readFileSync(join(f.root, 'cleanup.json'), 'utf8'), JSON.stringify(original));
  assert.equal(existsSync(join(f.root, 'cleanup-quarantine')), false);
});

test('recovers a released stopped host whose cleanup lost its root census observation', (t) => {
  const f = fixture(t);
  const original = { ...marker, observedProcesses: [] };
  f.write('cleanup.json', original);
  const bytes =
    f.journal +
    JSON.stringify({
      processesAdded: [
        { pid: runner, parent: host, group: runner, identity: 'retained runner birth' },
        { pid: runner + 1, parent: runner, group: runner + 1, identity: 'detached child birth' },
      ],
    }) +
    '\n';
  writeFileSync(join(f.root, 'sessions/session.journal'), bytes, { mode: 0o600 });
  recoverStoppedNativeHost(f.root, supervisor, host);
  assert.equal(readFileSync(join(f.root, 'sessions/session.journal'), 'utf8'), bytes);
  const cleanup = JSON.parse(readFileSync(join(f.root, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.state, 'complete');
  assert.match(cleanup.recoveryReceipt, /^cleanup-recoveries\//);
  const receipt = JSON.parse(readFileSync(join(f.root, cleanup.recoveryReceipt), 'utf8'));
  assert.equal(receipt.hostObservationJournal, 'session.journal');
  assert.deepEqual(receipt.originalCleanup, original);
  assert.equal(
    receipt.journalSha256['session.journal'],
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.ok(receipt.verifiedStoppedPids.includes(runner + 1));
});

for (const kind of [
  'host',
  'supervisor',
  'runner',
  'detached',
  'orphan',
  'independent-group',
  'census-failure',
  'wrong-parent',
  'old-generation',
] as const) {
  test(`lost root observation still refuses ${kind} evidence`, (t) => {
    const f = fixture(t);
    const original = { ...marker, observedProcesses: [] };
    f.write('cleanup.json', original);
    const processes = [
      {
        pid: runner,
        parent: kind === 'wrong-parent' ? host - 1 : host,
        group: runner,
        identity: 'retained runner birth',
      },
      { pid: runner + 1, parent: runner, group: runner + 1, identity: 'detached child birth' },
    ];
    let bytes = f.journal + JSON.stringify({ processesAdded: processes }) + '\n';
    if (kind === 'old-generation')
      bytes += JSON.stringify({ info: { ...f.info, generation: 'new-generation' } }) + '\n';
    writeFileSync(join(f.root, 'sessions/session.journal'), bytes, { mode: 0o600 });
    if (kind === 'census-failure') f.failCensus(new Error('Census timed out'));
    else if (kind === 'independent-group') f.live.add(-(runner + 1));
    else if (['host', 'supervisor', 'runner', 'detached', 'orphan'].includes(kind)) {
      const value =
        kind === 'host'
          ? host
          : kind === 'supervisor'
            ? supervisor
            : kind === 'runner'
              ? runner
              : runner + 1;
      const group = kind === 'orphan' ? runner : value;
      f.setCensus(
        `${process.pid} 1 ${process.pid} inspector\n${value} 1 ${group} ${kind === 'runner' ? 'retained runner birth' : kind === 'detached' ? 'detached child birth' : 'surviving birth'}\n`,
      );
    }
    const refusal =
      kind === 'census-failure'
        ? /Census timed out/
        : kind === 'independent-group'
          ? /recorded group stopped/
          : kind === 'wrong-parent' || kind === 'old-generation'
            ? /cannot exclude/
            : /surviving process or group/;
    assert.throws(() => recoverStoppedNativeHost(f.root, supervisor, host), refusal);
    assert.equal(readFileSync(join(f.root, 'cleanup.json'), 'utf8'), JSON.stringify(original));
    assert.equal(readFileSync(join(f.root, 'sessions/session.journal'), 'utf8'), bytes);
    assert.equal(existsSync(join(f.root, 'cleanup-recoveries')), false);
  });
}
