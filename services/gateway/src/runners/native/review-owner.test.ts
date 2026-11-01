import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import type { SlotVars } from '../../core/config.js';
import { registerNode, unregisterByWs } from '../../fleet/machine-registry.js';
import {
  isNodeTransportUnavailableError,
  NodeTransportUnavailableError,
} from '../../fleet/node-rpc.js';
import { makeRun } from '../../run-engine/test-fixtures.js';

import { nativeReviewerOwner, waitForNativeReviewerOwner } from './review-owner.js';

const vars: SlotVars = {
  slotId: 'f303-mm-3',
  machine: 'f303-remote',
  host: 'f303-remote.example',
  repo: '/fixture',
  remoteRepo: '/fixture',
  projectName: 'f303-proof',
  platform: 'ios',
  sshUser: '',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  cursorPath: '',
  grokPath: '',
  opencodePath: '',
  dispatchCmd: '',
  recycleCmd: '',
  session: 'mm-3',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  resourceVars: {},
};
const run = makeRun({ id: 'f303-run', slotId: vars.slotId });
const notReconnected = () =>
  new NodeTransportUnavailableError(
    vars.machine,
    'not-connected',
    'Native execution node is temporarily unavailable',
  );

test('a review node that has not reconnected after a reload is a wait, not a missing owner', () => {
  assert.throws(
    () => nativeReviewerOwner(run, vars),
    (error: unknown) =>
      isNodeTransportUnavailableError(error) && /temporarily unavailable/.test(error.message),
  );
});

test('a connected review node without an owner is still a permanent refusal', () => {
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      void raw;
    },
  } as WebSocket;
  registerNode(vars.machine, 1, ws);
  try {
    assert.throws(
      () => nativeReviewerOwner(run, vars),
      (error: unknown) =>
        !isNodeTransportUnavailableError(error) &&
        error instanceof Error &&
        /no native execution owner/.test(error.message),
    );
  } finally {
    unregisterByWs(ws);
  }
});

test('a reload re-entering REVIEW waits for the node and then resolves its owner', async () => {
  // Reload sequence: the reviewer reattach asks for the owner twice before the node reconnects.
  let attempts = 0;
  let checks = 0;
  const owner = await waitForNativeReviewerOwner(run, vars, {
    intervalMs: 1,
    check: () => checks++,
    resolve: () => {
      attempts++;
      if (attempts < 3) throw notReconnected();
      return 'farm-automation';
    },
  });
  assert.equal(owner, 'farm-automation');
  assert.equal(attempts, 3);
  assert.equal(checks, 2);
});

test('the wait re-reads the node registry, so a node that returns without an owner refuses', async () => {
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      void raw;
    },
  } as WebSocket;
  let attempts = 0;
  try {
    await assert.rejects(
      waitForNativeReviewerOwner(run, vars, {
        intervalMs: 1,
        resolve: (current, slot) => {
          attempts++;
          if (attempts === 2) registerNode(vars.machine, 1, ws);
          return nativeReviewerOwner(current, slot);
        },
      }),
      /no native execution owner/,
    );
    assert.equal(attempts, 2);
  } finally {
    unregisterByWs(ws);
  }
});

test('a permanent owner refusal is not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    waitForNativeReviewerOwner(run, vars, {
      intervalMs: 1,
      resolve: () => {
        attempts++;
        throw new Error('The review node does not support owned native sessions');
      },
    }),
    /does not support owned native sessions/,
  );
  assert.equal(attempts, 1);
});

test('an outage longer than the wait still fails the review', async () => {
  await assert.rejects(
    waitForNativeReviewerOwner(run, vars, {
      intervalMs: 1,
      timeoutMs: 20,
      resolve: () => {
        throw notReconnected();
      },
    }),
    (error: unknown) => isNodeTransportUnavailableError(error),
  );
});

test('a review superseded while it waits stops waiting', async () => {
  let attempts = 0;
  await assert.rejects(
    waitForNativeReviewerOwner(run, vars, {
      intervalMs: 1,
      check: () => {
        throw new Error('Native review was superseded by another run action');
      },
      resolve: () => {
        attempts++;
        throw notReconnected();
      },
    }),
    /superseded/,
  );
  assert.equal(attempts, 1);
});
