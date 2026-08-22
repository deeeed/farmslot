import assert from 'node:assert/strict';
import test from 'node:test';

import { refreshedAdmissionRefForAdmittedPreview } from './find-slot-step.js';

const admitted = {
  outcome: 'admitted' as const,
  state: 'green',
  machine: 'mini',
  evidence: { generation: 'mini|gauge|-|new' },
};

test('refreshes preview identity when generation rotated but machine is still admitted', () => {
  const next = refreshedAdmissionRefForAdmittedPreview(
    { machine: 'mini', pressureGeneration: 'mini|gauge|-|old' },
    admitted,
  );
  assert.deepEqual(next, { machine: 'mini', pressureGeneration: 'mini|gauge|-|new' });
});

test('does not refresh when preview generation still matches', () => {
  const next = refreshedAdmissionRefForAdmittedPreview(
    { machine: 'mini', pressureGeneration: 'mini|gauge|-|new' },
    admitted,
  );
  assert.equal(next, null);
});

test('does not refresh a rejected machine into a launch', () => {
  const next = refreshedAdmissionRefForAdmittedPreview(
    { machine: 'mini', pressureGeneration: 'mini|gauge|-|old' },
    {
      outcome: 'rejected',
      state: 'sustained-critical',
      machine: 'mini',
      evidence: { generation: 'mini|gauge|-|new' },
    },
  );
  assert.equal(next, null);
});

test('does not refresh override or disabled admission', () => {
  const ref = { machine: 'mini', pressureGeneration: 'mini|gauge|-|old' };
  assert.equal(
    refreshedAdmissionRefForAdmittedPreview(ref, { ...admitted, state: 'override' }),
    null,
  );
  assert.equal(
    refreshedAdmissionRefForAdmittedPreview(ref, { ...admitted, state: 'disabled' }),
    null,
  );
});

test('does not refresh without a client preview identity', () => {
  assert.equal(refreshedAdmissionRefForAdmittedPreview(undefined, admitted), null);
});

test('does not refresh when current admission is missing', () => {
  assert.equal(
    refreshedAdmissionRefForAdmittedPreview(
      { machine: 'mini', pressureGeneration: 'mini|gauge|-|old' },
      null,
    ),
    null,
  );
});
