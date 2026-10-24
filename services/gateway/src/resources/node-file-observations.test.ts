import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import type { NodeFsWatchResult } from '@farmslot/protocol';

import { getNode, registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';

import {
  acceptNodeFileObservation,
  assertFileObservationsAdmitted,
  forgetNodeFileObservation,
  watchNodeFile,
} from './node-file-observations.js';

function producer(machine: string, supported: boolean, ack: NodeFsWatchResult) {
  const ws = {
    readyState: 1,
    send(raw: string) {
      const frame = JSON.parse(raw) as { id: string };
      handleNodeResponse(frame.id, true, ack, undefined, undefined, ws);
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supported ? { files: 1 } : undefined,
  );
  return { ws, node: getNode(machine)! };
}

const healthy: NodeFsWatchResult = {
  watching: true,
  observations: 1,
  initial: { kind: 'updated', content: 'initial' },
};

test('file observation admission rejects mixed capability and missing initial ACK', async (t) => {
  for (const [supported, ack] of [
    [false, healthy],
    [true, { watching: true, observations: 1 }],
  ] as const) {
    const { ws, node } = producer(`file-mixed-${supported}`, supported, ack);
    let id = '';
    t.after(() => {
      forgetNodeFileObservation(id);
      unregisterByWs(ws);
    });
    await watchNodeFile(
      node,
      '/task.md',
      (value) => {
        id = value;
      },
      () => {},
    );
    assert.throws(() => assertFileObservationsAdmitted([id]), {
      code: 'RESOURCE_OBSERVATION_UNSUPPORTED',
    });
  }
});

test('file failures revoke readiness, recovery invalidates and writes retire in-flight reads', async (t) => {
  const { ws, node } = producer('file-recovery', true, healthy);
  let id = '';
  let invalidations = 0;
  t.after(() => {
    forgetNodeFileObservation(id);
    unregisterByWs(ws);
  });
  await watchNodeFile(
    node,
    '/task.md',
    (value) => {
      id = value;
    },
    () => {
      invalidations++;
    },
  );
  const postRead = assertFileObservationsAdmitted([id]);
  const failed = acceptNodeFileObservation(ws, {
    requestId: id,
    machine: 'forged-machine',
    path: '/task.md',
    kind: 'error',
    content: '',
    error: { code: 'EACCES', message: 'Permission denied' },
  });
  assert.equal(failed?.machine, node.machine);
  assert.throws(postRead, { code: 'RESOURCE_OBSERVATION_CHANGED' });
  assert.throws(() => assertFileObservationsAdmitted([id]), {
    code: 'RESOURCE_OBSERVATION_FAILED',
  });
  acceptNodeFileObservation(ws, {
    requestId: id,
    machine: node.machine,
    path: '/task.md',
    content: 'recovered',
  });
  assertFileObservationsAdmitted([id])();
  assert.equal(invalidations, 3);
});

test('source replacement and wrong paths cannot publish or complete a former read', async (t) => {
  const old = producer('file-replaced', true, healthy);
  let id = '';
  t.after(() => {
    forgetNodeFileObservation(id);
    unregisterByWs(old.ws);
  });
  await watchNodeFile(
    old.node,
    '/task.md',
    (value) => {
      id = value;
    },
    () => {},
  );
  const postRead = assertFileObservationsAdmitted([id]);
  assert.equal(
    acceptNodeFileObservation(old.ws, {
      requestId: id,
      machine: old.node.machine,
      path: '/other.md',
      content: 'wrong path',
    }),
    undefined,
  );
  const replacement = producer(old.node.machine, true, healthy);
  t.after(() => {
    unregisterByWs(replacement.ws);
  });
  for (const ws of [old.ws, replacement.ws])
    assert.equal(
      acceptNodeFileObservation(ws, {
        requestId: id,
        machine: old.node.machine,
        path: '/task.md',
        content: 'late data',
      }),
      undefined,
    );
  assert.throws(postRead, { code: 'RESOURCE_OBSERVATION_CHANGED' });
  assert.throws(() => assertFileObservationsAdmitted([id]), {
    code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
  });
});

test('armed watch with an initial source failure cannot yield ready until a recovery event', async (t) => {
  const { ws, node } = producer('file-initial-error', true, {
    watching: true,
    observations: 1,
    initial: { kind: 'error', content: '', error: { message: 'Initial read failed' } },
  });
  let id = '';
  t.after(() => {
    forgetNodeFileObservation(id);
    unregisterByWs(ws);
  });
  await watchNodeFile(
    node,
    '/task.md',
    (value) => {
      id = value;
    },
    () => {},
  );
  assert.throws(() => assertFileObservationsAdmitted([id]), {
    code: 'RESOURCE_OBSERVATION_FAILED',
  });
  acceptNodeFileObservation(ws, {
    requestId: id,
    machine: node.machine,
    path: '/task.md',
    content: 'fixed',
  });
  assertFileObservationsAdmitted([id])();
  forgetNodeFileObservation(id);
  assert.throws(() => assertFileObservationsAdmitted([id]), {
    code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
  });
});
