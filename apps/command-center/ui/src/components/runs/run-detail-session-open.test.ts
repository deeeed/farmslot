import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunSessionCommandResult } from '@farmslot/protocol';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('a delayed session lookup cannot restore a host after its view changes', async (t) => {
  // Lit's server entry initializes before the gateway fixture supplies its minimal document.
  await import('lit');
  const fake = installFakeGateway(t);
  const { gateway } = await import('../../gateway-client.js');
  const { openRunnerSessionOnHost } = await import('./run-detail-session-open.js');
  t.after(() => gateway.disconnect());
  await gateway.setAuthCredentials({ token: 'proof' });
  gateway.connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const socket = fake.sockets.at(-1)!;
  let current = true;
  const input = {
    runId: 'run',
    runStatus: 'monitoring' as const,
    row: { contextId: 'worker', role: 'fix-bug' as const, slotId: 'private-slot' },
    isCurrent: () => current,
  };
  const pending = openRunnerSessionOnHost(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = socket.sent.find(({ method }) => method === 'run.sessionCommand');
  assert(request);
  current = false;
  const result: RunSessionCommandResult = {
    supported: true,
    runId: 'run',
    role: 'fix-bug',
    contextId: 'worker',
    runner: 'scripted',
    model: null,
    sessionId: 'retained-session',
    sessionPath: '/private/session',
    capturedAt: null,
    slotId: 'private-slot',
    machine: 'private-node',
    tmuxTarget: null,
    ownership: 'owned',
    interrupt: null,
    reopenCommand: 'retained-command',
    attachCommand: null,
    liveness: 'dead',
  };
  socket.response(request.id, result);
  assert.match((await pending).message, /view changed/);
  assert.equal(socket.sent.filter(({ method }) => method === 'tmux.worker.restore').length, 0);
  const reads = socket.sent.length;
  assert.equal((await openRunnerSessionOnHost(input)).ok, false);
  assert.equal(socket.sent.length, reads, 'A retired view cannot start another lookup');
});
