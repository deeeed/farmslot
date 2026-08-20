import assert from 'node:assert/strict';
import test from 'node:test';

import { RunTransitionCoordinator } from './transition-coordinator.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('public run transitions wait for an in-flight machine transition', async () => {
  const coordinator = new RunTransitionCoordinator(async () => 'machine-a');
  const machineEntered = deferred();
  const releaseMachine = deferred();
  const events: string[] = [];
  const machine = coordinator.withMachine('machine-a', async () => {
    events.push('machine:start');
    machineEntered.resolve();
    await releaseMachine.promise;
    events.push('machine:end');
  });
  await machineEntered.promise;

  const run = coordinator.withRun('run-a', async () => {
    events.push('run');
  });
  await Promise.resolve();
  assert.deepEqual(events, ['machine:start']);
  releaseMachine.resolve();
  await Promise.all([machine, run]);
  assert.deepEqual(events, ['machine:start', 'machine:end', 'run']);
});

test('machine-held run transitions avoid reentrant machine lock deadlock', async () => {
  const coordinator = new RunTransitionCoordinator(async () => 'machine-a');
  const runEntered = deferred();
  const releaseRun = deferred();
  const events: string[] = [];
  const machine = coordinator.withMachine('machine-a', async () => {
    events.push('machine:start');
    await coordinator.withRunWhileMachineHeld('run-a', async () => {
      events.push('machine:run');
      runEntered.resolve();
      await releaseRun.promise;
    });
    events.push('machine:end');
  });
  await runEntered.promise;

  const external = coordinator.withRun('run-a', async () => {
    events.push('external');
  });
  await Promise.resolve();
  assert.deepEqual(events, ['machine:start', 'machine:run']);
  releaseRun.resolve();
  await Promise.all([machine, external]);
  assert.deepEqual(events, ['machine:start', 'machine:run', 'machine:end', 'external']);
});

test('different machines and runs do not block each other', async () => {
  const coordinator = new RunTransitionCoordinator(async (runId) =>
    runId === 'run-a' ? 'machine-a' : 'machine-b',
  );
  const gate = deferred();
  const first = coordinator.withRun('run-a', async () => gate.promise);
  let secondRan = false;
  await coordinator.withRun('run-b', async () => {
    secondRan = true;
  });
  assert.equal(secondRan, true);
  gate.resolve();
  await first;
});
