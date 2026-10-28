import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import type { Run } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'acceptance-registration-flow-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
await mkdir(path.join(root, 'pool'));
await mkdir(path.join(root, 'projects/proof'), { recursive: true });
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [
      {
        id: 'acceptance-proof-slot',
        repo: path.join(root, 'projects/proof'),
        session: 'acceptance-proof-slot',
      },
    ],
  }),
);
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', task_dir: 'tasks', hooks: {} }),
);
after(() => rm(root, { recursive: true, force: true }));

class OperatorInstructionNotAttemptedError extends Error {}
let delivery: 'confirmed' | 'queued' | 'unconfirmed' | 'not-attempted' = 'confirmed';
let duringDelivery: (() => Promise<void>) | undefined;
const deliveries: Array<{ key: string; observeSince?: number }> = [];
mock.module('../runners/operator-instruction.js', {
  namedExports: {
    OperatorInstructionNotAttemptedError,
    deliverOperatorInstruction: async (
      _run: Run,
      key: string,
      _text: string,
      observeSince?: number,
    ) => {
      deliveries.push({ key, observeSince });
      await duringDelivery?.();
      return delivery;
    },
  },
});
await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const { ORCHESTRATOR_LOCALITY } = await import('../core/slot-io.js');
const { initializeAcceptanceRegistration } = await import('./acceptance-registration.js');
const { syncAcceptanceRegistration } = await import('./acceptance-registration-sync.js');
const { operatorMessage } = await import('../methods/run/operator-message.js');
const { withRunTransition } = await import('../run-lifecycle/transition-coordinator.js');
const { executeTool } = await import('../chat/chat-tools.js');
const completionModule = await import('../run-completion/orchestrator.js');
const maintenanceModule = await import('../run-engine/branch-maintenance.js');
const diffModule = await import('../run-engine/diff-artifacts.js');
let completionCalls = 0;
mock.module('../run-completion/orchestrator.js', {
  namedExports: {
    ...completionModule,
    runCompletionPipeline: async () => {
      completionCalls++;
      return {
        prNumber: 1,
        ciRepo: 'example/repo',
        artifactsCopied: true,
        prCommentPosted: false,
        prTitleUpdated: false,
        prMarkedReady: false,
        retrospectiveCreated: false,
        artifacts: [],
      };
    },
  },
});
mock.module('../run-engine/branch-maintenance.js', {
  namedExports: {
    ...maintenanceModule,
    completeBranchMaintenance: async () => {},
    abandonBranchMaintenance: async () => {},
  },
});
mock.module('../run-engine/diff-artifacts.js', {
  namedExports: { ...diffModule, captureReviewInputArtifactsForRun: async () => {} },
});
const stepModule: string = '../run-engine/post-dispatch-steps.js?acceptance-lifecycle-flow';
const {
  executeCompleteStep,
  executeReviewStep,
}: typeof import('../run-engine/post-dispatch-steps.js') = await import(stepModule);
const lifecycleContext: import('../run-engine/post-dispatch-steps.js').PostDispatchStepContext = {
  activeMonitors: new Map(),
  broadcastFn: () => {},
  stepPartialIO: new Map(),
  blockedRunError: (message) => new Error(message),
  createEngineDecision: async () => 'unused',
  executeNoChangeGate: async () => {},
  executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
  executeReadyGate: async () => 'ready',
  executeReviewGate: async () => {},
  getDiffStat: async () => ({ files: 0, additions: 0, deletions: 0 }),
  interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
  isHumanGateEnabled: async () => false,
  monitorTerminalError: ({ reason }) => new Error(reason),
  refreshRunLinks: async () => {},
  deferTerminalSlotRelease: () => {},
  assertGatePrerequisites: async (run) => ({
    state: 'ready',
    reasons: [],
    identity: {
      runId: run.id,
      generation: run.engineState?.generation ?? 0,
      acceptanceRevision: run.acceptanceRegistration?.revision,
      acceptanceContractRevision: run.acceptanceExecutionContract?.revision,
      headSha: 'a'.repeat(40),
    },
  }),
};

const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Acceptance test operator' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const require = createRequire(import.meta.url);
const { runSubtaskCommand } =
  require('../../../../packages/agent-runtime/scripts/subtask-unit.cjs') as {
    runSubtaskCommand(taskDir: string, args: string[]): number;
  };

