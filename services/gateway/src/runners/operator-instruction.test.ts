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
const registry = await import('./registry.js');
const lifecycle = await import('./session-lifecycle.js');
const config = await import('../core/config.js');
const { makeVars } = await import('./test-fixtures.js');
let tmuxOutcome: import('./registry.js').RunnerInstructionOutcome = 'sent';
let inspectionError = false;
let tmuxStopped = false;
let reloadAttempts = 0;
const tmuxCalls: Parameters<typeof registry.sendRunnerInstructionWithOutcome>[] = [];
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => makeVars({ slotId: 'proof', remoteRepo: root }),
    resolveProjectRuntimeDir: async () => root,
  },
});
mock.module('./session-lifecycle.js', {
  namedExports: {
    ...lifecycle,
    inspectRunnerRecovery: async () => {
      if (inspectionError) throw new Error('Pane inspection unavailable');
      return {
        supported: true,
        liveTarget: { valid: true, state: tmuxStopped ? 'stopped' : 'live', paneTarget: '%999999' },
      } satisfies Pick<
        import('./session-lifecycle.js').RunnerRecoveryInspection,
        'supported' | 'liveTarget'
      >;
    },
    reloadRunnerForPark: async () => {
      reloadAttempts++;
      return {
        ok: false,
        status: 'acceptance-failed',
        runnerId: 'claude',
        target: '%999999',
        sessionId: 'retained',
        error: 'Reload acknowledgement unavailable',
      } satisfies Awaited<ReturnType<typeof lifecycle.reloadRunnerForPark>>;
    },
  },
});
mock.module('./registry.js', {
  namedExports: {
    ...registry,
    sendRunnerInstructionWithOutcome: async (
      ...args: Parameters<typeof registry.sendRunnerInstructionWithOutcome>
    ) => {
      tmuxCalls.push(args);
      return tmuxOutcome;
    },
  },
});

let stopped = false;
let resumeError: Error | undefined;
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
      if (resumeError) throw resumeError;
    },
  },
});
const adapterModule: string = './operator-instruction.js?operator-transport-test';
const {
  deliverOperatorInstruction,
  OperatorInstructionNotAttemptedError,
}: typeof import('./operator-instruction.js') = await import(adapterModule);

async function fixture(t: TestContext, native = true) {
  tmuxCalls.length = 0;
  tmuxOutcome = 'sent';
  inspectionError = false;
  tmuxStopped = false;
  reloadAttempts = 0;
  stopped = false;
  resumeError = undefined;
  reads = undefined;
  sends.length = 0;
  resumes.length = 0;
  sendResult = 'confirmed';
  const run = store.createRun(
    {
      project: 'proof',
      flowType: 'pr-complete',
      ticketOrPr: 'example/repo#1',
      transport: native ? 'native' : 'tmux',
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
        runnerSessionId: randomUUID(),
        runnerSessionPath: path.join(root, 'retained.jsonl'),
        target: native
          ? undefined
          : { session: 'proof', window: 'worker', target: '%999999', paneId: '%999999' },
        nativeSession: native
          ? {
              sessionId: randomUUID(),
              generation: randomUUID(),
              leaseId: randomUUID(),
              ownerPrincipalId: owner.id,
              executionNodeId: 'local',
              commandId: 'initial',
            }
          : undefined,
      },
    ],
  });
  t.after(async () => {
    const current = store.getRun(run.id)!;
    const closed = store.updateRun(run.id, {
      status: 'done',
      agentContexts: current.agentContexts?.map((context) => ({
        ...context,
        ...(context.nativeSession
          ? { nativeSession: { ...context.nativeSession, closedAt: new Date().toISOString() } }
          : {}),
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

test('an uncertain native resume retries the same caller command instead of reserving another', async (t) => {
  const run = await fixture(t);
  stopped = true;
  resumeError = new Error('Native resume acknowledgement timed out');
  await assert.rejects(
    deliverOperatorInstruction(
      run,
      'completion',
      'Fix the refused video.',
      undefined,
      'primary',
      'same-completion-command',
    ),
    /acknowledgement timed out/,
  );
  resumeError = undefined;
  assert.equal(
    await deliverOperatorInstruction(
      run,
      'completion',
      'Fix the refused video.',
      100,
      'primary',
      'same-completion-command',
    ),
    'confirmed',
  );
  assert.equal(resumes.length, 2);
  assert.equal(resumes[0]?.purpose, 'operator-message');
  assert.equal(resumes[1]?.purpose, 'operator-message');
  if (resumes[0]?.purpose !== 'operator-message' || resumes[1]?.purpose !== 'operator-message')
    assert.fail('Expected retained operator-message recovery');
  assert.equal(resumes[0].commandId, 'same-completion-command');
  assert.equal(resumes[1].commandId, resumes[0].commandId);
  assert.equal(resumes[1].contextId, resumes[0].contextId);
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

test('an untouched tmux hold can retry and a typed uncertain send stays observe-only', async (t) => {
  const run = await fixture(t, false);
  tmuxOutcome = 'held-untouched';
  assert.equal(await deliverOperatorInstruction(run, 'unit', 'Instruction'), 'not-attempted');
  tmuxOutcome = 'sent';
  assert.equal(await deliverOperatorInstruction(run, 'unit', 'Instruction'), 'confirmed');
  assert.equal(tmuxCalls.filter((args) => !args[6]?.observeOnly).length, 2);
  tmuxOutcome = 'typed-unconfirmed';
  assert.equal(await deliverOperatorInstruction(run, 'second', 'Other instruction'), 'unconfirmed');
  const attempts = tmuxCalls.filter((args) => !args[6]?.observeOnly).length;
  tmuxOutcome = 'held-untouched';
  assert.equal(
    await deliverOperatorInstruction(run, 'second', 'Other instruction', 100),
    'unconfirmed',
  );
  assert.equal(tmuxCalls.filter((args) => !args[6]?.observeOnly).length, attempts);
  assert.equal(tmuxCalls.at(-1)?.[6]?.acceptanceSinceMs, 100);
});

test('tmux pre-typing inspection failure reports safe retry without a send', async (t) => {
  const run = await fixture(t, false);
  inspectionError = true;
  await assert.rejects(deliverOperatorInstruction(run, 'unit', 'Instruction'), {
    name: 'Error',
    message: 'Pane inspection unavailable',
  });
  assert.equal(tmuxCalls.length, 0);
});

test('an uncertain stopped tmux reload never clears the delivery attempt', async (t) => {
  const run = await fixture(t, false);
  tmuxStopped = true;
  await assert.rejects(deliverOperatorInstruction(run, 'unit', 'Instruction'), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof OperatorInstructionNotAttemptedError, false);
    assert.match(error.message, /Reload acknowledgement unavailable/);
    return true;
  });
  assert.equal(tmuxCalls.length, 0);
  assert.equal(reloadAttempts, 1);
  tmuxOutcome = 'held-untouched';
  assert.equal(await deliverOperatorInstruction(run, 'unit', 'Instruction', 100), 'unconfirmed');
  assert.equal(reloadAttempts, 1);
  assert.equal(tmuxCalls.at(-1)?.[6]?.observeOnly, true);
});
