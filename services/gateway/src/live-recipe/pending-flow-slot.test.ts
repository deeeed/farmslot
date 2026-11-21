import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { WebSocket } from 'ws';

import {
  DEFAULT_TASK_DIR,
  type LiveRecipeContext,
  Methods,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { createRecipeRunner, RECIPE_PENDING_FLOW_FILE } from '@farmslot/recipe-runner';

const root = await mkdtemp(path.join(tmpdir(), 'item7-slot-red-'));
const poolDir = path.join(root, 'pool');
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: poolDir,
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status-fixture.json'),
});
for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  const file = path.join(root, marker);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, marker.endsWith('.json') ? '{}' : '');
}
const originalStat = fs.statSync;
let poolReads = 0;
test.mock.method(fs, 'statSync', function counted(filename: fs.PathLike, options?: fs.StatOptions) {
  if (String(filename) === poolDir || String(filename).startsWith(poolDir + path.sep)) poolReads++;
  return originalStat(filename, options);
});
syncBuiltinESMExports();
await import('../runtime/mock-pty.test-support.js');
const state = await import('../core/state.js');
const cfg = await import('../core/config.js');
const { execOnSlot } = await import('../core/exec.js');
const store = await import('../runs/store.js');
const nodes = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { acceptNodeFileObservation } = await import('../resources/node-file-observations.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { workspaceObservations } = await import('../resources/workspace-observations.js');
const { routeRunMethod } = await import('../server/run-route.js');
const { bindPendingRecipeAttempt } = await import('./pending-flow.js');
test.after(async () => {
  workspaceObservations.dispose();
  test.mock.restoreAll();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function held(
  t: TestContext,
  suffix: string,
  { firstWatchTimeout = false, bindOnDispatch = false } = {},
) {
  const project = 'item7-fixture';
  const machine = 'item7-fixture-' + suffix;
  const slotId = 'item7-slot-' + suffix;
  const attempt = 'recipe-bound-' + suffix;
  const remoteRepo = path.join(root, machine);
  const projectDir = path.join(root, 'projects', project);
  const taskDir = path.join(remoteRepo, DEFAULT_TASK_DIR, suffix);
  const artifactRoot = path.join(taskDir, 'artifacts', 'recipe-runs', attempt);
  const taskFile = path.join(cfg.getOrchestratorTaskRoot(project), suffix, 'TASK.md');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'project.json'), '{"hooks":{}}');
  await mkdir(poolDir, { recursive: true });
  await writeFile(
    path.join(poolDir, machine + '.json'),
    JSON.stringify({
      machine,
      project,
      platform: 'ios',
      os: 'linux',
      host: '203.0.113.20',
      ssh_user: 'tester',
      slots: [{ id: slotId, repo: remoteRepo, session: 'item7-slot' }],
    }),
  );
  await mkdir(path.dirname(taskFile), { recursive: true });
  await writeFile(taskFile, '# Fixture\n');
  const id = store.createRun(
    {
      project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'ITEM7-' + suffix,
    },
    { deferBackgroundPersist: true },
  ).id;
  await state.claimSlotStatusIf(slotId, () => true, { current_run_id: id, phase: 'working' });
  const context: LiveRecipeContext = {
    source: 'recipe-run-live',
    recipeRunId: attempt,
    artifactRoot,
    artifactManifest: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    selectionReason: 'latest-run',
  };
  store.updateRun(id, { status: 'monitoring', slotId, taskFile, liveRecipeContext: context });
  const watches = new Map<string, string>();
  let retired: { requestId: string; path: string } | undefined;
  let watchCalls = 0;
  const register = (pid: number) => {
    const socket = {
      readyState: 1,
      send(raw: string) {
        const {
          id: requestId,
          method,
          params,
        } = JSON.parse(raw) as {
          id: string;
          method: string;
          params: { requestId: string; root: string; relPath: string; path: string };
        };
        const respond = (value: unknown) =>
          handleNodeResponse(requestId, true, value, undefined, undefined, socket);
        if (method === 'fs.watch') {
          watchCalls++;
          assert.equal(path.basename(params.path), RECIPE_PENDING_FLOW_FILE);
          watches.set(requestId, params.path);
          if (watchCalls === 1 && firstWatchTimeout) {
            retired = { requestId, path: params.path };
            queueMicrotask(() => t.mock.timers.tick(30_001));
          } else queueMicrotask(() => respond({ watching: true, notificationsOnly: 1 }));
        } else if (method === 'fs.watch.stop') {
          watches.delete(params.requestId);
          queueMicrotask(() => respond({ ok: true }));
        } else if (method === 'fs.realpath') {
          void realpath(path.join(params.root, params.relPath)).then((resolved) =>
            respond({ path: resolved }),
          );
        } else if (method === 'fs.readText') {
          void readFile(path.join(params.root, params.relPath), 'utf8').then((content) =>
            respond({ content }),
          );
        } else if (method === 'exec') {
          queueMicrotask(() => respond({ exitCode: 0, stdout: String(pid), stderr: '' }));
        } else assert.fail('Unexpected node method: ' + method);
      },
    } as WebSocket;
    nodes.registerNode(
      machine,
      pid,
      socket,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { fileAppends: 1 },
    );
    t.after(() => nodes.unregisterByWs(socket));
    return socket;
  };
  const firstNode = register(100);
  const epoch = (await state.readSlotRow(slotId))?.slot_epoch;
  assert(typeof epoch === 'number');
  const bind = (node: ReturnType<typeof nodes.getNode>) =>
    t.after(
      bindPendingRecipeAttempt({ id, taskFile, slotId }, context, {
        taskDir,
        slot: { id: slotId, epoch },
        node,
      }),
    );
  if (!bindOnDispatch) bind(nodes.getNode(machine));
  const active = { action: 'app.status', intent: 'Read current status.', next: 'next' };
  const next = { action: 'app.status', intent: 'Check again.', next: 'done' };
  const end = { action: 'end', status: 'pass' };
  const entered = [deferred(), deferred()] as const;
  const release = [deferred(), deferred()] as const;
  let started = 0;
  await mkdir(artifactRoot, { recursive: true });
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        'app.status': {
          description: 'Hold the task.',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          examples: [active],
        },
        end: { description: 'Finish.', examples: [end] },
      },
    },
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
    adapters: [
      {
        action: 'app.status',
        source: { kind: 'bundled', trust: 'trusted' },
        async execute() {
          const index = started++;
          assert(index === 0 || index === 1);
          entered[index].resolve();
          await release[index].promise;
          return { output: { ready: true } };
        },
      },
    ],
  });
  const run = runner.run({
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Hold slot-bound attempt',
      workflow: { entry: 'hold', nodes: { hold: active, next, done: end } },
    },
    projectRoot: remoteRepo,
    artifactsDir: artifactRoot,
    recordVideo: false,
    recordingReason: 'Headless fixture',
  });
  t.after(async () => {
    for (const gate of release) gate.resolve();
    await run;
  });
  await Promise.race([
    entered[0].promise,
    run.then(() => assert.fail('Fixture finished before hold')),
  ]);
  const read = async () => {
    const noMutation = () => assert.fail('Pending read emitted a mutation');
    const result = await routeRunMethod(
      Methods.RUN_RECIPE_RUNS_FOR_RUN,
      { runId: id, includeRecordedEvidence: true },
      { emit: noMutation, broadcast: noMutation },
    );
    assert.ok(result.handled);
    return (result.value as RunRecipeRunsForRunResult).pendingFlow;
  };
  const advance = async () => {
    release[0].resolve();
    await entered[1].promise;
    for (const [requestId, filename] of watches)
      assert.ok(
        acceptNodeFileObservation(firstNode, {
          machine,
          requestId,
          path: filename,
          content: '',
        }),
      );
  };
  const dispatch = async () =>
    execOnSlot(await cfg.loadSlotVars(slotId), 'opaque fixture command', { onDispatch: bind });
  const lateRetiredNotification = () => {
    assert.ok(retired);
    return acceptNodeFileObservation(firstNode, { ...retired, machine, content: '' });
  };
  return {
    id,
    slotId,
    read,
    register,
    advance,
    dispatch,
    lateRetiredNotification,
    watchCalls: () => watchCalls,
  };
}