async function fixture(t: TestContext) {
  deliveries.length = 0;
  delivery = 'confirmed';
  duringDelivery = undefined;
  const run = store.createRun({
    flowType: 'pr-complete',
    project: 'proof',
    ticketOrPr: 'example/repo#1',
    transport: 'tmux',
    mode: 'autonomous',
    slotId: 'acceptance-proof-slot',
    runner: 'claude',
  });
  const taskDir = path.join(root, 'projects/proof/tasks/pr-complete', run.id);
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'));
  const registration = initializeAcceptanceRegistration(
    run.id,
    [{ id: 'AC-1', text: 'Original' }],
    [
      {
        id: 'comment:1',
        kind: 'review-comment',
        version: 'v1',
        body: 'Fix stale data',
        url: 'https://example.test/comment/1',
      },
    ],
    {
      provider: 'github',
      repository: 'example/repo',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      capturedAt: '2026-10-25T00:00:00Z',
    },
  );
  store.updateRun(run.id, {
    status: 'monitoring',
    taskFile: path.join(taskDir, 'TASK.md'),
    ticketData: {
      source: 'manual',
      title: 'Proof',
      description: 'Proof',
      acceptanceCriteria: ['Original'],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    acceptanceRegistration: registration,
    agentContexts: [
      {
        id: 'primary',
        role: 'primary',
        label: 'Worker',
        status: 'working',
        runId: run.id,
        slotId: run.slotId,
        runner: 'claude',
        model: 'haiku',
        taskFile: path.join(taskDir, 'TASK.md'),
        target: {
          session: 'proof',
          window: 'worker',
          pane: null,
          paneId: '%999999',
          target: '%999999',
        },
      },
    ],
  });
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({ slots: [{ slot: run.slotId, current_run_id: run.id }] }),
  );
  await writeFile(path.join(taskDir, 'TASK.md'), '# Task\n');
  await writeFile(
    path.join(taskDir, 'CHECKLIST.md'),
    '# Work\n\n- [ ] **1. Derive acceptance**\n- [ ] **2. Fix**\n',
  );
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: run.id,
      project: 'proof',
      flow: 'pr-complete',
      executionTemplate: { firstSubtask: 'derive-acceptance' },
      task: { acceptanceCriteria: ['Original'] },
    }),
  );
  const base = JSON.stringify({
    schemaVersion: 1,
    flowType: 'pr-complete',
    mode: run.mode,
    recordedEvidenceContractVersion: run.recordedEvidenceContractVersion,
    acceptanceContractVersion: 1,
    commands: {
      complete: { artifacts: [] },
      'no-change': { artifacts: [] },
      blocked: { artifacts: [] },
    },
  });
  await writeFile(path.join(taskDir, 'inputs/worker-terminal-contract.json'), base);
  await writeFile(
    path.join(taskDir, 'inputs/acceptance-registration.json'),
    JSON.stringify({ schemaVersion: 1, generation: 0, registration }),
  );
  t.after(async () => {
    store.updateRun(run.id, { status: 'failed', slotId: null, agentContexts: [] });
    await store.deleteRun(run.id);
  });
  const sync = () =>
    syncAcceptanceRegistration(run.id, run.slotId!, ORCHESTRATOR_LOCALITY, taskDir);
  return { run, taskDir, registration, base, sync };
}

test('the actual child-result handshake persists source-linked ACs before acknowledgement', async (t) => {
  const { run, taskDir, base, sync } = await fixture(t);
  assert.equal(
    runSubtaskCommand(taskDir, [
      'start',
      'derive-acceptance',
      '--step',
      '1',
      '--from',
      'inline:- [ ] Classify',
    ]),
    0,
  );
  const proposal = {
    schemaVersion: 1,
    runId: run.id,
    generation: 0,
    registrationRevision: 1,
    unitId: 'derive-acceptance',
    classifications: [
      {
        sourceId: 'comment:1',
        sourceVersion: 'v1',
        obligations: [{ text: 'Refresh stale data', proofMode: 'state' }],
      },
    ],
  };
  await writeFile(path.join(taskDir, 'proposal.json'), JSON.stringify(proposal));
  const complete = [
    'derive-acceptance',
    'complete',
    '--mark-last',
    '--acceptance-result',
    'proposal.json',
  ];
  assert.equal(runSubtaskCommand(taskDir, complete), 1);
  await sync();
  assert.equal(runSubtaskCommand(taskDir, complete), 0);
  const accepted = store.getRun(run.id)!.acceptanceRegistration!;
  assert.equal(accepted.revision, 2);
  assert.deepEqual(accepted.original, [{ id: 'AC-1', text: 'Original' }]);
  assert.equal(accepted.derived[0].id, 'AC-2');
  const persisted: unknown = JSON.parse(
    await readFile(path.join(root, 'runs', `${run.id}.json`), 'utf8'),
  );
  assert.ok(persisted && typeof persisted === 'object' && 'acceptanceRegistration' in persisted);
  const projection = JSON.parse(
    await readFile(path.join(taskDir, 'inputs/acceptance-registration.json'), 'utf8'),
  );
  assert.deepEqual(projection.registration, accepted);
  assert.equal(
    await readFile(path.join(taskDir, 'inputs/worker-terminal-contract.json'), 'utf8'),
    base,
  );
  await sync();
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.revision, 2);
});

