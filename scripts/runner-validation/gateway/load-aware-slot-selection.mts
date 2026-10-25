// Private authenticated selection proof. No task, worker or provider is started.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

import type {
  DispatchPreviewResult,
  RunCreateParams,
  RunCreateResult,
  RunGetResult,
} from '@farmslot/protocol';
import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'slot-load-proof-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/slot-load-proof');
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_ROOT: workspace,
  FARMSLOT_WORKSPACE: '',
  FARMSLOT_HOME: home,
  FARMSLOT_POOL_DIR: path.join(workspace, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(workspace, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'scratch.json'), JSON.stringify({ root }) + '\n');
for (const name of ['scripts', 'services/gateway', 'pool', 'projects/proof'])
  await mkdir(path.join(workspace, name), { recursive: true });
await writeFile(path.join(workspace, 'CLAUDE.md'), '# Private proof\n');
await writeFile(path.join(workspace, 'scripts/dev.sh'), '# Private proof\n');
await writeFile(
  path.join(workspace, 'services/gateway/package.json'),
  '{"name":"@farmslot/gateway"}',
);
await writeFile(
  path.join(workspace, 'projects/proof/project.json'),
  JSON.stringify({
    name: 'proof',
    default_branch: 'main',
    hooks: {},
    scripted: { commands: { proof: { command: 'true' } } },
  }),
);
const nodes = [
  { machine: 'load-hot', slot: 'hot-slot', load: 83, cores: 16 },
  { machine: 'load-medium', slot: 'medium-slot', load: 6, cores: 16 },
  { machine: 'load-light', slot: 'light-slot', load: 1.4, cores: 8 },
];
const rows = [];
for (const node of nodes) {
  const repo = path.join(root, node.slot);
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
    'test: fixture source',
  ]);
  await writeFile(
    path.join(workspace, 'pool', `${node.machine}.json`),
    JSON.stringify({
      machine: node.machine,
      host: 'localhost',
      ssh_user: os.userInfo().username,
      project: 'proof',
      platform: 'cli',
      slots: [{ id: node.slot, repo, session: node.slot }],
    }),
  );
  rows.push({
    slot: node.slot,
    machine: node.machine,
    project: 'proof',
    platform: 'cli',
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    branch: 'main',
    health: { ssh: 'LOCAL', device: 'fixture:OK', devserver: 'OK', cdp: 'Wallet', fixtures: 'OK' },
  });
}
await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: rows }));
await import('../../../services/gateway/src/runtime/mock-pty.test-support.js');
// Ticket metadata does not participate in placement; keep the proof offline.
const github = await import('../../../services/gateway/src/external/github.js');
mock.module('../../../services/gateway/src/external/github.js', {
  namedExports: {
    ...github,
    fetchGitHubIssue: async () => ({ source: 'manual', title: 'Load fixture' }),
  },
});
const store = await import('../../../services/gateway/src/runs/store.js');
const { updateMachineMetrics } = await import('../../../services/gateway/src/fleet/node-health.js');
function sample(machine: string, loadAvg1: number, cpuCores: number) {
  updateMachineMetrics(machine, {
    cpuPercent: 20,
    memoryPercent: 40,
    memoryUsedGb: 4,
    memoryTotalGb: 10,
    diskPercent: 40,
    loadAvg1,
    loadAvg5: loadAvg1,
    cpuCores,
    collectedAt: new Date().toISOString(),
  });
}
for (const node of nodes) sample(node.machine, node.load, node.cores);
const { executeFindSlotStep } =
  await import('../../../services/gateway/src/run-engine/find-slot-step.js');
