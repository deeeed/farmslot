// Guards the TLS-listener blocker: createWebSocketServer runs once per listening
// server (plaintext ws + TLS wss), so it must NOT register process-global side
// effects — those live in initServerGlobals(), called once from main(). Duplicate
// registration would double every TERMINAL_EXITED / FLEET_UPDATED broadcast and
// the backlog auto-dispatch tick.
process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { stateChangeHandlerCountForTests } from './fleet/state.js';
import { ptyExitHandlerCountForTests } from './runtime/pty-stream.js';
import { createGatewayAuthRuntime } from './security/auth.js';
import { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } from './server.js';

test('createWebSocketServer registers no process-global handlers; initServerGlobals registers exactly one, once', () => {
  resetServerGlobalsForTests();
  const authRuntime = createGatewayAuthRuntime();

  const ptyBefore = ptyExitHandlerCountForTests();
  const stateBefore = stateChangeHandlerCountForTests();

  // Two servers, mirroring the http + https (wss) listeners the gateway attaches.
  const httpServer = createServer();
  const httpsServer = createServer();
  const wss1 = createWebSocketServer(httpServer, authRuntime);
  const wss2 = createWebSocketServer(httpsServer, authRuntime);

  // Per-server attachment must not touch the process-global registries.
  assert.equal(
    ptyExitHandlerCountForTests(),
    ptyBefore,
    'no PTY-exit handler from createWebSocketServer',
  );
  assert.equal(
    stateChangeHandlerCountForTests(),
    stateBefore,
    'no state-change handler from createWebSocketServer',
  );

  // Globals register exactly one of each, and only once even if called again.
  initServerGlobals();
  initServerGlobals();
  assert.equal(ptyExitHandlerCountForTests(), ptyBefore + 1, 'exactly one PTY-exit handler');
  assert.equal(
    stateChangeHandlerCountForTests(),
    stateBefore + 1,
    'exactly one state-change handler',
  );

  wss1.close();
  wss2.close();
  resetServerGlobalsForTests();
});
