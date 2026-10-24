// Manual authenticated RPC proof of terminal eviction's owned-release wiring.
// The existing release transport is replaced by a private IPC worker teardown.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
const code = fileURLToPath(new URL('../../../', import.meta.url));
const home = await mkdtemp(path.join(os.tmpdir(), 'terminal-archive-proof-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/terminal-archive-proof');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(home, 'status.json'),
});
const load = (file: string) => import(pathToFileURL(path.join(code, file)).href);
await mkdir(path.join(home, 'pool'));
await mkdir(path.join(home, 'projects', 'archive-proof'), { recursive: true });
await mkdir(path.join(home, 'checkout'));
await mkdir(output, { recursive: true });
await writeFile(
  path.join(home, 'projects', 'archive-proof', 'project.json'),
  JSON.stringify({ name: 'archive-proof', default_branch: 'main', hooks: {} }),
);
await writeFile(
  path.join(home, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'archive-proof',
    platform: 'cli',
    slots: [{ id: 'fixture-slot', repo: path.join(home, 'checkout'), session: 'fixture-slot' }],
  }),
);
const workerFile = path.join(home, 'worker.cjs');
await writeFile(
  workerFile,
  "process.on('message', m => { if (m.kind === 'stop') process.exit(0); }); process.send({kind:'ready'});\n",
);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Archive proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const secret = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(secret.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const store = await load('services/gateway/src/runs/store.ts');
const core = await load('services/gateway/src/core/index.ts');
const children = new Map<string, ChildProcess>();
const runs: string[] = [];
const archiveQueued = new Map<string, () => void>();
const { withRunTransition } = await load(
  'services/gateway/src/run-lifecycle/transition-coordinator.ts',
);
function fixture(status: 'done' | 'failed' | 'monitoring') {
  const run = store.createRun(
    {
      project: 'archive-proof',
      flowType: 'dev',
      mode: 'autonomous',
      transport: 'tmux',
      runner: 'scripted',
      ticketOrPr: 'PROOF-ARCHIVE',
      slotId: 'fixture-slot',
    },
    { createdByPrincipalId: person.id, nativeOwnerPrincipalId: person.id },
  );
  runs.push(run.id);
  store.updateRun(run.id, {
    status,
    steps: [{ name: 'monitor', status: status === 'monitoring' ? 'running' : 'done' }],
  });
  return run;
}
async function worker(runId: string) {
  const child = fork(workerFile, [], { silent: true });
  children.set(runId, child);
  assert.deepEqual((await once(child, 'message'))[0], { kind: 'ready' });
  return child;
}
const methods = await load('services/gateway/src/methods/run/admin.ts');
mock.module(pathToFileURL(path.join(code, 'services/gateway/src/methods/run/admin.ts')).href, {
  namedExports: {
    ...methods,
    runArchive: (params: { runId: string }, emit: unknown) => {
      const pending = methods.runArchive(params, emit, {
        preflight: async () =>
          assert.fail('terminal keep-work eviction delegates directly to the guarded release'),
        release: async (params: {
          slotId: string;
          expectedRunId: string;
          keepWork?: boolean;
          forceReset?: boolean;
        }) => {
          assert.equal(params.keepWork, true);
          assert.equal(params.forceReset, undefined);
          assert.equal(
            core.ownsRunSlotCleanup(await core.readSlotRow(params.slotId), params.expectedRunId),
            true,
          );
          assert.ok(
            store.getRun(params.expectedRunId),
            'run ownership survives until worker stop confirms',
          );
          const child = children.get(params.expectedRunId);
          assert.ok(child);
          const exit = once(child, 'exit');
          child.send({ kind: 'stop' });
          await exit;
          assert.equal(child.exitCode, 0);
          const transition = await core.updateSlotStatusIf(
            params.slotId,
            (row: Readonly<Record<string, unknown>>) =>
              core.ownsRunSlotCleanup(row, params.expectedRunId),
            { current_run_id: null, cleanup_run_id: null, lifecycle: 'ready' },
          );
          assert.equal(transition, true);
          return { released: true };
        },
      });
      archiveQueued.get(params.runId)?.();
      return pending;
    },
  },
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client;
let releaseTransition: (() => void) | undefined;
let pendingTransition: Promise<void> | undefined;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  for (const status of ['done', 'failed'] as const) {
    const run = fixture(status);
    await writeFile(
      path.join(home, 'status.json'),
      JSON.stringify({
        slots: [{ slot: 'fixture-slot', current_run_id: run.id, lifecycle: 'held', slot_epoch: 1 }],
      }),
    );
    const child = await worker(run.id);
    assert.equal(child.exitCode, null);
    assert.deepEqual(await client.call('run.archive', { runId: run.id }), { ok: true });
    assert.equal(child.exitCode, 0, 'archive must confirm worker stopped before returning');
    await assert.rejects(client.call('run.get', { runId: run.id }), /Run not found/);
    const archived = JSON.parse(
      await readFile(path.join(home, 'runs', 'archive', `${run.id}.json`), 'utf8'),
    );
    assert.equal(archived.status, status);
    assert.deepEqual(archived.steps, [{ name: 'monitor', status: 'done' }]);
    assert.ok(archived.archivedAt);
    assert.equal(await core.readSlotField('fixture-slot', 'current_run_id'), null);
  }
  const parent = fixture('done');
  const childRun = fixture('monitoring');
  store.updateRun(childRun.id, { familyId: parent.familyId });
  const sharedWorker = await worker(parent.id);
  await writeFile(
    path.join(home, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: 'fixture-slot',
          current_run_id: null,
          cleanup_run_id: parent.id,
          lifecycle: 'held',
          phase: 'occupied',
          slot_epoch: 2,
        },
      ],
    }),
  );
  await assert.rejects(
    client.call('run.archive', { runId: parent.id }),
    /Another active run .* uses this slot/,
  );
  assert.equal(sharedWorker.exitCode, null, 'archive must leave the shared child worker alive');
  assert.ok(store.getRun(parent.id));
  store.updateRun(childRun.id, { status: 'done' });

  const drift = fixture('failed');
  const driftingWorker = await worker(drift.id);
  await writeFile(
    path.join(home, 'status.json'),
    JSON.stringify({
      slots: [{ slot: 'fixture-slot', current_run_id: drift.id, lifecycle: 'held', slot_epoch: 3 }],
    }),
  );
  let entered!: () => void;
  const transitionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const mayFinish = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  pendingTransition = withRunTransition(drift.id, async () => {
    entered();
    await mayFinish;
    store.updateRun(drift.id, { status: 'done' });
  });
  await transitionEntered;
  let queued!: () => void;
  const queuedRequest = new Promise<void>((resolve) => {
    queued = resolve;
  });
  archiveQueued.set(drift.id, queued);
  const request = client.call('run.archive', { runId: drift.id });
  await Promise.race([
    queuedRequest,
    request.then(() => assert.fail('archive settled before admission')),
  ]);
  releaseTransition!();
  await assert.rejects(request, /status changed from failed to done/);
  await pendingTransition;
  assert.equal(
    driftingWorker.exitCode,
    null,
    'terminal drift must retain worker and run ownership',
  );
  assert.ok(store.getRun(drift.id));
  const result = {
    pass: true,
    methods: ['run.archive', 'run.get'],
    statuses: ['done', 'failed'],
    confirmedWorkerExitBeforeEviction: true,
    sharedChildProtected: true,
    terminalStatusDriftRefused: true,
    archivedStatusAndStepHistoryPreserved: true,
    checkoutPolicy: 'keepWork:true, forceReset absent',
    scope:
      'Authenticated production archive RPC, store, fence and slot ownership. Unchanged release transport substituted with owner-checked private IPC child teardown; no tmux/native transport claim.',
    productOperations: 0,
    modelTurns: 0,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  releaseTransition?.();
  if (pendingTransition) await pendingTransition;
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const child of children.values())
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
  for (const id of runs)
    if (store.getRun(id)) {
      store.updateRun(id, { status: 'done' });
      await store.deleteRun(id);
    }
  await rm(home, { recursive: true, force: true });
}
process.exit(0);