const policy = await import('../../../services/gateway/src/run-engine/dispatch-policy.js');
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Load fixture' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(person.id, 'Disposable fixture');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Fixture',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client: GatewayConnection | undefined;
const params: RunCreateParams = {
  project: 'proof',
  flowType: 'dev',
  mode: 'autonomous',
  lane: 'production',
  runner: 'scripted',
  scripted: { mode: 'command', commandRef: 'proof' },
  transport: 'tmux',
  ticketOrPr: 'example/proof#139',
  ticketData: {
    source: 'manual',
    title: 'Select a lightly loaded node',
    description: 'Private selection fixture',
    affectedArea: '',
    acceptanceCriteria: [],
    stepsToReproduce: [],
    screenshots: [],
    labels: [],
  },
};
const context: Parameters<typeof executeFindSlotStep>[3] = {
  ...policy,
  broadcastFn: () => {},
  requiresCollisionPrecheck: () => false,
  createEngineDecision: async (_id, reason, description) => {
    throw new Error(`Unexpected selection gate ${reason}: ${description}`);
  },
  handleCollisionDecision: async () => {
    throw new Error('Unexpected task collision');
  },
  setRunFlags: () => {
    throw new Error('Unexpected worker reuse');
  },
};
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  const preview = await client.call<DispatchPreviewResult>('dispatch.preview', params);
  assert.equal(preview.preview.slotId, 'light-slot');
  const explicit = await client.call<DispatchPreviewResult>('dispatch.preview', {
    ...params,
    slotId: 'hot-slot',
  });
  assert.equal(explicit.preview.slotId, 'hot-slot');
  const created = await client.call<RunCreateResult>('run.create', {
    ...params,
    allowedSlots: ['hot-slot', 'medium-slot'],
  });
  const current = store.getRun(created.run.id)!;
  const selected = await executeFindSlotStep(
    current.id,
    current,
    current.engineState?.generation ?? 0,
    context,
  );
  assert.equal(selected.outputs?.selectedSlot, 'medium-slot');
  store.updateRunStep(current.id, 'find-slot', { ...selected, status: 'done' });
  await store.persistRunNow(store.getRun(current.id)!, 'load selection proof');
  const readback = await client.call<RunGetResult>('run.get', { runId: current.id });
  const step = readback.run.steps.find((step) => step.name === 'find-slot')!;
  assert.match(JSON.stringify(step.inputs?.hostLoadSelection), /5.19 >= 1.50.*skipped/);
  assert.match(String(step.outputs?.selectionReason), /0.38 < 1.50/);
  assert.equal(readback.run.taskFile, null);
  store.updateRun(current.id, { status: 'done' });
  await store.deleteRun(current.id);
  const blocked = await client.call<RunCreateResult>('run.create', {
    ...params,
    ticketOrPr: 'example/proof#140',
    allowedSlots: ['hot-slot'],
  });
  await assert.rejects(
    executeFindSlotStep(blocked.run.id, store.getRun(blocked.run.id)!, 0, context),
    /No allowed free slot below.*5.19 >= 1.50/,
  );
  const blockedReadback = await client.call<RunGetResult>('run.get', { runId: blocked.run.id });
  assert.match(
    JSON.stringify(blockedReadback.run.steps.find((step) => step.name === 'find-slot')?.inputs),
    /skipped for automatic selection/,
  );
  assert.equal(blockedReadback.run.slotId, null);
  sample('load-hot', 1, 16);
  const recovered = await client.call<DispatchPreviewResult>('dispatch.preview', {
    ...params,
    allowedSlots: ['hot-slot', 'medium-slot'],
  });
  assert.equal(recovered.preview.slotId, 'hot-slot');
  sample('load-hot', 8, 16);
  execFileSync('git', ['-C', path.join(root, 'hot-slot'), 'checkout', '-qb', 'example-proof-139']);
  rows[0]!.lifecycle = 'held';
  rows[0]!.branch = 'example-proof-139';
  await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: rows }));
  const affinity = await client.call<DispatchPreviewResult>('dispatch.preview', {
    ...params,
    flowType: 'pr-complete',
    targetBranch: 'example-proof-139',
    allowedSlots: ['hot-slot', 'medium-slot'],
  });
  assert.equal(
    affinity.preview.slotId,
    'medium-slot',
    'lighter node wins over held branch affinity',
  );
  const result = {
    status: 'PASS',
    lowestLoadPreview: preview.preview.slotId,
    allowlistSelection: readback.run.slotId,
    storedSelection: step,
    lighterThanHeldAffinity: affinity.preview.slotId,
    allOverloadedReasonsPersisted: true,
    explicitPickPreserved: true,
    recoveredSelection: recovered.preview.slotId,
    boundary:
      'Authenticated production preview/create/get and FIND_SLOT over disposable local pools and real private Git checkouts. Existing metrics ingestion seeded with synthetic loads; optional ticket metadata substituted. Scheduler disabled; no task writing, worker/model/provider/app or live slot operation.',
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  await rm(root, { recursive: true, force: true });
  await writeFile(
    path.join(output, 'cleanup.json'),
    JSON.stringify({ root, removed: true }) + '\n',
  );
}
process.exit(0);
