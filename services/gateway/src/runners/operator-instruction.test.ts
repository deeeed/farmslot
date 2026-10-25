import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import type { NativeSessionReadResult } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-transport-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
after(() => rm(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const owner = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Transport fixture owner' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
const store = await import('../runs/store.js');
const controls = await import('./native/worker-control.js');
const recovery = await import('./native/worker-recovery.js');
let stopped = false;
let sendResult: Awaited<ReturnType<typeof controls.sendNativeWorkerInstruction>> = 'confirmed';
let reads: (() => void) | undefined;
const sends: Parameters<typeof controls.sendNativeWorkerInstruction>[0][] = [];
const resumes: Parameters<typeof recovery.resumeNativeWorker>[1][] = [];
mock.module('./native/worker-control.js', {
  namedExports: {
    ...controls,
    readNativeWorkerSnapshot: async () => {
      reads?.();
      return { session: { processStopped: stopped } } satisfies {
        session: Pick<NativeSessionReadResult['session'], 'processStopped'>;
      };
    },
    sendNativeWorkerInstruction: async (
      input: Parameters<typeof controls.sendNativeWorkerInstruction>[0],
    ) => {
      input.assertCurrent?.();
      sends.push(input);
      return sendResult;
    },
  },
});
mock.module('./native/worker-recovery.js', {
  namedExports: {
    ...recovery,
    resumeNativeWorker: async (
      _runId: string,
      options: Parameters<typeof recovery.resumeNativeWorker>[1],
    ) => {
      options?.assertCurrent?.();
      resumes.push(options);
    },
  },
});
const adapterModule: string = './operator-instruction.js?operator-transport-test';
const { deliverOperatorInstruction }: typeof import('./operator-instruction.js') = await import(
  adapterModule
);

async function fixture(t: TestContext) {
  stopped = false;
  reads = undefined;
  sends.length = 0;
  resumes.length = 0;
  sendResult = 'confirmed';
  const run = store.createRun(
    {
      project: 'proof',
      flowType: 'pr-complete',
      ticketOrPr: 'example/repo#1',
      transport: 'native',
      runner: 'claude',
      slotId: 'proof',
    },
    { nativeOwnerPrincipalId: owner.id },
  );
  store.updateRun(run.id, {
    status: 'monitoring',
    agentContexts: [
      {
        id: 'primary',
        role: 'primary',
        label: 'Worker',
        status: 'working',
        runId: run.id,
        slotId: 'proof',
        runner: 'claude',
        nativeSession: {
          sessionId: randomUUID(),
          generation: randomUUID(),
          leaseId: randomUUID(),
          ownerPrincipalId: owner.id,
          executionNodeId: 'local',
          commandId: 'initial',
        },
      },
    ],
  });
  t.after(async () => {
    const current = store.getRun(run.id)!;
    const closed = store.updateRun(run.id, {
      status: 'done',
      agentContexts: current.agentContexts?.map((context) => ({
        ...context,
        nativeSession: { ...context.nativeSession!, closedAt: new Date().toISOString() },
      })),
    });
    await store.persistRunNow(closed, 'operator delivery fixture teardown');
    await store.deleteRun(run.id);
  });
  return store.getRun(run.id)!;
}

test('native operator delivery preserves the caller command ID and permits the supported busy queue', async (t) => {
  const run = await fixture(t);
  sendResult = 'queued';
  assert.equal(
    await deliverOperatorInstruction(
      run,
      'unit',
      'Instruction',
      undefined,
      'primary',
      'caller-command',
    ),
    'queued',
  );
  assert.equal(sends[0].logicalCommandId, 'caller-command');
  assert.equal(sends[0].allowBusyQueue, true);
  assert.equal(sends[0].contextId, 'primary');
  assert.equal(resumes.length, 0);
});

test('stopped native delivery resumes only the retained context and command', async (t) => {
  const run = await fixture(t);
  stopped = true;
  assert.equal(
    await deliverOperatorInstruction(
      run,
      'unit',
      'Instruction',
      undefined,
      'primary',
      'caller-command',
    ),
    'confirmed',
  );
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0]?.purpose, 'operator-message');
  if (resumes[0]?.purpose !== 'operator-message') assert.fail('Expected operator-message recovery');
  assert.equal(resumes[0].contextId, 'primary');
  assert.equal(resumes[0].commandId, 'caller-command');
  assert.equal(sends.length, 0);
});

test('a generation replacement during native inspection refuses before send or resume', async (t) => {
  const run = await fixture(t);
  reads = () => store.updateRun(run.id, { engineState: { generation: 1 } });
  await assert.rejects(
    deliverOperatorInstruction(run, 'unit', 'Instruction'),
    /generation changed/,
  );
  assert.equal(sends.length, 0);
  assert.equal(resumes.length, 0);
});
