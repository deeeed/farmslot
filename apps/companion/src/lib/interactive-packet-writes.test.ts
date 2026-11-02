import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { Run, RunGetResult } from '@farmslot/protocol';
import {
  type ResourceQuery,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { Methods } from '../../../../packages/protocol/src/rpc/registry';
import { buildRunResolveDecisionParams } from '../../../../packages/protocol/src/runs/decision-resolution';
import { operatorMessageInput } from '../../../../packages/review-dispatch/src/operator-message';

const states = new Map<string, ResourceQueryState>();
const cache = {
  read(query: ResourceQuery<unknown>): ResourceQueryState {
    return states.get(query.id) ?? { status: 'loading' };
  },
};

mock.module('./resource-cache', {
  namedExports: {
    getResourceCache: () => cache,
    getResourceWorkspaceAccess: () => 'farm',
    getResourceWorkspaceKey: () => 'workspace',
    subscribeResourceCache: () => () => {},
  },
});
mock.module('../store/connection', {
  namedExports: {
    useConnectionStore: {
      getState: () => ({
        client: { connectionState: 'connected' },
        status: 'connected',
        workspaceAccess: 'farm',
        signedOut: false,
      }),
      subscribe: () => () => {},
    },
  },
});
mock.module('./notifications', { namedExports: { notifyDecision: async () => {} } });
// What the write and the run.get check use, from their own modules: the package indexes and
// the run collections' sync load in seconds and none of them is under test here.
mock.module('@farmslot/protocol', { namedExports: { Methods, buildRunResolveDecisionParams } });
mock.module('@farmslot/review-dispatch', { namedExports: { operatorMessageInput } });
mock.module('./gateway-run-sync', {
  namedExports: {
    NativeRunCollections: class {},
    nativeDecisionsQuery: undefined,
    nativeFleetQuery: undefined,
    nativeRunListVersionLists: undefined,
  },
});

function run(): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'human-gating',
    project: 'example-mobile',
    ticketOrPr: 'PR-1',
    summary: 'Fix it',
    slotId: 'slot-1',
    branch: 'fix/run-1',
    taskFile: '/repo/TASK.md',
    steps: [{ name: 'monitor', status: 'running' }],
    decisions: [
      {
        id: 'decision-1',
        type: 'plan_confirmation',
        title: 'Approve the plan',
        description: 'Plan ready',
        actions: [{ id: 'approve', label: 'Approve', style: 'primary' }],
        createdAt: '2026-11-02T00:00:00.000Z',
      },
    ],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
}

const runQuery = resourceQuery<RunGetResult>('run.get', { runId: 'run-1' });
const send = { kind: 'terminal.send', text: 'Approve plan' } as const;
const resolve = {
  kind: 'decision.resolve',
  decisionId: 'decision-1',
  actionId: 'approve',
} as const;

function recordingClient() {
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    requests,
    sent: () => requests.map(({ method }) => method),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return {};
    },
  };
}

test('a list row on screen sends nothing while run.get has not answered', async () => {
  const { sendInteractivePacketWrite } = await import('./interactive-packet-writes');
  states.delete(runQuery.id);
  const client = recordingClient();
  const row = run();
  for (const request of [send, resolve])
    await assert.rejects(
      sendInteractivePacketWrite(client, row, request),
      /Wait for the current run before acting/u,
    );
  assert.deepEqual(client.sent(), []);
});

test('a list row sends nothing once run.get has answered with its own run', async () => {
  const { sendInteractivePacketWrite } = await import('./interactive-packet-writes');
  states.set(runQuery.id, { status: 'ready', data: { run: run() } });
  const client = recordingClient();
  for (const request of [send, resolve])
    await assert.rejects(sendInteractivePacketWrite(client, run(), request), /The run changed/u);
  assert.deepEqual(client.sent(), []);
});

test("run.get's own run sends both writes, built from it", async () => {
  const { sendInteractivePacketWrite } = await import('./interactive-packet-writes');
  const current = run();
  states.set(runQuery.id, { status: 'ready', data: { run: current } });
  const client = recordingClient();
  await sendInteractivePacketWrite(client, current, send);
  await sendInteractivePacketWrite(client, current, resolve);
  assert.deepEqual(client.sent(), ['terminal.send', 'run.resolveDecision']);
  // The resolution is built from the run the readiness check returned.
  const [decision] = current.decisions;
  assert.deepEqual(
    client.requests[1]?.params,
    buildRunResolveDecisionParams({ runId: current.id, decision, actionId: 'approve' }),
  );
});
