import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  invalidateMachinePoolSnapshot,
  observeMachinePoolSnapshot,
  readMachinePoolSnapshot,
} from './machine-pool-snapshot.js';

test('watched pool reads resolve canonical settings, retain auxiliary slots, and avoid warm scans', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'machine-pool-snapshot-'));
  const previous = process.env.FARMSLOT_POOL_DIR;
  process.env.FARMSLOT_POOL_DIR = directory;
  const stop = observeMachinePoolSnapshot(directory);
  t.after(() => {
    stop();
    if (previous === undefined) delete process.env.FARMSLOT_POOL_DIR;
    else process.env.FARMSLOT_POOL_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const write = (file: string, host: string, slot: string) =>
    fs.writeFileSync(
      join(directory, file),
      JSON.stringify({
        machine: 'remote',
        host,
        slots: [{ id: slot }],
      }),
    );
  write('a-auxiliary.json', 'localhost', 'auxiliary');
  write('remote.json', 'remote.invalid', 'primary');

  const stat = fs.statSync;
  const checks: string[] = [];
  t.mock.method(fs, 'statSync', (file: string, options: unknown) => {
    if (file === directory || (typeof file === 'string' && dirname(file) === directory))
      checks.push(file);
    return Reflect.apply(stat, fs, [file, options]);
  });
  syncBuiltinESMExports();

  const first = readMachinePoolSnapshot();
  const initialChecks = checks.length;
  assert(initialChecks > 0);
  assert.equal(first.entriesByMachine.get('remote')?.length, 2);
  assert.equal(first.firstSlotByMachine.get('remote'), 'primary');
  assert.equal(first.poolBySlot.get('auxiliary')?.length, 1);
  assert.deepEqual(first.localMachines, []);
  const machine = first.resolvedByMachine.get('remote');
  assert(machine?.ok);
  assert.equal(machine.pool.host, 'remote.invalid');

  assert.equal(readMachinePoolSnapshot(), first);
  assert.equal(readMachinePoolSnapshot(), first);
  assert.equal(checks.length, initialChecks);

  fs.renameSync(join(directory, 'remote.json'), join(directory, 'second-auxiliary.json'));
  invalidateMachinePoolSnapshot(directory);
  const ambiguous = readMachinePoolSnapshot().resolvedByMachine.get('remote');
  assert(ambiguous && !ambiguous.ok);
  assert.match(String(ambiguous.error), /ambiguous pool settings/);
  assert(checks.length > initialChecks);

  stop();
  write('remote.json', 'localhost', 'restored');
  assert.deepEqual(readMachinePoolSnapshot().localMachines, ['remote']);
});
