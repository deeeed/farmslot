import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type TmuxWorkerRef } from '@farmslot/protocol';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import {
  createTerminalInputQueue,
  TerminalInputCancelledError,
} from '../../lib/terminal-input-queue';

interface FakeClient {
  connectionGeneration: number;
  request(
    method: string,
    params: { worker: TmuxWorkerRef; data: string },
    timeout?: number,
    options?: { assertCurrent?: () => void },
  ): Promise<unknown>;
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// Pixel 6 Terminals tab: each key was its own concurrent request, so slow replies reordered them.
test('worker pane keys go one request at a time in the order typed', async () => {
  const sent: Array<{ method: string; data: string; generation: number }> = [];
  const replies: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const client: FakeClient = {
    connectionGeneration: 1,
    request(method, params) {
      active++;
      maxActive = Math.max(maxActive, active);
      sent.push({ method, data: params.data, generation: client.connectionGeneration });
      return new Promise((resolve) =>
        replies.push(() => {
          active--;
          resolve({ sent: true });
        }),
      );
    },
  };
  const worker: TmuxWorkerRef = { nodeId: 'mini', session: 'mmt-3', target: 'mmt-3:1.1' };
  const hook = mountHook<[FakeClient, TmuxWorkerRef]>(
    new URL('./use-worker-terminal-input.ts', import.meta.url),
    'useWorkerTerminalInput',
    {
      '@farmslot/protocol': { Methods },
      '../../lib/terminal-input-queue': { createTerminalInputQueue, TerminalInputCancelledError },
    },
  );
  try {
    const write = hook.render(client, worker) as (data: string) => Promise<void>;
    const typed = [...'brown66'].map((key) => write(key));
    await flush();
    assert.deepEqual(
      sent.map(({ data }) => data),
      ['b'],
    );
    replies.shift()!();
    await flush();
    assert.deepEqual(
      sent.map(({ data }) => data),
      ['b', 'rown66'],
      'Keys typed during a slow reply follow it in one batch',
    );
    replies.shift()!();
    await Promise.all(typed);
    assert.equal(maxActive, 1);
    assert.ok(sent.every(({ method }) => method === Methods.TERMINAL_WORKER_INPUT));

    // A new connection never receives keys typed for the old one.
    const held = write('x');
    await flush();
    const late = write('y');
    client.connectionGeneration++;
    replies.shift()!();
    await held;
    await assert.rejects(late, TerminalInputCancelledError);
    const next = write('z');
    await flush();
    assert.deepEqual(sent.at(-1), {
      method: Methods.TERMINAL_WORKER_INPUT,
      data: 'z',
      generation: 2,
    });
    replies.shift()!();
    await next;
  } finally {
    hook.cleanup();
  }
});

test('worker keys held behind a token refresh are never sent to a pane left or a new connection', async () => {
  const sent: string[] = [];
  let refreshed: () => void = () => undefined;
  const client: FakeClient = {
    connectionGeneration: 1,
    async request(_method, params, _timeout, options) {
      // GatewayClient rechecks the caller once the refresh finishes, then sends.
      await new Promise<void>((resolve) => (refreshed = resolve));
      options?.assertCurrent?.();
      sent.push(params.data);
      return { sent: true };
    },
  };
  const worker: TmuxWorkerRef = { nodeId: 'mini', session: 'mmt-3', target: 'mmt-3:1.1' };
  const mount = () =>
    mountHook<[FakeClient, TmuxWorkerRef]>(
      new URL('./use-worker-terminal-input.ts', import.meta.url),
      'useWorkerTerminalInput',
      {
        '@farmslot/protocol': { Methods },
        '../../lib/terminal-input-queue': { createTerminalInputQueue, TerminalInputCancelledError },
      },
    );
  const reconnected = mount();
  const beforeReconnect = (reconnected.render(client, worker) as (data: string) => Promise<void>)(
    'brown66',
  );
  await flush();
  client.connectionGeneration++;
  refreshed();
  await assert.rejects(beforeReconnect, TerminalInputCancelledError);
  reconnected.cleanup();

  const left = mount();
  const beforeLeaving = (left.render(client, worker) as (data: string) => Promise<void>)('x');
  await flush();
  left.cleanup();
  refreshed();
  await assert.rejects(beforeLeaving, TerminalInputCancelledError);
  assert.deepEqual(sent, []);
});
