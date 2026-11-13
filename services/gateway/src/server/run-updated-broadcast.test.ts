// A run write through the production websocket server reaches a connected client as a
// `run.updated` notice (the run's id and lifecycle), and the client reads the run with run.get.
// The same holds for an event a method emits to its caller only (the per-request `emit`).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import WebSocket from 'ws';

import {
  type EventFrame,
  Events,
  Methods,
  type ResponseFrame,
  type RunGetResult,
  type RunUpdatedPayload,
  type SlotReleaseParams,
} from '@farmslot/protocol';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-updated-broadcast-')));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects', 'home', 'runs'])
  mkdirSync(join(root, dir), { recursive: true });
writeFileSync(join(root, 'CLAUDE.md'), '# Private fixture');
writeFileSync(join(root, 'scripts/dev.sh'), '#!/bin/sh');
writeFileSync(join(root, 'services/gateway/package.json'), '{}');
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_HOME = join(root, 'home');
process.env.FARMSLOT_POOL_DIR = join(root, 'pool');
process.env.FARMSLOT_PROJECTS_DIR = join(root, 'projects');
process.env.FARMSLOT_RUNS_DIR = join(root, 'runs');

await import('../runtime/mock-pty.test-support.js');
const { createRun, getAllRuns, getRun, loadAllRuns, persistRunNow, updateRun } =
  await import('../runs/store.js');
// slot.release emits to its caller only. A real release needs a node; this one only emits the
// run.updated a release of the run's slot emits (release-run-ownership.ts), through the gateway's
// per-request emit.
const realSlotMethods = await import('../methods/slot/index.js');
mock.module('../methods/slot.js', {
  namedExports: {
    ...realSlotMethods,
    slotRelease: async (
      params: SlotReleaseParams,
      emit: (event: string, payload: unknown) => void,
    ) => {
      emit(Events.RUN_UPDATED, { run: getRun(params.expectedRunId ?? '') });
      return { released: true };
    },
  },
});
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const { createWebSocketServer } = await import('../server.js');
await loadAllRuns();

test('a run write reaches the client as a run.updated notice, not the whole run', async (t) => {
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: join(root, 'home') });
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(getAllRuns().map((run) => persistRunNow(run)));
    rmSync(root, { recursive: true, force: true });
  });

  const admin = auth.writer.createPrincipal({ type: 'service', displayName: 'Run viewer' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = auth.writer.issueCredential(admin.id, 'run.updated broadcast test');
  // Setup-time seed: a run whose detail is large, as on the operator farm.
  const run = createRun({ project: 'farmslot-farm', flowType: 'dev', ticketOrPr: 'DEV-NOTICE' });
  updateRun(run.id, {
    ticketData: {
      source: 'manual',
      title: 'Notice',
      description: 'x'.repeat(100_000),
      acceptanceCriteria: [],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });

  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`);
  t.after(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const updates: Array<{ payload: RunUpdatedPayload; bytes: number }> = [];
  let requests = 0;
  ws.on('message', (data) => {
    const frame: EventFrame = JSON.parse(data.toString());
    if (frame.type === 'event' && frame.event === Events.RUN_UPDATED)
      updates.push({
        payload: frame.payload as RunUpdatedPayload,
        bytes: Buffer.byteLength(data.toString()),
      });
  });
  const request = <T>(method: string, params: unknown) => {
    const id = `run-${++requests}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
      const receive = (data: WebSocket.RawData) => {
        const frame: ResponseFrame = JSON.parse(data.toString());
        if (frame.type !== 'res' || frame.id !== id) return;
        clearTimeout(timer);
        ws.off('message', receive);
        if (frame.ok) resolve(frame.payload as T);
        else reject(new Error(JSON.stringify(frame.error)));
      };
      ws.on('message', receive);
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  };
  await request('auth.connect', { clientKind: 'ui', token: credential.secret });

  await request(Methods.RUN_TAGS_SET, { runId: run.id, tags: ['notice'] });
  for (let waited = 0; !updates.length && waited < 2000; waited += 10)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const [update] = updates;
  assert.ok(update, 'the tag write is announced to the client');
  assert.deepEqual(Object.keys(update.payload.run).sort(), [
    'id',
    'project',
    'slotId',
    'status',
    'updatedAt',
  ]);
  assert.equal(update.payload.run.id, run.id);
  assert.equal(update.payload.run.status, run.status);
  assert.ok(update.bytes < 1000, `the notice is small (${update.bytes} B)`);

  const read = await request<RunGetResult>(Methods.RUN_GET, { runId: run.id });
  assert.deepEqual(read.run.tags, ['notice']);
  assert.equal(read.run.ticketData?.description?.length, 100_000);
  assert.equal(read.run.updatedAt, update.payload.run.updatedAt);

  await t.test('an event emitted to the caller only is a notice too', async () => {
    updates.length = 0;
    await request(Methods.SLOT_RELEASE, { slotId: 'slot-notice', expectedRunId: run.id });
    for (let waited = 0; !updates.length && waited < 2000; waited += 10)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [callerUpdate] = updates;
    assert.ok(callerUpdate, 'the caller receives the release event');
    assert.deepEqual(Object.keys(callerUpdate.payload.run).sort(), [
      'id',
      'project',
      'slotId',
      'status',
      'updatedAt',
    ]);
    assert.equal(callerUpdate.payload.run.id, run.id);
    assert.ok(callerUpdate.bytes < 1000, `the notice is small (${callerUpdate.bytes} B)`);
  });
});
