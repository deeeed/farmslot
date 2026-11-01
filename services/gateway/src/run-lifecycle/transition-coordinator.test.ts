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

test('a transition queued past the warning interval names the operation holding its key', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const coordinator = new RunTransitionCoordinator(async () => 'machine-a', 5);
  const releaseRun = deferred();
  const held = deferred();
  async function heldRunOperation() {
    return coordinator.withRun('run-a', async () => {
      held.resolve();
      await releaseRun.promise;
    });
  }
  const holder = heldRunOperation();
  await held.promise;
  const waiters = [
    coordinator.withRun('run-b', async () => {}),
    coordinator.withMachine('machine-a', async () => {}),
  ];
  const deadline = Date.now() + 2_000;
  while (!warnings.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  releaseRun.resolve();
  await Promise.all([holder, ...waiters]);
  assert.match(
    warnings[0] ?? '',
    /has waited \d+s for machine:machine-a; held by .*heldRunOperation/,
    'the holder is named by the operation that took the key',
  );
});
