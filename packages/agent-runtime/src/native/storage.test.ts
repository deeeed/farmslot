import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { alive, processGroupAlive, recordedProcessGroupAlive } from './storage.js';

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
