import assert from 'node:assert/strict';
import test from 'node:test';

import { startRunWithStepAcknowledgement } from './orchestrator.js';

test('startRunWithStepAcknowledgement resolves only after matching step ownership', async () => {
  const proof = await startRunWithStepAcknowledgement('run-a', 4, async (runId, options) => {
    assert.equal(runId, 'run-a');
    assert.equal(options?.expectedGeneration, 4);
    options?.onStepStarted?.({
      runId,
      generation: 4,
      stepName: 'monitor',
      status: 'monitoring',
      acknowledgedAt: '2026-08-21T00:00:00.000Z',
    });
  });

  assert.deepEqual(proof, {
    runId: 'run-a',
    generation: 4,
    stepName: 'monitor',
    status: 'monitoring',
    acknowledgedAt: '2026-08-21T00:00:00.000Z',
  });
});

test('startRunWithStepAcknowledgement propagates a pre-ack engine failure', async () => {
  await assert.rejects(
    () =>
      startRunWithStepAcknowledgement('run-a', 4, async () => {
        throw new Error('engine restart failed');
      }),
    /engine restart failed/,
  );
});

test('startRunWithStepAcknowledgement rejects a return without step acknowledgement', async () => {
  await assert.rejects(
    () => startRunWithStepAcknowledgement('run-a', 4, async () => {}),
    /returned before acknowledging generation 4/,
  );
});
