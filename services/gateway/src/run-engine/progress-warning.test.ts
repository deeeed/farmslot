import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RunStep } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const { makeRun } = await import('./test-fixtures.js');
const { deriveRunnerSessionDeliveryState } = await import('../runners/observability-files.js');
let run = makeRun({
  status: 'monitoring',
  steps: [
    { name: 'monitor', status: 'running' },
    { name: 'review', status: 'running' },
  ],
});
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    updateRunStep: (_id: string, name: RunStep['name'], patch: Partial<RunStep>) => {
      run = {
        ...run,
        steps: run.steps.map((step) => (step.name === name ? { ...step, ...patch } : step)),
      };
    },
  },
});
const { reportRunnerProgressWarning, runnerTokenProgressWarning } =
  await import('./progress-warning.js');
const started = 1_800_000_000_000;
const active = deriveRunnerSessionDeliveryState(
  {
    session_id: 'pi',
    event: 'UserPromptSubmit',
    observedAt: started,
    turnActive: true,
    turnStartedAt: started,
    lastTokenProgressAt: started,
  },
  'pi',
);
assert.ok(active);

test('native usage can flag an active turn without declaring it idle', () => {
  assert.equal(runnerTokenProgressWarning(active, started + 299_999), null);
  assert.match(runnerTokenProgressWarning(active, started + 300_000)!, /5 minutes/);
  assert.equal(active.value, 'active');
  assert.equal(runnerTokenProgressWarning({ ...active, value: 'idle' }, started + 900_000), null);
  assert.equal(
    runnerTokenProgressWarning(
      { ...active, lastTokenProgressAt: started + 300_000 },
      started + 300_001,
    ),
    null,
  );
  assert.equal(
    runnerTokenProgressWarning({ ...active, lastTokenProgressAt: undefined }, started + 900_000),
    null,
  );
  assert.equal(runnerTokenProgressWarning({ ...active, source: 'pane' }, started + 900_000), null);
});

test('initial work and fix warnings dedupe and clear without changing run lifecycle', () => {
  for (const name of ['monitor', 'review'] as const) {
    assert.equal(reportRunnerProgressWarning(run.id, name, active, started + 300_000), true);
    assert.equal(reportRunnerProgressWarning(run.id, name, active, started + 300_000), false);
  }
  assert.equal(run.status, 'monitoring');
  assert.deepEqual(run.decisions, []);
  assert.deepEqual(
    run.steps.map(({ status }) => status),
    ['running', 'running'],
  );
  const advanced = { ...active, lastTokenProgressAt: started + 300_000 };
  assert.equal(reportRunnerProgressWarning(run.id, 'monitor', advanced, started + 300_001), true);
  assert.equal(run.steps[0].detail, undefined);
  run.steps[1].detail = 'Fix: 2/6 steps';
  assert.equal(reportRunnerProgressWarning(run.id, 'review', advanced, started + 300_001), true);
  assert.equal(run.steps[1].detail, 'Fix: 2/6 steps');
});
