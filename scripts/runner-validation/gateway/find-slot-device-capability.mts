// Manual public replay proof in disposable pools. No device or worker is started.
import '../lib/no-inherited-git-location.mjs';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import type { Run } from '@farmslot/protocol';
import type { WebSocketServer } from 'ws';

const source = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), 'find-slot-device-proof-'));
const out = path.resolve(
  process.env.FARMSLOT_DEVICE_SELECTION_PROOF_OUT ?? 'temp/find-slot-device-proof',
);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const project = 'device-proof';
const pixel = 'android-slot';
const ios = 'ios-slot';
for (const dir of [
  'scripts',
  'services/gateway',
  `projects/${project}`,
  'pool',
  'runs',
  'home',
  'android-repo',
  'ios-repo',
])
  mkdirSync(path.join(root, dir), { recursive: true });
for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'])
  cpSync(path.join(source, file), path.join(root, file));
mkdirSync(out, { recursive: true });
const resource = (id: string) => ({
  type: id,
  label: id,
  hooks: { boot: 'true', health: 'true', shutdown: 'true' },
});
const provider = (id: string) => ({
  label: id,
  description: id,
  version: '1',
  share_policy: 'exclusive',
  cost: { class: 'low', resources: [{ id, kind: 'device', access: 'exclusive', scope: 'slot' }] },
  actions: {
    acquire: { kind: 'resource', resource_id: id, action: 'boot' },
    health: { kind: 'resource', resource_id: id, action: 'health' },
    release: { kind: 'resource', resource_id: id, action: 'shutdown' },
  },
  affected_resources: [{ resource_id: id, ownership: 'capability', release_effect: 'stop' }],
  release_effects: ['Stop fixture device'],
  keep_warm_ms: 0,
});
json(path.join(root, `projects/${project}/project.json`), {
  name: project,
  repo_url: 'https://example.invalid/device-proof',
  default_branch: 'main',
  runtime_dir: '.',
  defaults: { dev: { runner: 'scripted', model: 'scripted' } },
  resources: { 'android-device': resource('android-device'), 'ios-sim': resource('ios-sim') },
  runtime_capabilities: {
    providers: {
      'android-device': provider('android-device'),
      'ios-simulator': provider('ios-sim'),
    },
  },
});
json(path.join(root, 'pool/local.json'), {
  machine: 'device-proof-local',
  host: 'localhost',
  project,
  platform: 'ios',
  slots: [
    {
      id: ios,
      project,
      repo: path.join(root, 'ios-repo'),
      session: ios,
      resources: { 'ios-sim': { simulator: 'fixture-ios' } },
    },
    {
      id: pixel,
      project,
      repo: path.join(root, 'android-repo'),
      session: pixel,
      platform: 'android',
      resources: { 'android-device': { adb_serial: 'fixture-android' } },
    },
  ],
});
const row = (slot: string, platform: string) => ({
  slot,
  machine: 'device-proof-local',
  project,
  platform,
  lifecycle: 'ready',
  phase: null,
  agent: 'idle',
  enabled: true,
  dispatchable: true,
  branch: 'main',
  health: { ssh: 'LOCAL', device: 'fixture:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
  ...(slot === pixel ? { hostPressure: 'yellow' } : {}),
});
json(path.join(root, '.farm-status.json'), { slots: [row(ios, 'ios'), row(pixel, 'android')] });
for (const dir of ['android-repo', 'ios-repo']) {
  const repo = path.join(root, dir);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--no-gpg-sign',
    '--allow-empty',
    '-qm',
    'Fixture source',
  ]);
}
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, 'capabilities.json'),
  FARMSLOT_BACKLOG_FILE: path.join(root, 'backlog.json'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(root, 'queue.json'),
  FARMSLOT_GATEWAY_TOKEN: 'synthetic-parent-credential-not-for-this-fixture',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  NODE_TEST_CONTEXT: '1',
});
await import('../../../services/gateway/src/runtime/mock-pty.test-support.js');
const store = await import('../../../services/gateway/src/runs/store.js');
await store.loadAllRuns();
await import('../../../services/gateway/src/methods/run.js');
const { executeFindSlotStep } =
  await import('../../../services/gateway/src/run-engine/find-slot-step.js');