test('incomplete coverage refuses with its issue while foreign and cancelled holders cannot append', async (t) => {
  const { run, taskDir, sync } = await fixture(t);
  runSubtaskCommand(taskDir, [
    'start',
    'derive-acceptance',
    '--step',
    '1',
    '--from',
    'inline:- [ ] Classify',
  ]);
  await writeFile(
    path.join(taskDir, 'proposal.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      generation: 0,
      registrationRevision: 1,
      unitId: 'derive-acceptance',
      classifications: [],
    }),
  );
  runSubtaskCommand(taskDir, [
    'derive-acceptance',
    'complete',
    '--mark-last',
    '--acceptance-result',
    'proposal.json',
  ]);
  await sync();
  assert.match(store.getRun(run.id)!.acceptanceRegistration!.units[0].error!, /source coverage/);
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.derived.length, 0);
  const before = JSON.stringify(store.getRun(run.id)!.acceptanceRegistration);
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({ slots: [{ slot: run.slotId, current_run_id: 'successor' }] }),
  );
  await sync();
  assert.equal(JSON.stringify(store.getRun(run.id)!.acceptanceRegistration), before);
  store.updateRun(run.id, { status: 'cancelled' });
  await sync();
  assert.equal(JSON.stringify(store.getRun(run.id)!.acceptanceRegistration), before);
});

test('authenticated steering is retry-stable and an unconfirmed receipt stays pending', async (t) => {
  const { run } = await fixture(t);
  const request = {
    runId: run.id,
    slotId: run.slotId!,
    operatorMessageId: 'opaque:message/1',
    text: 'Preserve the balance',
    enter: true,
  };
  await assert.rejects(
    operatorMessage(request, () => {}),
    /authenticated/,
  );
  const first = await runWithSessionOriginator(person, () => operatorMessage(request, () => {}));
  assert.equal(first?.delivery, 'confirmed');
  assert.equal(deliveries.filter(({ observeSince }) => observeSince === undefined).length, 1);
  const count = store.getRun(run.id)!.acceptanceRegistration!.units.length;
  await runWithSessionOriginator(person, () => operatorMessage(request, () => {}));
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.units.length, count);
  assert.equal(deliveries.filter(({ observeSince }) => observeSince === undefined).length, 1);
  await assert.rejects(
    runWithSessionOriginator(person, () =>
      operatorMessage({ ...request, text: 'Changed instruction' }, () => {}),
    ),
    /changed contents/,
  );
  delivery = 'unconfirmed';
  await assert.rejects(
    runWithSessionOriginator(person, () =>
      operatorMessage({ ...request, operatorMessageId: 'second' }, () => {}),
    ),
    /unconfirmed/,
  );
  const unit = store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)!;
  assert.equal(unit.delivery?.status, 'pending');
  assert.equal(unit.result, undefined);
});

test('queued delivery is confirmed by a later watch without creating another instruction', async (t) => {
  const { run, sync } = await fixture(t);
  const request = {
    runId: run.id,
    slotId: run.slotId!,
    operatorMessageId: 'queued',
    text: 'Keep the original semantics',
  };
  delivery = 'queued';
  const sent = await runWithSessionOriginator(person, () => operatorMessage(request, () => {}));
  assert.equal(sent?.delivery, 'queued');
  const pending = store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)!;
  assert.equal(pending.delivery?.status, 'pending');
  assert.ok(pending.delivery?.startedAt);
  delivery = 'confirmed';
  await sync();
  const confirmed = store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)!;
  assert.equal(confirmed.id, pending.id);
  assert.equal(confirmed.delivery?.status, 'confirmed');
  assert.equal(deliveries.filter(({ observeSince }) => observeSince === undefined).length, 1);
});

