import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runtimePostureApply,
  runtimePosturePreview,
  runtimePostureStatus,
} from './runtime-posture.js';

const runId = 'run-a';

test('posture RPC params are validated before reaching the run store', async () => {
  await assert.rejects(runtimePostureStatus({ runId: '  ' }), /runId must be a non-empty string/);
  await assert.rejects(
    runtimePosturePreview({ runId, posture: 'sleeping' as never }),
    /posture must be one of/,
  );
  await assert.rejects(
    runtimePosturePreview({ runId, gateChoice: 'whatever' as never }),
    /gateChoice must be one of/,
  );
  await assert.rejects(
    runtimePostureApply({ runId, operationId: '   ' }),
    /operationId must be a non-empty string/,
  );
});

test('malformed proof requirements are rejected field by field', async () => {
  const cases: Array<[unknown, RegExp]> = [
    ['not-an-array', /proofRequirements must be an array/],
    [[null], /proofRequirements\[0\] must be an object/],
    [[{ reason: 'r', mode: 'state' }], /proofRequirements\[0\]\.capabilityId/],
    [[{ capabilityId: 'c', mode: 'state' }], /proofRequirements\[0\]\.reason/],
    [[{ capabilityId: 'c', reason: 'r', mode: 'telepathy' }], /proofRequirements\[0\]\.mode/],
    [
      [{ capabilityId: 'c', reason: 'r', mode: 'state', parameters: [] }],
      /proofRequirements\[0\]\.parameters must be an object/,
    ],
    [
      [{ capabilityId: 'c', reason: 'r', mode: 'state', parameters: 'x' }],
      /proofRequirements\[0\]\.parameters must be an object/,
    ],
  ];
  for (const [proofRequirements, expected] of cases) {
    await assert.rejects(
      runtimePosturePreview({ runId, proofRequirements: proofRequirements as never }),
      expected,
      `expected ${JSON.stringify(proofRequirements)} to be rejected`,
    );
  }
});
