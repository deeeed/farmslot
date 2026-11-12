// Entity sync through the production websocket server: observed read shapes and the
// per-principal filtering of pushed entities on the real broadcast path.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  type EventFrame,
  Events,
  type FleetStatus,
  type MachineHealth,
  type PRStatus,
  type ResourceChangedPayload,
  type ResponseFrame,
  type SlotStatus,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { broadcastEvent, createWebSocketServer } = await import('../server.js');
const { setCachedFleetForTests } = await import('../fleet/state.js');

function slot(id: string): SlotStatus {
  return {
    slot: id,
    machine: 'mac-a',
    platform: 'macos',
    project: 'demo',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  };
}

const pr: PRStatus = {
  pr: 1,
  title: 'One',
  summary: null,
  repo: 'o/r',
  headRef: null,
  project: 'demo',
  slot: null,
  session: null,
  checks: [],
  checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
  allPassed: false,
  anyFailed: false,
  failedNames: [],
  botComments: [],
  actionableBotComments: [],
  prState: 'OPEN',
  merged: false,
  mergeable: 'MERGEABLE',
  mergeConflict: false,
  reviewDecision: '',
  recommendation: 'WORKING',
};

const machine: MachineHealth = { machine: 'mac-a', online: true, headroom: 'green' };