test('a pre-dispatch reconnect binds pending flow to the socket that receives exec', async (t) => {
  const f = await held(t, 'dispatch', { bindOnDispatch: true });
  f.register(101);
  assert.equal((await f.dispatch()).stdout, '101');
  assert.equal((await f.read())?.update.activeId, 'hold');
});

test('a same-run claim increment revokes the former attempt', async (t) => {
  const f = await held(t, 'epoch');
  assert.equal((await f.read())?.update.activeId, 'hold');
  const before = await state.readSlotRow(f.slotId);
  const { epoch } = await state.claimSlotStatusIf(f.slotId, () => true, { current_run_id: f.id });
  assert.equal(epoch, Number(before?.slot_epoch) + 1);
  const stale = await f.read();
  assert.equal(stale?.update.activeId, undefined);
  assert.equal(f.watchCalls(), 1);
});

test('the old attempt cannot adopt the replacement socket', async (t) => {
  const f = await held(t, 'socket');
  assert.equal((await f.read())?.update.activeId, 'hold');
  f.register(101);
  const stale = await f.read();
  assert.equal(stale?.update.activeId, undefined);
});

test('first-arm timeout does not strand artifact invalidation', async (t) => {
  const f = await held(t, 'watch', { firstWatchTimeout: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = await f.read();
  assert.equal(first?.update.activeId, 'hold');
  assert.equal(f.watchCalls(), 2);
  const key = { family: 'artifacts', runId: f.id } as const;
  const before = resourceRevisions.revision(key);
  assert.equal(f.lateRetiredNotification(), undefined);
  assert.equal(resourceRevisions.revision(key), before);
  const runBefore = resourceRevisions.revision({ family: 'run', runId: f.id });
  await f.advance();
  const after = resourceRevisions.revision(key);
  assert.ok(after > before);
  assert.equal(resourceRevisions.revision({ family: 'run', runId: f.id }), runBefore);
  const second = await f.read();
  assert.equal(second?.update.activeId, 'next');
  assert.equal(second?.update.recipeRunId, first.update.recipeRunId);
});

test('settled reads do not repeatedly enumerate the pool', async (t) => {
  const f = await held(t, 'metadata');
  assert.equal((await f.read())?.update.activeId, 'hold');
  poolReads = 0;
  for (let i = 0; i < 3; i++) assert.equal((await f.read())?.update.activeId, 'hold');
  assert.equal(poolReads, 0);
});
