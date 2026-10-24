import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';

import {
  assertProgressOwnerAdmitted,
  captureProgressProducer,
  registerProgressObservation,
} from './progress-observations.js';
import { publishProgressResources } from './run-changes.js';

test('local source admission does not require a node or globally enabled branch watchers', () => {
  captureProgressProducer({ host: 'localhost', machine: 'local' })();
});

test('a remote mutable source refuses an old node and fences source replacement and revocation', (t) => {
  const machine = 'progress-admission-remote';
  const old = { readyState: 1 } as WebSocket;
  const current = { readyState: 1 } as WebSocket;
  let authorized = true;
  t.after(() => {
    unregisterByWs(old);
    unregisterByWs(current);
  });
  const io = { host: '192.0.2.23', machine };
  registerNode(
    machine,
    1,
    old,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    {},
    () => true,
  );
  assert.throws(() => captureProgressProducer(io), { code: 'RESOURCE_OBSERVATION_UNSUPPORTED' });
  registerNode(
    machine,
    2,
    current,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    { files: 1 },
    () => authorized,
  );
  const check = captureProgressProducer(io);
  check();
  authorized = false;
  assert.throws(check, { code: 'RESOURCE_OBSERVATION_UNAVAILABLE' });
  authorized = true;
  registerNode(
    machine,
    3,
    old,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    { files: 1 },
    () => true,
  );
  assert.throws(check, { code: 'RESOURCE_OBSERVATION_UNAVAILABLE' });
});

test('review owner admission requires exact context/path and propagates failure, recovery and writes during reads', (t) => {
  let current = true;
  let failed = false;
  const owner = {
    runId: 'review-owner',
    contextId: 'review-2',
    path: '/owned/REVIEW.md',
    current: () => current,
    check: () => {
      if (failed) throw new Error('watch failed');
    },
  };
  const unregister = registerProgressObservation(owner);
  t.after(unregister);
  assert.throws(() => assertProgressOwnerAdmitted(owner.runId, 'review-1'), {
    code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
  });
  assert.throws(
    () => assertProgressOwnerAdmitted(owner.runId, owner.contextId, '/foreign/REVIEW.md'),
    { code: 'RESOURCE_OBSERVATION_UNAVAILABLE' },
  );
  const held = assertProgressOwnerAdmitted(owner.runId, owner.contextId, owner.path);
  publishProgressResources('', owner.runId, owner.contextId);
  assert.throws(held, { code: 'RESOURCE_OBSERVATION_CHANGED' });
  failed = true;
  assert.throws(() => assertProgressOwnerAdmitted(owner.runId, owner.contextId), /watch failed/);
  failed = false;
  assertProgressOwnerAdmitted(owner.runId, owner.contextId)();
  current = false;
  assert.throws(() => assertProgressOwnerAdmitted(owner.runId, owner.contextId), {
    code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
  });
});
