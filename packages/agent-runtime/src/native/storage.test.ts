import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import {
  alive,
  matchesProcess,
  processGroupAlive,
  processIdentityAlive,
  type ProcessMetadataCache,
  recordedProcessGroupAlive,
} from './storage.js';

test('permission-denied presence probes remain conservative without breaking reads', (t) => {
  t.mock.method(process, 'kill', (_pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  });
  assert.equal(alive(process.pid), true);
  assert.equal(processGroupAlive(process.pid), true);
});

for (const leader of ['original', 'reused', 'absent'] as const) {
  test(`recorded group presence distinguishes a ${leader} leader in both probes`, (t) => {
    const group = 100038000;
    const identity = leader === 'reused' ? 'new leader birth' : 'old leader birth';
    t.mock.method(childProcess, 'execFileSync', () => identity);
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(signal, 0);
      if (pid === -group || (pid === group && leader !== 'absent')) return true;
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    });
    const member = { pid: group + 1, parent: 1, group, identity: 'member birth' };
    const snapshot = new Map([[member.pid, member]]);
    if (leader !== 'absent') snapshot.set(group, { ...member, pid: group, identity });
    const expected = leader !== 'reused';
    assert.equal(recordedProcessGroupAlive(group, 'old leader birth', snapshot), expected);
    assert.equal(recordedProcessGroupAlive(group, 'old leader birth'), expected);
  });
}

test('passive polling reads each PID metadata field once while liveness stays fresh', (t) => {
  const observations: ProcessMetadataCache = new Map();
  let reads = 0;
  let probes = 0;
  t.mock.method(childProcess, 'execFileSync', () => {
    reads++;
    return 'observed-identity';
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', (_pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(signal, 0);
    probes++;
    return true;
  });
  for (let poll = 0; poll < 120; poll++) {
    assert.equal(processIdentityAlive(100038001, 'observed-identity', observations), true);
    assert.equal(matchesProcess(100038001, 'observed-identity', observations), true);
  }
  assert.equal(reads, 2);
  assert.equal(probes, 240);
});

test('control identity checks stay fresh after passive metadata was cached', (t) => {
  const observations: ProcessMetadataCache = new Map();
  let identity = 'original';
  t.mock.method(childProcess, 'execFileSync', () => identity);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', () => true);
  assert.equal(processIdentityAlive(100038001, 'original', observations), true);
  assert.equal(matchesProcess(100038001, 'original', observations), true);
  identity = 'replacement';
  assert.equal(processIdentityAlive(100038001, 'original'), false);
  assert.equal(matchesProcess(100038001, 'original'), false);
});

test('observed process exit clears metadata before a reused PID is inspected', (t) => {
  const observations: ProcessMetadataCache = new Map();
  let present = true;
  let identity = 'original';
  t.mock.method(childProcess, 'execFileSync', () => identity);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', () => {
    if (!present) throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    return true;
  });
  assert.equal(processIdentityAlive(100038001, 'original', observations), true);
  present = false;
  assert.equal(processIdentityAlive(100038001, 'original', observations), false);
  assert.equal(observations.has(100038001), false);
  present = true;
  identity = 'replacement';
  assert.equal(processIdentityAlive(100038001, 'replacement', observations), true);
});