test('parallel operator messages preserve both durable pending derivations', async (t) => {
  const { run } = await fixture(t);
  await Promise.all(
    ['first', 'second'].map((id) =>
      runWithSessionOriginator(person, () =>
        operatorMessage(
          {
            runId: run.id,
            slotId: run.slotId!,
            operatorMessageId: id,
            text: `Instruction ${id}`,
          },
          () => {},
        ),
      ),
    ),
  );
  const registration = store.getRun(run.id)!.acceptanceRegistration!;
  assert.deepEqual(
    registration.units
      .flatMap(({ sources }) =>
        sources.filter(({ kind }) => kind === 'instruction').map(({ body }) => body),
      )
      .sort(),
    ['Instruction first', 'Instruction second'],
  );
  assert.equal(
    registration.units.filter(({ delivery }) => delivery?.status === 'confirmed').length,
    2,
  );
  const persisted = JSON.parse(await readFile(path.join(root, 'runs', `${run.id}.json`), 'utf8'));
  assert.equal(persisted.acceptanceRegistration.units.length, 3);
});

test('a generation change during delivery refuses acknowledgement and preserves pending work', async (t) => {
  const { run } = await fixture(t);
  duringDelivery = async () => {
    store.updateRun(run.id, { engineState: { generation: 1 } });
  };
  await assert.rejects(
    runWithSessionOriginator(person, () =>
      operatorMessage(
        {
          runId: run.id,
          slotId: run.slotId!,
          operatorMessageId: 'stale',
          text: 'Keep this obligation',
        },
        () => {},
      ),
    ),
    /lost its run or slot owner/,
  );
  const unit = store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)!;
  assert.equal(unit.delivery?.status, 'pending');
  assert.equal(unit.result, undefined);
});

test('chat terminal tools reuse their authenticated call identity for acceptance steering', async (t) => {
  const { run } = await fixture(t);
  const request = () =>
    runWithSessionOriginator(person, () =>
      executeTool(
        'send_terminal',
        { slot_id: run.slotId, text: 'Also retain the original invariant' },
        'chat-call-1',
      ),
    );
  const first = await request();
  assert.equal(first.isError, false, first.content);
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.units.length, 2);
  const retry = await request();
  assert.equal(retry.isError, false, retry.content);
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.units.length, 2);
});

test('an untouched send clears only its attempt boundary and the same message can retry', async (t) => {
  const { run } = await fixture(t);
  const request = {
    runId: run.id,
    slotId: run.slotId!,
    operatorMessageId: 'untouched',
    text: 'Preserve this obligation',
  };
  delivery = 'not-attempted';
  await assert.rejects(
    runWithSessionOriginator(person, () => operatorMessage(request, () => {})),
    /was not sent/,
  );
  assert.equal(
    store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)?.delivery?.startedAt,
    undefined,
  );
  delivery = 'confirmed';
  assert.equal(
    (await runWithSessionOriginator(person, () => operatorMessage(request, () => {})))?.delivery,
    'confirmed',
  );
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.units.length, 2);
});

test('a pre-typing inspection error permits retry; typed uncertainty remains observe-only', async (t) => {
  const { run } = await fixture(t);
  const request = {
    runId: run.id,
    slotId: run.slotId!,
    operatorMessageId: 'preflight',
    text: 'Preserve this obligation',
  };
  duringDelivery = async () => {
    throw new OperatorInstructionNotAttemptedError('Pane inspection unavailable');
  };
  await assert.rejects(
    runWithSessionOriginator(person, () => operatorMessage(request, () => {})),
    /Pane inspection/,
  );
  assert.equal(
    store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)?.delivery?.startedAt,
    undefined,
  );
  duringDelivery = undefined;
  delivery = 'unconfirmed';
  await assert.rejects(
    runWithSessionOriginator(person, () => operatorMessage(request, () => {})),
    /unconfirmed/,
  );
  const typedAttempts = deliveries.filter(({ observeSince }) => observeSince === undefined).length;
  delivery = 'confirmed';
  await runWithSessionOriginator(person, () => operatorMessage(request, () => {}));
  assert.equal(
    deliveries.filter(({ observeSince }) => observeSince === undefined).length,
    typedAttempts,
  );
});

