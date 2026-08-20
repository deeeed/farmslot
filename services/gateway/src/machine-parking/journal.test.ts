import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MachineParkRecord } from '@farmslot/protocol';

import { MachineParkingIntentJournalStore } from './journal.js';

function record(machine: string, operationId: string): MachineParkRecord {
  return { machine, operationId } as MachineParkRecord;
}

test('journal identity includes machine and operation kind but not gateway port', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  const machineA = store.pathFor('machine-a', 'pause', 'same-id');
  const machineB = store.pathFor('machine-b', 'pause', 'same-id');
  const restore = store.pathFor('machine-a', 'restore', 'same-id');
  assert.notEqual(machineA, machineB);
  assert.notEqual(machineA, restore);

  const priorPort = process.env.GATEWAY_PORT;
  process.env.GATEWAY_PORT = '9999';
  try {
    assert.equal(
      new MachineParkingIntentJournalStore(runsDir).pathFor('machine-a', 'pause', 'same-id'),
      machineA,
    );
  } finally {
    if (priorPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = priorPort;
  }
});

test('malformed journal is quarantined without aborting valid recovery', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  await store.write('pause', [record('machine-a', 'valid-op')]);
  const malformed = path.join(
    path.dirname(store.pathFor('machine-a', 'pause', 'valid-op')),
    'bad.json',
  );
  await mkdir(path.dirname(malformed), { recursive: true });
  await writeFile(malformed, '{not json', 'utf8');

  const loaded = await store.load();
  assert.equal(loaded.journals.length, 1);
  assert.equal(loaded.journals[0]?.operationId, 'valid-op');
  assert.equal(loaded.quarantined.length, 1);
  assert.equal(loaded.quarantined[0]?.file, malformed);
});
