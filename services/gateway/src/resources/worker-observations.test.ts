import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';

import { resourceRevisions } from './revisions.js';
import {
  acceptWorkerObservation,
  assertWorkerObservationCurrent,
  requireWorkerObservation,
} from './worker-observations.js';

function socket(): WebSocket {
  return { readyState: 1 } as WebSocket;
}
function expectCode(run: () => unknown, code: string) {
  assert.throws(run, (error) => error instanceof GatewayMethodError && error.code === code);
}

test('worker admission requires support, source receipt and current connection; failure/recovery is explicit', async (t) => {
  const old = socket();
  const current = socket();
  const machine = 'observation-admission-test';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    unregisterByWs(old);
    unregisterByWs(current);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    t.mock.timers.reset();
  });
  const published: ResourceKey[] = [];
  resourceRevisions.setPublisher((packet) => {
    published.push(...packet.changes.map((change) => change.key));
  });
  const flush = async () => {
    await Promise.resolve();
    t.mock.timers.tick(201);
  };
  const workerPublication = async (changed: boolean) => {
    await flush();
    const expected: ResourceKey[] = changed
      ? [
          { family: 'workers', scope: 'farm' },
          { family: 'workers', nodeId: machine },
        ]
      : [];
    assert.deepEqual(published.map(resourceKeyId).sort(), expected.map(resourceKeyId).sort());
    published.length = 0;
  };
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
  await flush();
  published.length = 0;
  expectCode(() => requireWorkerObservation(machine), 'RESOURCE_OBSERVATION_UNSUPPORTED');
  assert.equal(
    acceptWorkerObservation(old, { status: 'ready', observedAt: 1, panes: [] }),
    undefined,
  );
  await workerPublication(false);
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
    { workers: 1 },
    () => true,
  );
  await flush();
  published.length = 0;
  expectCode(() => requireWorkerObservation(machine), 'RESOURCE_SOURCE_UNAVAILABLE');
  assert.equal(
    acceptWorkerObservation(old, { status: 'ready', observedAt: 2, panes: [] }),
    undefined,
  );
  await workerPublication(false);
  acceptWorkerObservation(current, {
    machine: 'forged-other-owner',
    status: 'ready',
    observedAt: 3,
    panes: [],
  });
  const admitted = requireWorkerObservation(machine);
  assert.equal(admitted.node.machine, machine);
  await workerPublication(true);
  acceptWorkerObservation(current, {
    status: 'unavailable',
    observedAt: 4,
    error: { code: 'SAMPLE', message: 'tmux unavailable' },
  });
  expectCode(() => assertWorkerObservationCurrent(admitted), 'RESOURCE_SOURCE_CHANGED');
  expectCode(() => requireWorkerObservation(machine), 'RESOURCE_SOURCE_UNAVAILABLE');
  await workerPublication(true);
  acceptWorkerObservation(current, { status: 'ready', observedAt: 5, panes: [] });
  assert.deepEqual(requireWorkerObservation(machine).panes, []);
  await workerPublication(true);
  const beforeDisconnect = requireWorkerObservation(machine);
  unregisterByWs(current);
  expectCode(() => assertWorkerObservationCurrent(beforeDisconnect), 'RESOURCE_SOURCE_CHANGED');
  assert.equal(
    acceptWorkerObservation(current, { status: 'ready', observedAt: 6, panes: [] }),
    undefined,
  );
});

test('a source write during a read invalidates the held admission token', (t) => {
  const ws = socket();
  const machine = 'observation-write-test';
  let authorized = true;
  t.after(() => unregisterByWs(ws));
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    { workers: 1 },
    () => authorized,
  );
  acceptWorkerObservation(ws, { status: 'ready', observedAt: 1, panes: [] });
  const held = requireWorkerObservation(machine);
  acceptWorkerObservation(ws, { status: 'ready', observedAt: 2, panes: [] });
  expectCode(() => assertWorkerObservationCurrent(held), 'RESOURCE_SOURCE_CHANGED');
  authorized = false;
  expectCode(() => requireWorkerObservation(machine), 'RESOURCE_SOURCE_UNAVAILABLE');
});
