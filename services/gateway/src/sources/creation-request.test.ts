import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunCreateParams } from '@farmslot/protocol';

import { captureRunCreationRequest } from './creation-request.js';

test('replanning retains caller intent and optional-field presence without retaining unknown fields', () => {
  const params: RunCreateParams = {
    flowType: 'dev',
    project: 'demo',
    ticketOrPr: 'PLAN-1',
    allowedSlots: ['slot-1'],
    reviewMode: 'warm',
    pressureOverride: { machine: 'node-1', pressureGeneration: 'generation-1', reason: 'fixture' },
    startRefSkipPrepareVerified: true,
  };
  const request = captureRunCreationRequest(Object.assign(params, { unknownField: 'ignored' }));
  assert.equal('unknownField' in request, false);
  assert.equal('startRefSkipPrepareVerified' in request, false);
  assert.equal('mode' in request, false);
  assert.equal(request.reviewMode, 'warm');
  request.allowedSlots!.push('slot-2');
  assert.deepEqual(params.allowedSlots, ['slot-1']);
  assert.deepEqual(request.pressureOverride, params.pressureOverride);
  assert.notEqual(request.pressureOverride, params.pressureOverride);
});
