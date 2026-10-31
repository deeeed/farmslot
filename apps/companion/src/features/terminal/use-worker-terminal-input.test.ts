import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type TmuxWorkerRef } from '@farmslot/protocol';

import { mountHook } from '../../hooks/hook-harness.fixtures';
import {
  assertResendable,
  createTerminalInputQueue,
  resendScope,
  TerminalInputCancelledError,
} from '../../lib/terminal-input-queue';

interface FakeClient {
  connectionGeneration: number;
  terminalInputSequence?: { instance: string; durable: boolean } | null;
  connectionState?: string;
  request(
    method: string,
    params: { worker: TmuxWorkerRef; data: string; seq?: { stream: string; n: number } },
    timeout?: number,
    options?: { assertCurrent?: () => void; onSent?: () => void },
  ): Promise<unknown>;
}

// The signed-in profile and principal the queue is keyed on.
const connection = { activeProfileId: 'arthur-lan', principalId: 'arthur' };
const connectionStore = Object.assign(
  (select: (state: typeof connection) => unknown) => select(connection),
  { getState: () => connection },
);
const dependencies = {
  '@farmslot/protocol': { Methods },
  '../../lib/terminal-input-queue': {
    assertResendable,
    createTerminalInputQueue,
    resendScope,
    TerminalInputCancelledError,
  },
  '../../store/connection': { useConnectionStore: connectionStore },
};

type Input = { write: (data: string) => Promise<void> };

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
    dependencies,
  );
  try {
    const { write } = hook.render(client, worker) as Input;
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

    // A short reconnect keeps the queue: keys typed behind a delivered batch follow it in
    // order on the new connection instead of being lost.
    const held = write('x');
    await flush();
    const late = write('y');
    client.connectionGeneration++;
    replies.shift()!();
    await held;
    await flush();
    assert.deepEqual(sent.at(-1), {
      method: Methods.TERMINAL_WORKER_INPUT,
      data: 'y',
      generation: 2,
    });
    replies.shift()!();
    await late;
    assert.equal(maxActive, 1);
  } finally {
    hook.cleanup();
  }
});

test('worker keys held behind a token refresh reach the same pane on the new connection, never a pane left', async () => {
  const sent: Array<{ data: string; generation: number }> = [];
  let waiting: Array<() => void> = [];
  const refresh = () => {
    const done = waiting;
    waiting = [];
    done.forEach((resolve) => resolve());
  };
  const client: FakeClient = {
    connectionGeneration: 1,
    async request(_method, params, _timeout, options) {
      // GatewayClient rechecks the caller once the refresh finishes, then sends.
      await new Promise<void>((resolve) => waiting.push(resolve));
      options?.assertCurrent?.();
      sent.push({ data: params.data, generation: client.connectionGeneration });
      return { sent: true };
    },
  };
  const worker: TmuxWorkerRef = { nodeId: 'mini', session: 'mmt-3', target: 'mmt-3:1.1' };
  const mount = () =>
    mountHook<[FakeClient, TmuxWorkerRef]>(
      new URL('./use-worker-terminal-input.ts', import.meta.url),
      'useWorkerTerminalInput',
      dependencies,
    );
  const reconnected = mount();
  try {
    const beforeReconnect = (reconnected.render(client, worker) as Input).write('brown66');
    await flush();
    client.connectionGeneration++;
    refresh();
    // The batch was not written on the old connection; it is retried, not dropped.
    const deadline = Date.now() + 5_000;
    while (waiting.length === 0) {
      assert.ok(Date.now() < deadline, 'the cancelled batch is retried within 5 s');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    refresh();
    await beforeReconnect;
    assert.deepEqual(sent, [{ data: 'brown66', generation: 2 }]);
  } finally {
    reconnected.cleanup();
  }

  const left = mount();
  const beforeLeaving = (left.render(client, worker) as Input).write('x');
  await flush();
  left.cleanup();
  refresh();
  await assert.rejects(beforeLeaving, TerminalInputCancelledError);
  assert.deepEqual(sent, [{ data: 'brown66', generation: 2 }]);
});

// store/connection reuses one GatewayClient across profile switches.
test('worker keys held across a profile switch never go out under the new sign-in', async () => {
  const sent: string[] = [];
  let waiting: Array<() => void> = [];
  const client: FakeClient = {
    connectionGeneration: 1,
    async request(_method, params, _timeout, options) {
      await new Promise<void>((resolve) => waiting.push(resolve));
      options?.assertCurrent?.();
      options?.onSent?.();
      sent.push(params.data);
      return { sent: true };
    },
  };
  const worker: TmuxWorkerRef = { nodeId: 'mini', session: 'mmt-3', target: 'mmt-3:1.1' };
  const hook = mountHook<[FakeClient, TmuxWorkerRef]>(
    new URL('./use-worker-terminal-input.ts', import.meta.url),
    'useWorkerTerminalInput',
    dependencies,
  );
  try {
    const typed = (hook.render(client, worker) as Input).write('secret');
    await flush();
    connection.activeProfileId = 'work-profile';
    waiting.forEach((resolve) => resolve());
    waiting = [];
    hook.render(client, worker);
    await assert.rejects(typed, TerminalInputCancelledError);
    waiting.forEach((resolve) => resolve());
    await flush();
    assert.deepEqual(sent, []);
  } finally {
    connection.activeProfileId = 'arthur-lan';
    hook.cleanup();
  }
});

// A gateway that numbers input drops a repeat: a lost reply is resent on its own.
test(
  'worker keys whose reply was lost are resent with the same number, with nothing to resolve by hand',
  { timeout: 5_000 },
  async () => {
    const pane: Array<{ data: string; n?: number }> = [];
    let loseReply = true;
    const client: FakeClient = {
      connectionGeneration: 1,
      terminalInputSequence: { instance: 'gw1', durable: true },
      async request(_method, params, _timeout, options) {
        options?.onSent?.();
        pane.push({ data: params.data, n: params.seq?.n });
        if (loseReply) {
          loseReply = false;
          throw new Error('Request terminal.worker.input timed out after 10000ms');
        }
        return { sent: true };
      },
    };
    const worker: TmuxWorkerRef = { nodeId: 'mini', session: 'mmt-3', target: '%19' };
    const hook = mountHook<[FakeClient, TmuxWorkerRef]>(
      new URL('./use-worker-terminal-input.ts', import.meta.url),
      'useWorkerTerminalInput',
      dependencies,
    );
    try {
      const { write } = hook.render(client, worker) as Input;
      await write('echo ONCE\r');
      await write('pwd\r');
      // The gateway drops the repeated number 1, so the pane runs each command once.
      assert.deepEqual(pane, [
        { data: 'echo ONCE\r', n: 1 },
        { data: 'echo ONCE\r', n: 1 },
        { data: 'pwd\r', n: 2 },
      ]);
    } finally {
      hook.cleanup();
    }
  },
);
