import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { PoolConfig } from '@farmslot/protocol';

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
    writePty: unexpectedPty,
    resizePty: unexpectedPty,
    reinitTmuxSession: unexpectedPty,
    hasPty: () => false,
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
  slots: ['ordered', 'other', 'failure', 'alias'].map((id) => ({
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
const rpc = await import('../fleet/node-rpc.js');
const sent: string[] = [];
let beforeSend = async (_text: string) => {};
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    ...rpc,
    sendNodeRequest: async (selectedNode: unknown, method: string, params: { text: string }) => {
      assert.equal(selectedNode, node);
      assert.equal(method, 'tmux.send');
      await beforeSend(params.text);
      sent.push(params.text);
      return { sent: true };
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
