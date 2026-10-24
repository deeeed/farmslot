import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { Events } from '@farmslot/protocol';

import { resourceRevisions } from '../resources/revisions.js';
import { makeRun } from '../run-engine/test-fixtures.js';

import {
  advanceSourceRevision,
  announceSourceChanges,
  currentSourceResourceChanges,
  noteAuthorityFacts,
  noteRunEvent,
  noteRunSourceFacts,
  noteRunSourceWrite,
  noteSourceMaterialized,
  resetSourceChangeSignalForTests,
} from './change-signal.js';
import { sourceTestLock, sourceTestPlan } from './source.test-support.js';

function configuredSignal(): { published: () => number } {
  resetSourceChangeSignalForTests();
  let published = 0;
  resourceRevisions.setPublisher(() => published++);
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

test('run.created sets the baseline a later run.updated is compared with; other events are ignored', async () => {
  await setImmediate(); // let the previous test's coalesced broadcast drain
  configuredSignal();
  const run = makeRun({ status: 'created' });
  run.sourcePlan = sourceTestPlan(sourceTestLock(undefined, run.id));
  noteRunEvent(Events.RUN_CREATED, { run });
  assert.equal(revision(), 0);
  noteRunEvent(Events.RUN_DELETED, { run: { ...run, status: 'cancelled' } });
  assert.equal(revision(), 0, 'only run.created and run.updated carry source facts');
  noteRunEvent(Events.RUN_UPDATED, { run: { ...run, status: 'cancelled' } });
  assert.equal(revision(), 1, 'cancelled before its first run.updated');
  resetSourceChangeSignalForTests();
});

test('a gateway write advances once, and the run update that follows it does not', async () => {
  await setImmediate();
  configuredSignal();
  const run = makeRun({ status: 'slot-finding' });
  run.sourcePlan = sourceTestPlan(sourceTestLock(undefined, run.id));
  noteRunEvent(Events.RUN_CREATED, { run });
  const lock = sourceTestLock('node-1', run.id);
  const admitted = {
    ...run,
    sourcePlan: undefined,
    sourceProvenance: {
      state: 'locked' as const,
      attemptId: `${run.id}:1`,
      lock,
      workerLock: lock,
      receiptIds: ['gateway-receipt'],
      bindings: [lock.packBindings.demo],
      attempts: [],
    },
  };
  noteRunSourceWrite(admitted);
  assert.equal(revision(), 1);
  noteRunEvent(Events.RUN_UPDATED, { run: admitted });
  assert.equal(revision(), 1, 'the engine update carries the facts the write announced');
  resetSourceChangeSignalForTests();
});
