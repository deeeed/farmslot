import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import { type EventFrame, Events, isRecord } from '@farmslot/protocol';

import type { GatewayConnection } from '../gateway-client.js';

import { watchRunLifecycle } from './run-watch.js';

function fixture(delayed = false) {
  let event = (_event: EventFrame): void => {};
  let close = (): void => {};
  let closed = false;
  let calls = 0;
  const initial = { id: 'run', project: 'example', slotId: 'slot', status: 'reviewing' };
  let resolveInitial: (value: { run: typeof initial }) => void = () => {};
  const pending = new Promise<{ run: typeof initial }>((resolve) => {
    resolveInitial = resolve;
  });
  const connection: GatewayConnection = {
    async call<T>() {
      calls++;
      return (await (delayed ? pending : Promise.resolve({ run: initial }))) as T;
    },
    onEvent(handler) {
      event = handler;
      return () => {
        event = () => {};
      };
    },
    onClose(handler) {
      close = handler;
      return () => {
        close = () => {};
      };
    },
    close() {
      closed = true;
    },
  };
  return {
    connection,
    calls: () => calls,
    closed: () => closed,
    update(status: string, id = 'run') {
      event({
        type: 'event',
        event: Events.RUN_UPDATED,
        payload: { run: { ...initial, id, status } },
      });
    },
    disconnect() {
      close();
    },
    initial(status: string) {
      resolveInitial({ run: { ...initial, status } });
    },
  };
}

test('run lifecycle watch reads once and processes only changed owning-run lifecycle events', async () => {
  const f = fixture();
  const statuses: string[] = [];
  const watch = watchRunLifecycle(f.connection, 'run', (run) => statuses.push(run.status));
  await setImmediate();
  assert.deepEqual(statuses, ['reviewing']);
  f.update('fixing', 'other');
  f.update('reviewing');
  f.update('fixing');
  f.update('done');
  await watch;
  assert.deepEqual(statuses, ['reviewing', 'fixing', 'done']);
  assert.equal(f.calls(), 1);
  assert.equal(f.closed(), true);
});

test('a lifecycle event received during the initial read is never replaced by an older snapshot', async () => {
  const f = fixture(true);
  const statuses: string[] = [];
  const watch = watchRunLifecycle(f.connection, 'run', (run) => statuses.push(run.status));
  f.update('reviewing');
  f.initial('monitoring');
  await setImmediate();
  assert.deepEqual(statuses, ['reviewing']);
  f.update('done');
  await watch;
});

test('connection loss rejects the watch and cleans its subscription', async () => {
  const f = fixture();
  const watch = watchRunLifecycle(f.connection, 'run', () => {});
  const failure = assert.rejects(watch, /connection closed/);
  await setImmediate();
  f.disconnect();
  await failure;
  assert.equal(f.closed(), true);
});

test(
  'the public run watch closes its socket when the owning task-view pipe ends',
  { timeout: 4900 },
  async (t) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    let calls = 0;
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const request: unknown = JSON.parse(String(data));
        assert.ok(isRecord(request) && typeof request.id === 'string');
        if (request.method !== 'auth.connect') calls++;
        socket.send(
          JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload:
              request.method === 'auth.connect'
                ? {}
                : { run: { id: 'run', project: 'example', status: 'reviewing' } },
          }),
        );
      }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-watch-pipe-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const bin = fileURLToPath(new URL('../../bin/farmslot.mjs', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        bin,
        '--url',
        `ws://127.0.0.1:${address.port}`,
        '--json',
        'run',
        'get',
        '--watch',
        '--',
        'run',
      ],
      {
        env: { ...process.env, FARMSLOT_HOME: home, FARMSLOT_TASK_WATCH_PIPE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    });
    const [first] = await once(child.stdout, 'data');
    assert.equal(String(first).trimEnd().includes('\n'), false, 'one compact envelope per line');
    const frame = JSON.parse(String(first));
    assert.equal(frame.data.run.status, 'reviewing');
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(calls, 1);
  },
);
