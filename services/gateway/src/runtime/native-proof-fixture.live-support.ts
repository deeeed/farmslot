// Shared bootstrap and teardown for opt-in proofs with real native providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { Methods, type NativeSessionTargetParams, type Principal } from '@farmslot/protocol';

import type { GatewayClient } from '../../../../packages/cli/src/gateway-client.js';

export interface NativeProofFixture {
  root: string;
  person: Principal;
  client: GatewayClient;
  trackSession(target: NativeSessionTargetParams): void;
  closeSessions(): Promise<void>;
  url: string;
  browserCredential: string;
}

function cleanupFailure(errors: unknown[], message: string): AggregateError {
  const details = errors.map((error) => (error instanceof Error ? error.message : String(error)));
  return new AggregateError(errors, `${message}: ${details.join('; ')}`);
}

export async function createNativeProofFixture(
  t: TestContext,
  fixtureRoot?: string,
): Promise<NativeProofFixture> {
  const root = fixtureRoot ?? (await mkdtemp(path.join(os.tmpdir(), 'native-visual-result-')));
  if (fixtureRoot) {
    process.env.FARMSLOT_ROOT = root;
    process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
    process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
  }
  const state = path.join(root, 'native');
  process.env.FARMSLOT_NATIVE_STATE_DIR = state;
  process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
  process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
  process.env.NODE_TEST_CONTEXT = '1';
  const server = createServer();
  let wss: import('ws').WebSocketServer | undefined;
  const sessions = new Map<string, NativeSessionTargetParams>();
  const trackSession = (target: NativeSessionTargetParams) =>
    sessions.set(target.sessionId, target);
  const closeSessions = async () => {
    if (!client) return;
    const errors: unknown[] = [];
    for (const [sessionId, target] of sessions) {
      try {
        await client.call(Methods.NATIVE_SESSION_CLOSE, target);
        sessions.delete(sessionId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw cleanupFailure(errors, 'Owned proof sessions did not close');
  };
  let client: import('../../../../packages/cli/src/gateway-client.js').GatewayClient | undefined;
  t.after(async () => {
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(closeSessions);
    if (wss) {
      for (const connection of wss.clients) connection.terminate();
      await attempt(() => new Promise<void>((resolve) => wss!.close(() => resolve())));
    }
    if (server.listening)
      await attempt(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
    let hostStopped = false;
    await attempt(async () => {
      const hostText = await readFile(path.join(state, 'host.json'), 'utf8').catch(
        (error: unknown) => {
          // Failed imports or admission can finish before a proof host is created.
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
          throw error;
        },
      );
      if (!hostText) {
        hostStopped = true;
        return;
      }
      const host = JSON.parse(hostText);
      const command = execFileSync('ps', ['-p', String(host.pid), '-o', 'command='], {
        encoding: 'utf8',
      });
      assert.ok(command.includes(state), 'Only the host launched for this proof may be stopped');
      process.kill(host.pid, 'SIGTERM');
      const deadline = Date.now() + 10_000;
      while (true) {
        let alive = true;
        try {
          process.kill(host.pid, 0);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
          alive = false;
        }
        if (!alive) break;
        assert.ok(Date.now() < deadline, 'The owned proof host did not stop');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      hostStopped = true;
    });
    if (hostStopped)
      await attempt(async () => {
        // Review proofs retain immutable bundles; the isolated fixture owns their teardown.
        const { makeOwnerWritable } = await import('../core/owned-copy.js');
        await makeOwnerWritable(root);
        await rm(root, { force: true, recursive: true });
      });
    if (failures.length) throw cleanupFailure(failures, 'Owned native proof cleanup failed');
  });
  const { createGatewayAuthRuntime } = await import('../security/auth.js');
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'auth') });
  const person = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Isolated native proof' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = person.id;
  const credential = runtime.writer.issueCredential(person.id, 'Disposable proof');
  const grant = runtime.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Loopback native proof',
    deviceKind: 'cli',
  });
  const { createWebSocketServer } = await import('../server.js');
  const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
  wss = createWebSocketServer(server, runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    timeout: 60_000,
    credential: { token: grant.accessToken },
  });
  return {
    root,
    person,
    client,
    trackSession,
    closeSessions,
    url: `ws://127.0.0.1:${address.port}/ws`,
    browserCredential: credential.secret,
  };
}
