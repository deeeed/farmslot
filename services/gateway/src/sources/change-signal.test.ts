import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  advanceSourceRevision,
  announceSourceChanges,
  currentSourceResourceChanges,
  noteAuthorityFacts,
  noteRunSourceFacts,
  noteSourceMaterialized,
  resetSourceChangeSignalForTests,
  setSourceChangePublisher,
} from './change-signal.js';
import { sourceTestLock, sourceTestPlan } from './source.test-support.js';

function configuredSignal(): { published: () => number } {
  resetSourceChangeSignalForTests();
  let published = 0;
  setSourceChangePublisher(() => published++);
  announceSourceChanges();
  return { published: () => published };
}

const revision = () => currentSourceResourceChanges()!.changes[0].revision;

test('an unconfigured gateway publishes nothing; a configured one announces an ADR-071 payload', () => {
  resetSourceChangeSignalForTests();
  advanceSourceRevision();
  assert.equal(currentSourceResourceChanges(), undefined);
  announceSourceChanges();
  const payload = currentSourceResourceChanges()!;
  assert.equal(payload.version, 1);
  assert.match(payload.epoch, /^[0-9a-f-]{36}$/);
  assert.deepEqual(payload.changes, [
    { key: { family: 'sources', scope: 'farm' }, revision: 0, kind: 'updated' },
  ]);
});

test('authority facts advance only when what status reports changes, coalescing one broadcast', async () => {
  const signal = configuredSignal();
  noteAuthorityFacts('baseline');
  noteAuthorityFacts('baseline');
  assert.equal(revision(), 0, 'the startup baseline and idle polls do not advance');
  noteAuthorityFacts('pin added');
  noteAuthorityFacts('branch advanced');
  assert.equal(revision(), 2);
  await setImmediate();
  assert.equal(signal.published(), 1);
});

test('a run advances when its source lock or pin eligibility changes, not on first sight', async () => {
  configuredSignal();
  const run = makeRun({ status: 'created' });
  noteRunSourceFacts(run);
  assert.equal(revision(), 0, 'runs without source plans are ignored');
  run.sourcePlan = sourceTestPlan(sourceTestLock(undefined, run.id));
  noteRunSourceFacts(run);
  noteRunSourceFacts(run);
  assert.equal(revision(), 0);
  run.status = 'slot-finding';
  noteRunSourceFacts(run);
  assert.equal(revision(), 0, 'a status change that keeps pins open is not a source fact');
  run.status = 'cancelled';
  noteRunSourceFacts(run);
  assert.equal(revision(), 1, 'cancelling ends pin selection');
  noteRunSourceFacts(run);
  assert.equal(revision(), 1, 'a finished run is forgotten');
  resetSourceChangeSignalForTests();
});

test('a receipt that lands after its lock was announced advances again, once per node', async () => {
  await setImmediate(); // let the previous test's coalesced broadcast drain
  const signal = configuredSignal();
  noteAuthorityFacts('baseline');
  noteAuthorityFacts('lock persisted');
  await setImmediate();
  assert.deepEqual([revision(), signal.published()], [1, 1]);
  noteSourceMaterialized('gateway', 'lock-a');
  await setImmediate();
  assert.deepEqual([revision(), signal.published()], [2, 2], 'materialization finished later');
  noteSourceMaterialized('gateway', 'lock-a');
  assert.equal(revision(), 2, 'repeat materialization only verifies the receipt');
  noteSourceMaterialized('node-1', 'lock-a');
  assert.equal(revision(), 3);
  resetSourceChangeSignalForTests();
});
