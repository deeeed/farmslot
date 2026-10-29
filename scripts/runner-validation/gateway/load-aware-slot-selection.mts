// Private authenticated selection proof. No task, worker or provider is started.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';

import type {
  DispatchPreviewResult,
  RunCreateParams,
  RunCreateResult,
  RunGetResult,
  QueueItem,
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
  { machine: 'load-hot', slot: 'hot-slot', load: 83, cores: 16, cpu: 95 },
  { machine: 'load-medium', slot: 'medium-slot', load: 6, cores: 16, cpu: 60 },
  { machine: 'load-light', slot: 'light-slot', load: 1.4, cores: 8, cpu: 20 },
  { machine: 'load-manual', slot: 'manual-slot', load: 6, cores: 16, cpu: 60 },
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
  const remote = path.join(root, `${node.slot}-remote.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'main']);
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
    lifecycle: node.slot === 'manual-slot' ? 'manual' : 'ready',
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
const { updateSlotStatus } = await import('../../../services/gateway/src/core/state.js');
async function resetFixtureSlots() {
  for (const row of rows)
    await updateSlotStatus(row.slot, {
      ...row,
      current_run_id: null,
      cleanup_run_id: null,
      handoff_run_id: null,
      task_id: null,
      task_file: null,
    });
}

const { updateMachineMetrics } = await import('../../../services/gateway/src/fleet/node-health.js');
function sample(
  machine: string,
  loadAvg1: number,
  cpuCores: number,
  diskPercent = 40,
  cpuPercent = 20,
) {
  updateMachineMetrics(machine, {
    cpuPercent,
    memoryPercent: 40,
    memoryUsedGb: 4,
    memoryTotalGb: 10,
    diskPercent,
    loadAvg1,
    loadAvg5: loadAvg1,
    cpuCores,
    collectedAt: new Date().toISOString(),
  });
}
for (const node of nodes) sample(node.machine, node.load, node.cores, 40, node.cpu);
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
  assert.match(
    JSON.stringify(step.inputs?.hostLoadSelection),
    /CPU idle 5\.00% < 15\.00%.*skipped/,
  );
  assert.match(String(step.outputs?.selectionReason), /CPU idle 40\.00% >= 15\.00%/);
  assert.equal(readback.run.taskFile, null);
  store.updateRun(current.id, { status: 'done' });
  await store.deleteRun(current.id);
  // Each selection case starts with fresh owned fixture leases.
  await resetFixtureSlots();
  const pinned = await client.call<RunCreateResult>('run.create', {
    ...params,
    ticketOrPr: 'example/proof#140',
    allowedSlots: ['hot-slot'],
  });
  const pinSelection = await executeFindSlotStep(
    pinned.run.id,
    store.getRun(pinned.run.id)!,
    0,
    context,
  );
  assert.equal(pinSelection.outputs?.selectedSlot, 'hot-slot');
  assert.match(
    String(pinSelection.outputs?.selectionReason),
    /Warning:.*CPU idle 5\.00%.*explicitly pinned slot, dispatch continues/,
  );
  assert.match(JSON.stringify(pinSelection.inputs?.hostLoadSelection), /"skipped":false/);
  store.updateRun(pinned.run.id, { status: 'done' });
  await store.deleteRun(pinned.run.id);
  await resetFixtureSlots();
  sample('load-hot', 83, 16, 40, 95);
  sample('load-medium', 6, 16, 40, 95);
  let overloadRefusal: string | null = null;
  await assert.rejects(
    client.call('dispatch.preview', { ...params, allowedSlots: ['hot-slot', 'medium-slot'] }),
    (error: unknown) => {
      assert(error instanceof Error);
      overloadRefusal = error.message;
      assert.match(error.message, /CPU idle 5\.00% < 15\.00%.*skipped/);
      return true;
    },
  );
  sample('load-hot', 1, 16, 40, 10);
  sample('load-medium', 6, 16, 40, 60);
  const recovered = await client.call<DispatchPreviewResult>('dispatch.preview', {
    ...params,
    allowedSlots: ['hot-slot', 'medium-slot'],
  });
  assert.equal(recovered.preview.slotId, 'hot-slot');
  sample('load-hot', 8, 16, 40, 70);
  execFileSync('git', ['-C', path.join(root, 'hot-slot'), 'checkout', '-qb', 'example-proof-139']);
  rows[0]!.lifecycle = 'held';
  rows[0]!.branch = 'example-proof-139';
  await resetFixtureSlots();
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
  // A quiet red-disk host must still lose to a healthy allowed host.
  sample('load-light', 0.8, 8, 97, 10);
  const red = await client.call<DispatchPreviewResult>('dispatch.preview', params);
  assert.equal(red.preview.slotId, 'medium-slot');
  const { selectQueueDispatchSlot } =
    await import('../../../services/gateway/src/backlog/dispatch-queue.js');
  const { capturePressureAdmissionDecisionsLightweight } =
    await import('../../../services/gateway/src/methods/dispatch/pressure-admission.js');
  sample('load-hot', 4, 16, 40, 40);
  sample('load-medium', 83, 16, 40, 95);
  const item: QueueItem = {
    id: 'held-queue-proof',
    flowType: 'pr-complete',
    project: 'proof',
    ticketOrPr: 'example/proof#139',
    allowedSlots: ['hot-slot', 'medium-slot'],
    branch: 'example-proof-139',
    priority: 1,
    status: 'queued',
    createdAt: new Date().toISOString(),
  };
  const fleet = await import('../../../services/gateway/src/fleet/state.js');
  const queueSelection = await selectQueueDispatchSlot(
    (await fleet.loadFleetStatus(true)).slots,
    item,
    { capturePressure: async (machines) => capturePressureAdmissionDecisionsLightweight(machines) },
  );
  assert.equal(
    queueSelection,
    'hot-slot',
    'eligible held affinity prevents an overload-only queue hold',
  );
  // Exercise the real operator slot-picker route on stale free checkouts.
  for (const row of rows) row.lifecycle = row.slot === 'manual-slot' ? 'manual' : 'ready';
  execFileSync('git', ['-C', path.join(root, 'medium-slot'), 'checkout', '-qb', 'previous-task']);
  rows[1]!.branch = 'previous-task';
  rows[1]!.lifecycle = 'released';
  await resetFixtureSlots();
  const legacyStatus = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
  for (const row of legacyStatus.slots) if (row.slot === 'medium-slot') delete row.phase;
  await writeFile(path.join(root, 'status.json'), JSON.stringify(legacyStatus));
  sample('load-hot', 83, 16, 40, 95);
  sample('load-medium', 6, 16, 40, 60);
  const legacyPreview = await client.call<DispatchPreviewResult>('dispatch.preview', {
    ...params,
    allowedSlots: ['medium-slot'],
  });
  assert.equal(legacyPreview.preview.slotId, 'medium-slot');
  await updateSlotStatus('medium-slot', { lifecycle: 'ready', phase: null });
  // Current safe reuse handles published stale branches automatically. The
  // operator picker is for retained local work, which both fixture repos own.
  for (const id of ['hot-slot', 'medium-slot'])
    execFileSync('git', [
      '-C',
      path.join(root, id),
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '-qm',
      'test: retain owned unpublished work',
    ]);
  const picker = await client.call<RunCreateResult>('run.create', {
    ...params,
    ticketOrPr: 'example/proof#141',
    allowedSlots: ['hot-slot', 'medium-slot', 'manual-slot'],
  });
  const { createEngineDecision } =
    await import('../../../services/gateway/src/run-engine/engine-decisions.js');
  const picked = await executeFindSlotStep(picker.run.id, store.getRun(picker.run.id)!, 0, {
    ...context,
    createEngineDecision: async (runId, reason, description, actions, payload, options) => {
      const waiting = createEngineDecision(runId, reason, description, actions, payload, {
        ...options,
        readProgress: async () => ({ kind: 'idle' }),
      });
      const until = Date.now() + 3000;
      while (!store.getRun(runId)!.decisions.some((d) => !d.resolvedAt)) {
        assert.ok(Date.now() < until, 'operator decision did not open');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const decision = store.getRun(runId)!.decisions.find((d) => !d.resolvedAt)!;
      const pending = await client!.call<RunGetResult>('run.get', { runId });
      const card = pending.run.decisions.find((d) => d.id === decision.id);
      assert.equal(card?.payload?.kind, 'slot_picker');
      if (card?.payload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
      assert.equal(
        card.payload.reason,
        'all_stale',
        'Stale branch selection remains a human decision',
      );
      assert.deepEqual(card.payload.candidates.map((s) => s.slotId).sort(), [
        'hot-slot',
        'medium-slot',
      ]);

      await client!.call('run.resolveDecision', {
        runId,
        decisionId: decision.id,
        actionId: 'pick',
        selectionData: { slotId: 'hot-slot' },
      });
      return waiting;
    },
  });
  assert.equal(picked.outputs?.selectedSlot, 'hot-slot');
  assert.equal(picked.outputs?.selectionMethod, 'human-override');
  const pickedReadback = await client.call<RunGetResult>('run.get', { runId: picker.run.id });
  assert.equal(pickedReadback.run.slotId, 'hot-slot');
  assert.ok(
    pickedReadback.run.decisions.some(
      (d) => d.resolvedAction === 'pick' && d.selectionData?.slotId === 'hot-slot',
    ),
  );
  for (const reason of ['no_free_slots', 'missing_required_resources'] as const) {
    const empty = await client.call<RunCreateResult>('run.create', {
      ...params,
      ticketOrPr: reason === 'no_free_slots' ? 'example/proof#142' : 'example/proof#143',
      allowedSlots: [reason === 'no_free_slots' ? 'manual-slot' : 'medium-slot'],
    });
    // Fixture admission only: no prepare or device operation is started.
    if (reason === 'missing_required_resources')
      store.updateRun(empty.run.id, { prepareProfile: 'companion-full' });
    await assert.rejects(
      executeFindSlotStep(empty.run.id, store.getRun(empty.run.id)!, 0, {
        ...context,
        createEngineDecision: async (runId, why, description, actions, payload, options) => {
          const waiting = createEngineDecision(runId, why, description, actions, payload, {
            ...options,
            readProgress: async () => ({ kind: 'idle' }),
          });
          const until = Date.now() + 3000;
          while (!store.getRun(runId)!.decisions.some((d) => !d.resolvedAt)) {
            assert(Date.now() < until, 'empty picker did not open');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          const current = await client!.call<RunGetResult>('run.get', { runId });
          const decision = current.run.decisions.find((d) => !d.resolvedAt)!;
          if (decision.payload?.kind !== 'slot_picker') throw new Error('Missing slot picker');
          assert.equal(decision.payload.reason, reason);
          assert.deepEqual(decision.payload.candidates, []);
          assert.match(decision.description, /Abort and dispatch again/);
          assert.doesNotMatch(decision.description, /listed/);
          await client!.call('run.resolveDecision', {
            runId,
            decisionId: decision.id,
            actionId: 'abort',
          });
          return waiting;
        },
      }),
      /Aborted|cancelled/i,
    );
  }
  const result = {
    status: 'PASS',
    redHeadroomPreserved: red.preview.slotId,
    heldQueueSelection: queueSelection,
    operatorPickerSelection: pickedReadback.run.slotId,
    manualSlotExcludedFromPicker: true,
    legacyReleasedPreviewEligible: legacyPreview.preview.slotId,
    emptyNoFreeAndMissingResourceMessagesVerified: true,
    staleBranchHumanDecisionPreserved: true,
    lowestLoadPreview: preview.preview.slotId,
    allowlistSelection: readback.run.slotId,
    storedSelection: step,
    lighterThanHeldAffinity: affinity.preview.slotId,
    overloadRefusal,
    automaticExclusionPersisted: true,
    explicitPickPreserved: true,
    singleSlotPinWarning: pinSelection.outputs?.selectionReason,
    recoveredSelection: recovered.preview.slotId,
    boundary:
      'Authenticated production preview/create/get and FIND_SLOT over disposable local pools and real private Git checkouts. Existing metrics ingestion seeded with synthetic CPU and diagnostic loads; optional ticket metadata substituted, with companion-full admission seeded only for the missing-resource fixture. Scheduler disabled; no task writing, worker/model/provider/app or live slot operation.',
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