async function settleUnit(
  taskDir: string,
  runId: string,
  unitId: string,
  step: number,
  sync: () => Promise<void>,
) {
  // The real monitor watch projects the new engine generation before the worker reads it.
  await sync();
  assert.equal(
    runSubtaskCommand(taskDir, [
      'start',
      unitId,
      '--step',
      String(step),
      '--from',
      'inline:- [ ] Classify',
    ]),
    0,
  );
  const current = store.getRun(runId)!;
  const registration = current.acceptanceRegistration!;
  const unit = registration.units.find(({ id }) => id === unitId)!;
  const proposal = {
    schemaVersion: 1,
    runId,
    generation: current.engineState?.generation ?? 0,
    registrationRevision: registration.revision,
    unitId,
    classifications: unit.sources.map((source) => ({
      sourceId: source.id,
      sourceVersion: source.version,
      obligations: [{ text: source.body, proofMode: 'state' }],
    })),
  };
  const file = `${unitId}-proposal.json`;
  await writeFile(path.join(taskDir, file), JSON.stringify(proposal));
  const finish = [unitId, 'complete', '--mark-last', '--acceptance-result', file];
  assert.equal(runSubtaskCommand(taskDir, finish), 1);
  await sync();
  assert.equal(runSubtaskCommand(taskDir, finish), 0);
}

test('a late instruction at REVIEW sends pending COMPLETE through MONITOR and settles once', async (t) => {
  const { run, taskDir, sync } = await fixture(t);
  completionCalls = 0;
  await settleUnit(taskDir, run.id, 'derive-acceptance', 1, sync);
  store.updateRun(run.id, {
    status: 'reviewing',
    steps: store
      .getRun(run.id)!
      .steps.map((step) => ({ ...step, status: step.name === 'review' ? 'running' : 'done' })),
  });
  await runWithSessionOriginator(person, () =>
    operatorMessage(
      {
        runId: run.id,
        slotId: run.slotId!,
        operatorMessageId: 'late-review',
        text: 'Keep this late invariant',
      },
      () => {},
    ),
  );
  assert.equal(store.getRun(run.id)!.status, 'reviewing', 'the needed review is not interrupted');
  store.updateRun(run.id, { status: 'completing' });
  const beforeGeneration = store.getRun(run.id)!.engineState?.generation ?? 0;
  const pending = await executeCompleteStep(run.id, lifecycleContext);
  assert.equal(pending.outputs?.acceptanceDerivationPending, true);
  assert.equal(completionCalls, 0);
  assert.equal(store.getRun(run.id)!.status, 'monitoring');
  assert.equal(store.getRun(run.id)!.engineState?.generation, beforeGeneration + 1);
  const late = store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)!;
  await settleUnit(taskDir, run.id, late.id, 2, sync);
  const reviewed = await executeReviewStep(run.id, lifecycleContext);
  assert.equal(reviewed.outputs?.reason, 'pr-complete-has-no-reviewer');
  store.updateRun(run.id, { status: 'completing' });
  await executeCompleteStep(run.id, lifecycleContext);
  assert.equal(completionCalls, 1, 'the ordinary pipeline runs once after derivation settles');
});

test('a steer after completed monitoring primes a supported MONITOR continuation', async (t) => {
  const { run, taskDir, sync } = await fixture(t);
  await settleUnit(taskDir, run.id, 'derive-acceptance', 1, sync);
  store.updateRun(run.id, {
    status: 'completing',
    steps: store.getRun(run.id)!.steps.map((step) => ({
      ...step,
      status: step.name === 'monitor' || step.name === 'dispatch' ? 'done' : step.status,
    })),
  });
  const before = store.getRun(run.id)!.engineState?.generation ?? 0;
  await runWithSessionOriginator(person, () =>
    operatorMessage(
      {
        runId: run.id,
        slotId: run.slotId!,
        operatorMessageId: 'after-monitor',
        text: 'One more invariant',
      },
      () => {},
    ),
  );
  assert.equal(store.getRun(run.id)!.status, 'monitoring');
  assert.equal(store.getRun(run.id)!.engineState?.generation, before + 1);
  assert.equal(
    store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)?.delivery?.status,
    'confirmed',
  );
});

