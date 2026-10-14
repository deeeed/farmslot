import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import type { SourceLock } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'source-reconnect-'));
await mkdir(path.join(root, 'pool'));
await mkdir(path.join(root, 'home'));
Object.assign(process.env, {
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_SOURCES_CONFIG: path.join(root, 'sources.json'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'fixture-owner',
});
await writeFile(
  path.join(root, 'sources.json'),
  JSON.stringify({ packs: { demo: { sourceId: 'pack', entry: '.' } } }),
);
await import('../runtime/mock-pty.test-support.js');
const { SourceMaterializer } = await import('@farmslot/slot-config/sources');
const { currentProjectSources } = await import('@farmslot/slot-config');
const { SourceAuthority } = await import('./authority.js');
const { initializeSources, stopSourceReconciliation, withRunSources, verifyExecutionSources } =
  await import('./runtime.js');
const { sourceTestLock, sourceTestMaterialization } = await import('./source.test-support.js');
const { createRun, updateRun, getAllRuns, persistRunNow } = await import('../runs/store.js');
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse, withNodeReconnectWait } = await import('../fleet/node-rpc.js');

test('the production source gate and verification wait for reconnect without changing frozen locks', async (t) => {
  t.mock.method(SourceAuthority, 'open', async () => ({
    recoverRunCreations: async () => {},
    startReconciliation: () => () => {},
    activatedAt: () => '2020-01-01T00:00:00Z',
  }));
  t.mock.method(SourceMaterializer.prototype, 'materialize', async (lock: SourceLock) =>
    sourceTestMaterialization(lock, 'gateway'),
  );
  await initializeSources();
  t.after(stopSourceReconciliation);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const machine = 'source-reconnect-node';
  const run = createRun(
    {
      project: 'demo',
      flowType: 'review-pr',
      ticketOrPr: 'https://github.com/example/app/pull/1',
      transport: 'native',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      reviewWorkspaceTarget: { machine },
    },
    { nativeOwnerPrincipalId: 'fixture-owner' },
  );
  const lock = sourceTestLock(machine, run.id);
  updateRun(run.id, {
    sourceProvenance: {
      state: 'locked',
      attemptId: `${run.id}:1`,
      lock,
      workerLock: lock,
      receiptIds: ['gateway-receipt', `${machine}-receipt`],
      bindings: [lock.packBindings.demo],
      attempts: [],
    },
  });
  const original = structuredClone(run.sourceProvenance);
  const methods: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(raw: string, callback?: () => void) {
      const { id, method, params } = JSON.parse(raw);
      methods.push(method);
      callback?.();
      handleNodeResponse(
        id,
        true,
        method === 'sources.materialize' ? sourceTestMaterialization(params.lock, machine) : {},
        undefined,
        undefined,
        ws,
      );
    },
  });
  const ws = socket as WebSocket;
  t.after(() => unregisterByWs(ws));
  let executions = 0;
  const pending = withNodeReconnectWait(
    () =>
      withRunSources(run, async () => {
        executions++;
        assert.equal(currentProjectSources()?.execution?.lock.digest, lock.digest);
      }),
    () => {},
  );
  // Drain the gateway's local materialization before advancing the remote wait.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  assert.equal(executions, 0);
  registerNode(machine, 1, ws);
  t.mock.timers.tick(100);
  await pending;
  assert.equal(executions, 1);
  assert.deepEqual(run.sourceProvenance, original);
  unregisterByWs(ws);
  const verify = withNodeReconnectWait(
    () => verifyExecutionSources(machine, sourceTestMaterialization(lock, machine)),
    () => {},
  );
  t.mock.timers.tick(20_000);
  await Promise.resolve();
  registerNode(machine, 1, ws);
  t.mock.timers.tick(100);
  await verify;
  assert.deepEqual(methods, ['sources.materialize', 'sources.materialize', 'sources.verify']);
});

test.after(async () => {
  stopSourceReconciliation();
  for (const run of getAllRuns()) await persistRunNow(run, 'fixture teardown');
  await rm(root, { recursive: true, force: true });
});