const policy = await import('../../../services/gateway/src/run-engine/dispatch-policy.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const server = createServer();
let wss: WebSocketServer | undefined;
try {
  const auth = createGatewayAuthRuntime({
    FARMSLOT_HOME: process.env.FARMSLOT_HOME,
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(auth, { host: '127.0.0.1' });
  wss = createWebSocketServer(server, auth);
  const url = await new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve(`ws://127.0.0.1:${address.port}`);
    }),
  );
  const client = new GatewayClient({ url, credential: null, timeout: 30000 });
  const removed = store.createRun({
    flowType: 'dev',
    project,
    ticketOrPr: 'PROJ-124',
    runner: 'scripted',
  });
  store.updateRun(removed.id, { status: 'failed', slotId: 'removed-source-slot' });
  const removedReplay = await client.call<{ run: Run }>('run.replayStep', {
    runId: removed.id,
    stepName: 'find-slot',
  });
  assert.equal(removedReplay.run.slotId, null);
  assert.equal(removedReplay.run.engineState?.slotCapabilityRequirements, undefined);
  await store.persistRunNow(store.getRun(removed.id)!, 'removed-source replay proof');
  const run = store.createRun({
    flowType: 'dev',
    project,
    ticketOrPr: 'PROJ-123',
    runner: 'scripted',
  });
  store.updateRun(run.id, { status: 'failed', slotId: pixel, engineState: { generation: 3 } });
  const replayed = await client.call<{ run: Run }>('run.replayStep', {
    runId: run.id,
    stepName: 'find-slot',
  });
  assert.equal(replayed.run.slotId, null);
  assert.deepEqual(replayed.run.engineState?.slotCapabilityRequirements, {
    sourceSlotId: pixel,
    capabilityIds: ['android-device'],
  });
  const current = store.getRun(run.id)!;
  const result = await executeFindSlotStep(run.id, current, current.engineState!.generation!, {
    broadcastFn: () => {},
    buildDispatchPreviewParamsForRun: policy.buildDispatchPreviewParamsForRun,
    determineSelectionMethodForRun: policy.determineSelectionMethodForRun,
    resolveRunDispatchRunnerModel: policy.resolveRunDispatchRunnerModel,
    requiresCollisionPrecheck: () => false,
    createEngineDecision: async (_runId, reason, description) => {
      throw new Error(`Unexpected selection gate: ${reason}: ${description}`);
    },
    handleCollisionDecision: async () => {
      throw new Error('Unexpected task collision');
    },
    setRunFlags: () => {
      throw new Error('Unexpected worker reuse');
    },
  });
  assert.equal(result.outputs?.selectedSlot, pixel);
  const selected = await client.call<{ run: Run }>('run.get', { runId: run.id });
  assert.equal(selected.run.slotId, pixel);
  assert.deepEqual(
    selected.run.engineState?.slotCapabilityRequirements,
    replayed.run.engineState?.slotCapabilityRequirements,
  );
  await store.persistRunNow(store.getRun(run.id)!, 'isolated device selection proof');
  // Exercise the real admitted-source planning branch with only materializer
  // IO replaced. The removed execution slot cannot be resolved or contacted.
  const { SourceAuthority } = await import('../../../services/gateway/src/sources/authority.js');
  const { SourceMaterializer, sourceLockDigest } = await import('@farmslot/slot-config/sources');
  const sourceRuntime = await import('../../../services/gateway/src/sources/runtime.js');
  const { sourceTestLock, sourceTestMaterialization } =
    await import('../../../services/gateway/src/sources/source.test-support.js');
  const sourceConfig = path.join(root, 'sources.json');
  json(sourceConfig, { packs: { [project]: { sourceId: 'pack', entry: '.' } } });
  process.env.FARMSLOT_SOURCES_CONFIG = sourceConfig;
  mock.method(SourceAuthority, 'open', async () => ({
    recoverRunCreations: async () => {},
    startReconciliation: () => () => {},
    activatedAt: () => '2020-01-01T00:00:00Z',
  }));
  mock.method(SourceMaterializer.prototype, 'materialize', async (lock) =>
    sourceTestMaterialization(lock, 'gateway'),
  );
  await sourceRuntime.initializeSources();
  const admitted = store.createRun({
    flowType: 'dev',
    project,
    ticketOrPr: 'PROJ-125',
    runner: 'scripted',
  });
  const lock = sourceTestLock(undefined, admitted.id);
  lock.context.project = project;
  lock.packBindings = { [project]: { sourceId: 'pack', entry: '.' } };
  lock.digest = sourceLockDigest(lock);
  const provenance = {
    state: 'locked' as const,
    attemptId: 'original',
    lock,
    workerLock: lock,
    bindings: [lock.packBindings[project]],
    receiptIds: ['original-receipt'],
    attempts: [{ id: 'original', receiptIds: ['original-receipt'] }],
  };
  store.updateRun(admitted.id, {
    status: 'failed',
    slotId: 'removed-admitted-slot',
    sourceProvenance: provenance,
  });
  const admittedReplay = await client.call<{ run: Run }>('run.replayStep', {
    runId: admitted.id,
    stepName: 'find-slot',
  });
  assert.equal(admittedReplay.run.slotId, null);
  assert.deepEqual(admittedReplay.run.sourceProvenance, provenance);
  await store.persistRunNow(store.getRun(admitted.id)!, 'admitted removed-source replay proof');
  sourceRuntime.stopSourceReconciliation();
  json(path.join(out, 'receipt.json'), {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHash: createHash('sha256')
      .update(readFileSync(path.join(source, 'services/gateway/src/run-engine/find-slot-step.ts')))
      .digest('hex'),
    publicMethods: ['run.replayStep', 'run.get'],
    replayIntent: selected.run.engineState?.slotCapabilityRequirements,
    selectedSlot: selected.run.slotId,
    findSlot: result,
    liveWrites: 0,
    workerStarts: 0,
    providerAcquires: 0,
    removedSourceReplay: true,
    admittedRemovedSourceReplay: true,
  });
  console.log(
    'Public replay retains Android intent; production find-slot selects the configured Android slot and public run.get confirms it.',
  );
} finally {
  mock.restoreAll();
  if (wss) {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
  }
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
