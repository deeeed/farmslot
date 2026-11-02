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

// F314: c07ce071's cancel on macpro-audiolab-2 waited 482 s for machine:macpro while another
// run's publish package refresh held it, and its archive waited behind that cancel.
test('run transitions on two slots of one machine do not wait for each other', async () => {
  const coordinator = new RunTransitionCoordinator(async () => 'machine-a');
  const packagePrep = deferred();
  const prepEntered = deferred();
  const prep = coordinator.withRun('run-a', async () => {
    prepEntered.resolve();
    await packagePrep.promise;
  });
  await prepEntered.promise;
  let cancelled = false;
  await coordinator.withRun('run-b', async () => {
    cancelled = true;
  });
  assert.equal(cancelled, true, "run-b's cancel finished while run-a's package prep still ran");
  packagePrep.resolve();
  await prep;
});

test('a machine workflow waits for run transitions in flight, and later ones wait for it', async () => {
  const coordinator = new RunTransitionCoordinator(async () => 'machine-a');
  const releaseFirst = deferred();
  const firstEntered = deferred();
  const events: string[] = [];
  const first = coordinator.withRun('run-a', async () => {
    events.push('run-a:start');
    firstEntered.resolve();
    await releaseFirst.promise;
    events.push('run-a:end');
  });
  await firstEntered.promise;
  const machine = coordinator.withMachine('machine-a', async () => {
    events.push('machine');
  });
  const later = coordinator.withRun('run-b', async () => {
    events.push('run-b');
  });
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  assert.deepEqual(events, ['run-a:start'], 'the workflow and the later run both wait');
  releaseFirst.resolve();
  await Promise.all([first, machine, later]);
  assert.deepEqual(events, ['run-a:start', 'run-a:end', 'machine', 'run-b']);
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
  // The same run queues on its run key; a machine workflow waits for both run transitions.
  const sameRun = coordinator.withRun('run-a', async () => {});
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  const machine = coordinator.withMachine('machine-a', async () => {});
  const deadline = Date.now() + 2_000;
  while (warnings.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  releaseRun.resolve();
  await Promise.all([holder, sameRun, machine]);
  for (const key of ['run:run-a', 'machine:machine-a'])
    assert.ok(
      warnings.some((warning) =>
        new RegExp(`has waited \\d+s for ${key}; held by .*heldRunOperation`).test(warning),
      ),
      `the holder of ${key} is named by the operation that took it`,
    );
});
