// Workspace inspections under entity sync, through the production server (ADR-071 Amendment 4).
// A viewer that applies pushed slots sends no fleet read, so the slot publication it receives is
// what starts the inspections that read started. With no viewer connected nothing is inspected.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  Events,
  type FleetStatus,
  type ResourceChangedPayload,
  type ResponseFrame,
  type SlotEntity,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../server.js');
const { setCachedFleetForTests, setTaskProgressOverlay } = await import('../fleet/state.js');
const { fleetStatusIds } = await import('../fleet/slot-entities.js');

const SLOT = 'published-to-viewer';

const fleet: FleetStatus = {
  checkedAt: '2026-11-12T00:00:00.000Z',
  slots: [
    {
      slot: SLOT,
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
    },
  ],
  summary: {
    total: 1,
    ready: 1,
    busy: 0,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 0,
  },
};

/** Lets publications, zero-delay timers and a local inspection run. */
async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

test('a slot publication starts workspace inspections only while a viewer is connected', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-slot-publication-'));
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  initServerGlobals();
  setCachedFleetForTests(fleet);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  const sockets: WebSocket[] = [];
  t.after(async () => {
    setTaskProgressOverlay(SLOT, null, 0, 0);
    setCachedFleetForTests(null);
    resetServerGlobalsForTests();
    for (const ws of sockets) ws.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const inspected = async () => {
    const row = (await fleetStatusIds([SLOT])).entities[0];
    return row.workspace !== undefined || row.workspaceError !== undefined;
  };

  // No viewer: the publication reaches nobody, and nothing inspects the slot.
  setTaskProgressOverlay(SLOT, 'Build', 1, 3);
  await turns(60);
  assert.equal(await inspected(), false, 'no inspection without a viewer');

  // A viewer connects and receives the next slot publication.
  const principal = auth.writer.createPrincipal({ type: 'service', displayName: 'fleet viewer' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = auth.writer.issueCredential(principal.id, 'slot publication test');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  sockets.push(ws);
  const pushed: SlotEntity[] = [];
  ws.on('message', (data) => {
    // The socket's frames are this gateway's own JSON; only change notifications are read.
    const frame: { type: string; event?: string; payload?: ResourceChangedPayload } = JSON.parse(
      data.toString(),
    );
    if (frame.type !== 'event' || frame.event !== Events.RESOURCE_CHANGED) return;
    for (const change of frame.payload?.changes ?? [])
      if (change.changedEntity?.family === 'slot' && change.changedEntity.entity)
        pushed.push(change.changedEntity.entity);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const connected = await new Promise<ResponseFrame>((resolve) => {
    const receive = (data: WebSocket.RawData) => {
      const frame: ResponseFrame = JSON.parse(data.toString());
      if (frame.type !== 'res' || frame.id !== 'viewer-connect') return;
      ws.off('message', receive);
      resolve(frame);
    };
    ws.on('message', receive);
    ws.send(
      JSON.stringify({
        type: 'req',
        id: 'viewer-connect',
        method: 'auth.connect',
        params: { clientKind: 'ui', token: credential.secret },
      }),
    );
  });
  assert.equal(connected.ok, true, JSON.stringify(connected.error));

  setTaskProgressOverlay(SLOT, 'Build', 2, 3);
  const outcome = () => pushed.find((row) => row.workspace ?? row.workspaceError);
  const deadline = Date.now() + 3000;
  while (!outcome() && Date.now() < deadline) await turns(1);
  // No pool declares this slot, so its inspection reports why; the viewer gets that outcome.
  assert.ok(
    outcome(),
    'the inspection the publication started reaches the viewer as a pushed slot',
  );
  assert.equal(outcome()?.taskPhase, 'Build 2/3');
});
