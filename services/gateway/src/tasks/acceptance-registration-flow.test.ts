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

let delivery: 'confirmed' | 'queued' | 'unconfirmed' = 'confirmed';
let duringDelivery: (() => Promise<void>) | undefined;
const deliveries: Array<{ key: string; observeSince?: number }> = [];
mock.module('../runners/operator-instruction.js', {
  namedExports: {
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
    acceptanceContractVersion: 1,
    claimReviewSupported: true,
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
