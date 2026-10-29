import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { PoolConfig, TerminalInputParams } from '@farmslot/protocol';

let workspaceBeforeResolve = async (_runId: string) => {};
const sent: string[] = [];
const unexpectedPty = () => {
  throw new Error('Unexpected PTY operation in remote input test');
};
mock.module('../runtime/pty-stream.js', {
  namedExports: {
    onPtyExit: () => {},
    ptyExitHandlerCountForTests: unexpectedPty,
    subscribePty: unexpectedPty,
    unsubscribePty: unexpectedPty,
    unsubscribeAllPty: unexpectedPty,
    writePty: (_key: string, data: string) => {
      sent.push(data);
    },
    resizePty: unexpectedPty,
    reinitTmuxSession: unexpectedPty,
    hasPty: (key: string) => key.startsWith('workspace:'),
  },
});
const contexts = await import('../agents/contexts.js');
let beforeResolve = async (_slotId: string) => {};
mock.module('../agents/contexts.js', {
  namedExports: {
    ...contexts,
    resolveAgentTarget: async (slotId: string) => {
      await beforeResolve(slotId);
      return { target: slotId, session: slotId };
    },
  },
});

const pool: PoolConfig = {
  machine: 'remote-input-fixture',
  host: 'fixture.invalid',
  sshUser: 'fixture',
  project: 'fixture',
  platform: 'cli',
  os: 'linux',
  slots: ['ordered', 'other', 'failure', 'alias', 'routing'].map((id) => ({
    id,
    enabled: true,
    mode: 'dispatch',
    project: 'fixture',
    repo: '/fixture',
    session: id,
  })),
};
const fleet = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: { ...fleet, loadPoolConfigs: async () => [pool] },
});
const registry = await import('../fleet/machine-registry.js');
// Opaque mock identity, never presented as a real ConnectedNode or WebSocket.
const node = Symbol('connected remote input fixture');
mock.module('../fleet/machine-registry.js', { namedExports: { ...registry, getNode: () => node } });
const stream = await import('../runtime/tmux-stream.js');
let beforeSend = async (_text: string) => {};
mock.module('../runtime/tmux-stream.js', {
  namedExports: {
    ...stream,
    sendKeys: async (_slotId: string, _session: string, text: string, enter: boolean) => {
      assert.equal(enter, false, 'Raw input must not append an Enter key');
      await beforeSend(text);
      sent.push(text);
    },
  },
});
const workspace = await import('../runtime/workspace-terminal.js');
mock.module('../runtime/workspace-terminal.js', {
  namedExports: {
    ...workspace,
    resolveWorkspaceTerminal: async (params: TerminalInputParams) => {
      assert(params.runId);
      await workspaceBeforeResolve(params.runId);
      return { key: workspace.workspaceTerminalKey(params.runId) };
    },
  },
});
const { terminalInput } = await import('./terminal.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('slow target resolution cannot let a later key or Enter overtake the first request', async () => {
  sent.length = 0;
  const first = deferred();
  const entered = deferred();
  let calls = 0;
  beforeResolve = async () => {
    if (++calls === 1) {
      entered.resolve();
      await first.promise;
    }
  };
  const a = terminalInput({ slotId: 'ordered', data: 'a' });
  await entered.promise;
  const b = terminalInput({ slotId: 'ordered', data: 'b' });
  const enter = terminalInput({ slotId: 'ordered', data: '\r' });
  // A different terminal remains usable while this terminal is resolving.
  await terminalInput({ slotId: 'other', data: 'unrelated' });
  assert.deepEqual(sent, ['unrelated']);
  first.resolve();
  await Promise.all([a, b, enter]);
  assert.deepEqual(sent, ['unrelated', 'a', 'b', '\r']);
});

test('slow remote acknowledgement keeps all clients and selector aliases in arrival order', async () => {
  sent.length = 0;
  beforeResolve = async () => {};
  const first = deferred();
  const entered = deferred();
  beforeSend = async (text) => {
    if (text === 'a') {
      entered.resolve();
      await first.promise;
    }
  };
  const a = terminalInput({ slotId: 'alias', data: 'a' });
  await entered.promise;
  const b = terminalInput({ slotId: 'alias', role: 'dev', contextId: 'dev', data: 'b' });
  const c = terminalInput({ slotId: 'alias', target: 'alias', data: 'c' });
  await terminalInput({ slotId: 'other', data: 'unrelated' });
  assert.deepEqual(sent, ['unrelated']);
  first.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(sent, ['unrelated', 'a', 'b', 'c']);
  beforeSend = async () => {};
});

test('a refused input rejects its caller without poisoning the next input', async () => {
  sent.length = 0;
  let calls = 0;
  beforeResolve = async () => {
    if (++calls === 1) throw new Error('target unavailable');
  };
  const bad = terminalInput({ slotId: 'failure', data: 'bad' });
  const good = terminalInput({ slotId: 'failure', data: 'good' });
  await assert.rejects(bad, /target unavailable/);
  await good;
  await terminalInput({ slotId: 'failure', data: 'later' });
  assert.deepEqual(sent, ['good', 'later']);
});

test('workspace input reserves each run before delayed resolution and leaves other runs independent', async () => {
  sent.length = 0;
  const first = deferred();
  const entered = deferred();
  let calls = 0;
  workspaceBeforeResolve = async (runId) => {
    if (runId === 'ordered-workspace' && ++calls === 1) {
      entered.resolve();
      await first.promise;
    }
  };
  const a = terminalInput({ slotId: '', runId: 'ordered-workspace', data: 'a' });
  await entered.promise;
  const b = terminalInput({ slotId: '', runId: 'ordered-workspace', data: 'b' });
  try {
    await terminalInput({ slotId: '', runId: 'other-workspace', data: 'unrelated' });
    assert.deepEqual(sent, ['unrelated']);
  } finally {
    first.resolve();
  }
  await Promise.all([a, b]);
  assert.deepEqual(sent, ['unrelated', 'a', 'b']);
});

test('authenticated RPC arrival order is reserved before a delayed native access check', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const access = await import('../security/native-worker-access.js');
  const first = deferred();
  const entered = deferred();
  let calls = 0;
  mock.module('../security/native-worker-access.js', {
    namedExports: {
      ...access,
      assertNativeWorkerRpcAccess: async (method: string) => {
        if (method === 'terminal.input' && ++calls === 1) {
          entered.resolve();
          await first.promise;
        }
      },
    },
  });
  beforeResolve = async () => {};
  beforeSend = async () => {};
  sent.length = 0;
  const { createGatewayAuthRuntime } = await import('../security/auth.js');
  const { createWebSocketServer } = await import('../server.js');
  const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
  const home = await mkdtemp(path.join(tmpdir(), 'terminal-route-auth-'));
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const owner = auth.writer.createPrincipal(
    { type: 'service', displayName: 'Input routing test' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const credential = auth.writer.issueCredential(owner.id, 'Input routing test');
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const connection = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    timeout: 5000,
    credential: { token: credential.secret },
  }).connect();
  try {
    const a = connection.call('terminal.input', { slotId: 'routing', data: 'a' });
    await entered.promise;
    const b = connection.call('terminal.input', { slotId: 'routing', data: 'b' });
    try {
      await connection.call('terminal.input', { slotId: 'other', data: 'unrelated' });
      assert.deepEqual(sent, ['unrelated']);
    } finally {
      first.resolve();
      await Promise.all([a, b]);
    }
    assert.deepEqual(sent, ['unrelated', 'a', 'b']);
  } finally {
    first.resolve();
    connection.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(home, { recursive: true, force: true });
  }
});