test('settlement while COMPLETE waits for admission does not skip the ordinary completion pipeline', async (t) => {
  const { run, taskDir } = await fixture(t);
  completionCalls = 0;
  runSubtaskCommand(taskDir, [
    'start',
    'derive-acceptance',
    '--step',
    '1',
    '--from',
    'inline:- [ ] Classify',
  ]);
  const registration = store.getRun(run.id)!.acceptanceRegistration!;
  const source = registration.units[0].sources[0];
  await writeFile(
    path.join(taskDir, 'race-proposal.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      generation: 0,
      registrationRevision: registration.revision,
      unitId: 'derive-acceptance',
      classifications: [
        {
          sourceId: source.id,
          sourceVersion: source.version,
          obligations: [{ text: source.body, proofMode: 'state' }],
        },
      ],
    }),
  );
  assert.equal(
    runSubtaskCommand(taskDir, [
      'derive-acceptance',
      'complete',
      '--mark-last',
      '--acceptance-result',
      'race-proposal.json',
    ]),
    1,
  );
  store.updateRun(run.id, {
    status: 'completing',
    steps: store.getRun(run.id)!.steps.map((step) => ({ ...step, status: 'done' })),
  });
  let entered!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = withRunTransition(run.id, async () => {
    entered();
    await released;
  });
  await locked;
  const completion = executeCompleteStep(run.id, lifecycleContext);
  const settledCompletion = Promise.allSettled([completion]);
  try {
    // Model the gateway's validated producer while it still owns admission.
    const { acceptAcceptanceDerivation } = await import('./acceptance-registration.js');
    const { syncAcceptanceExecutionContract } = await import('./acceptance-execution-contract.js');
    const proposal = JSON.parse(await readFile(path.join(taskDir, 'race-proposal.json'), 'utf8'));
    const accepted = acceptAcceptanceDerivation(registration, proposal, 0);
    const updated = store.updateRun(run.id, { acceptanceRegistration: accepted });
    await store.persistRunNow(updated, 'race derivation acknowledged');
    await writeFile(
      path.join(taskDir, 'inputs/acceptance-registration.json'),
      JSON.stringify({ schemaVersion: 1, generation: 0, registration: accepted }),
    );
    await syncAcceptanceExecutionContract(
      updated,
      ORCHESTRATOR_LOCALITY,
      taskDir,
      taskDir,
      async () => true,
    );
  } finally {
    release();
    await hold;
    await settledCompletion;
  }
  const result = await completion;
  assert.equal(result.outputs?.acceptanceDerivationPending, undefined);
  assert.equal(completionCalls, 1);
  assert.equal(store.getRun(run.id)!.engineState?.generation ?? 0, 0);
});

test('a retained paused visual hold replays COMPLETE without reviewer acknowledgement', async (t) => {
  const f = await fixture(t);
  await settleUnit(f.taskDir, f.run.id, 'derive-acceptance', 1, f.sync);
  const current = store.getRun(f.run.id)!;
  const proof = {
    registrationRevision: current.acceptanceRegistration!.revision,
    contractRevision: current.acceptanceExecutionContract!.revision,
    headSha: 'a'.repeat(40),
  };
  const decision = {
    id: 'retained-output-review',
    type: 'engine_output_review' as const,
    title: 'Review completion proof',
    description: 'Retained hold',
    actions: [],
    createdAt: '2026-10-28T00:00:00Z',
    payload: {
      kind: 'output-review' as const,
      completionProof: proof,
      manifestDigest: 'b'.repeat(64),
      reportPath: 'artifacts/report.md',
    },
  };
  store.updateRun(
    f.run.id,
    Object.assign(
      {
        status: 'paused' as const,
        metrics: { ...current.metrics, outcome: 'partial' as const },
        decisions: [decision],
        steps: current.steps.map((step) => ({
          ...step,
          status: step.name === 'complete' ? ('pending' as const) : ('done' as const),
        })),
      },
      { acceptanceProofHold: { ...proof, state: 'held', decisionId: decision.id } },
    ),
  );
  const { runReplayStep } = await import('../methods/run/replay-step.js');
  await runReplayStep({ runId: f.run.id, stepName: 'complete' }, () => {});
  assert.equal(store.getRun(f.run.id)!.status, 'completing');
  assert.equal(
    store.getRun(f.run.id)!.metrics.outcome,
    'partial',
    'replay preserves worker metrics until normal completion settles',
  );
  const { captureRunOutput } = await import('../run-completion/output.js');
  await captureRunOutput(f.run.id, false, true);
  assert.equal(
    store
      .getRun(f.run.id)!
      .decisions.some(
        ({ payload, resolvedAt }) => payload?.kind === 'output-review' && !resolvedAt,
      ),
    false,
  );
  completionCalls = 0;
  await executeCompleteStep(f.run.id, lifecycleContext);
  assert.equal(completionCalls, 1);
  assert.equal(store.getRun(f.run.id)!.status, 'completing');
});