async function startServer() {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-entity-sync-reads-'));
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  const sockets: WebSocket[] = [];
  let requestId = 0;
  const request = (ws: WebSocket, method: string, params: unknown, observed = false) => {
    const id = `entity-${++requestId}`;
    return new Promise<ResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
      const receive = (data: WebSocket.RawData) => {
        const frame: ResponseFrame = JSON.parse(data.toString());
        if (frame.type !== 'res' || frame.id !== id) return;
        clearTimeout(timer);
        ws.off('message', receive);
        resolve(frame);
      };
      ws.on('message', receive);
      ws.send(
        JSON.stringify({
          type: 'req',
          id,
          method,
          params,
          ...(observed ? { resourceRead: { version: 1 } } : {}),
        }),
      );
    });
  };
  /** A socket authenticated as a fresh principal with these global roles. */
  const connect = async (roles: Array<'admin' | 'operator'>) => {
    const principal = auth.writer.createPrincipal(
      { type: 'service', displayName: `entity ${roles.join('+') || 'none'}` },
      roles.map((role) => ({ role, scope: { kind: 'global' as const } })),
    );
    const credential = auth.writer.issueCredential(principal.id, 'entity sync test');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(ws);
    const changes: ResourceChangedPayload[] = [];
    /** Each `fleet.updated` frame as it crossed the socket. */
    const fleetUpdates: string[] = [];
    ws.on('message', (data) => {
      const frame: EventFrame = JSON.parse(data.toString());
      if (frame.type === 'event' && frame.event === Events.RESOURCE_CHANGED)
        changes.push(frame.payload as ResourceChangedPayload);
      if (frame.type === 'event' && frame.event === Events.FLEET_UPDATED)
        fleetUpdates.push(data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const connected = await request(ws, 'auth.connect', {
      clientKind: 'ui',
      token: credential.secret,
    });
    assert.equal(connected.ok, true, JSON.stringify(connected.error));
    return { ws, changes, fleetUpdates };
  };
  return {
    request,
    connect,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const fleet: FleetStatus = {
  checkedAt: '2026-11-12T00:00:00.000Z',
  slots: [slot('a'), slot('b')],
  summary: {
    total: 2,
    ready: 2,
    busy: 0,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 0,
  },
};

test('observed fleet.status versions and ids reads answer with a stamp', async (t) => {
  setCachedFleetForTests(fleet);
  const harness = await startServer();
  t.after(async () => {
    setCachedFleetForTests(null);
    await harness.close();
  });
  const { ws } = await harness.connect(['admin']);

  const versions = await harness.request(ws, 'fleet.status', { versions: true }, true);
  assert.equal(versions.ok, true, JSON.stringify(versions.error));
  const listing = versions.payload as {
    versions: Array<{ id: string }>;
    membershipRevision: number;
  };
  assert.deepEqual(
    listing.versions.map((entry) => entry.id),
    ['a', 'b'],
  );
  assert.equal(typeof listing.membershipRevision, 'number');
  assert.ok(
    versions.resourceState?.dependencies.some(
      (dependency) => dependency.key.family === 'slots' && Object.keys(dependency.key).length === 2,
    ),
    'the versions read carries the fleet view stamp',
  );

  const page = await harness.request(ws, 'fleet.status', { ids: ['b', 'gone'] }, true);
  assert.equal(page.ok, true, JSON.stringify(page.error));
  const entities = (page.payload as { entities: SlotStatus[] }).entities;
  assert.deepEqual(
    entities.map((row) => row.slot),
    ['b'],
  );
  assert.equal(entities[0].hostLoad, undefined);

  const invalid = await harness.request(ws, 'fleet.status', { ids: [1] }, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'INVALID_PARAMS');
});

test('F1: fleet.updated carries no fleet to a connection that reads the fleet as entities', async (t) => {
  setCachedFleetForTests(fleet);
  const harness = await startServer();
  t.after(async () => {
    setCachedFleetForTests(null);
    await harness.close();
  });
  // Command Center and Companion read the fleet by versions; the CLI and the TUI read it whole
  // and render the event's fleet.
  const viewer = await harness.connect(['admin']);
  const whole = await harness.connect(['admin']);
  const versions = await harness.request(viewer.ws, 'fleet.status', { versions: true }, true);
  assert.equal(versions.ok, true, JSON.stringify(versions.error));
  assert.equal((await harness.request(whole.ws, 'fleet.status', {})).ok, true);
  viewer.fleetUpdates.length = 0;
  whole.fleetUpdates.length = 0;

  broadcastEvent(Events.FLEET_UPDATED, { fleet });
  const ceiling = performance.now() + 3000;
  while (!(viewer.fleetUpdates.length && whole.fleetUpdates.length) && performance.now() < ceiling)
    await new Promise<void>((resolve) => setImmediate(resolve));

  const payloads = (frames: string[]) =>
    frames.map((frame) => (JSON.parse(frame) as EventFrame).payload);
  assert.deepEqual(payloads(viewer.fleetUpdates), [{}], 'the notice arrives without the fleet');
  assert.deepEqual(payloads(whole.fleetUpdates), [JSON.parse(JSON.stringify({ fleet }))]);
  assert.ok(
    Buffer.byteLength(viewer.fleetUpdates[0]) < 100,
    `the notice is ${Buffer.byteLength(viewer.fleetUpdates[0])} B`,
  );
});

test('pushed entities reach only principals whose read would return them', async (t) => {
  const harness = await startServer();
  t.after(() => harness.close());
  // Connection order is delivery order: the admin's notice comes after the others' decisions.
  const nobody = await harness.connect([]);
  const operator = await harness.connect(['operator']);
  const admin = await harness.connect(['admin']);

  broadcastEvent(Events.RESOURCE_CHANGED, {
    version: 1,
    epoch: 'test-epoch',
    changes: [
      {
        key: { family: 'slot', slotId: 'a' },
        revision: 1,
        kind: 'updated',
        changedEntity: { family: 'slot', version: 'v-slot', entity: slot('a') },
      },
      {
        key: {
          family: 'upstream',
          integration: 'github',
          queryId: 'pr.list:{}',
          prKey: 'o/r/1',
        },
        revision: 1,
        kind: 'updated',
        changedEntity: { family: 'upstream', version: 'v-pr', entity: pr },
      },
      {
        key: { family: 'node', nodeId: 'mac-a' },
        revision: 1,
        kind: 'updated',
        changedEntity: { family: 'node', version: 'v-node', entity: machine },
      },
    ],
  } satisfies ResourceChangedPayload);

  const deadline = Date.now() + 3000;
  while (!admin.changes.length && Date.now() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
  // A response after the notice on the same socket proves any notice for it was already sent.
  await harness.request(operator.ws, 'fleet.status', {});
  await harness.request(nobody.ws, 'fleet.status', {});

  assert.deepEqual(
    admin.changes.flatMap((payload) =>
      payload.changes.map((change) => change.changedEntity?.version),
    ),
    ['v-slot', 'v-pr', 'v-node'],
    'fleet.status and pr.list readers get every pushed entity',
  );
  assert.deepEqual(
    operator.changes.flatMap((payload) => payload.changes.map((change) => change.key.family)),
    ['node'],
    'an operator may read node.health but not fleet.status or pr.list',
  );
  assert.equal(nobody.changes.length, 0);
});
