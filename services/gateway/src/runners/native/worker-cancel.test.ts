import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { NATIVE_WORKER_CANCEL_COMMAND } from '@farmslot/agent-runtime/native';
import {
  type AcceptanceRegistration,
  type AgentContext,
  Methods,
  type NativeWorkerSessionBinding,
  type Principal,
} from '@farmslot/protocol';

const home = mkdtempSync(path.join(tmpdir(), 'worker-cancel-'));
process.env.FARMSLOT_HOME = home;
process.env.FARMSLOT_RUNS_DIR = path.join(home, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'runner-service';
after(async () => {
  await persistRunNow(run, 'cancel test teardown');
  rmSync(home, { recursive: true, force: true });
});

await import('../../runtime/mock-pty.test-support.js');
const node = await import('./node.js');
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      _owner: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      return { receipt: { commandId: params.commandId } };
    },
  },
});
// The worker owns its slot; the fence rereads that ownership around its checks.
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => ({ current_run_id: run.id, phase: 'working' }),
  },
});
const { createRun, updateRun, persistRunNow } = await import('../../runs/store.js');
const { runWithSessionOriginator } = await import('../../security/work-originator.js');
const { nativeSessionRoute } = await import('../../methods/native-session.js');
const { completionSendBackCommandId, nativeWorkerInstructionCommandId } =
  await import('./worker-control.js');
const service: Principal = {
  id: 'runner-service',
  subject: { type: 'service', displayName: 'Runner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const admin: Principal = {
  ...service,
  id: 'person-admin',
  subject: { type: 'person', displayName: 'Admin' },
};
const run = runWithSessionOriginator(service, () =>
  createRun({
    project: 'cancel-fixture',
    flowType: 'dev',
    ticketOrPr: 'CANCEL',
    transport: 'native',
  }),
);
const binding: NativeWorkerSessionBinding = {
  sessionId: 'session',
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'task',
  executionNodeId: 'local',
  ownerPrincipalId: service.id,
  acceptedAt: new Date().toISOString(),
};
const worker: AgentContext = {
  id: 'dev',
  role: 'dev',
  label: 'Dev',
  status: 'working',
  runId: run.id,
  slotId: 'slot',
  nativeSession: binding,
  nativeSessionHistory: [
    {
      ...binding,
      leaseId: 'earlier',
      commandId: 'earlier-task',
      recovery: { fromGeneration: 'earliest', commandId: 'recovery' },
    },
  ],
};
const subtask: AgentContext = {
  id: 'subtask',
  role: 'dev',
  label: 'Subtask',
  status: 'working',
  runId: run.id,
  slotId: 'slot',
  nativeSessionOwner: { contextId: worker.id, sessionId: binding.sessionId, leaseId: 'lease' },
  nativeCommandId: 'subtask-instruction',
};
updateRun(run.id, { status: 'monitoring', slotId: 'slot', agentContexts: [worker, subtask] });
const target = {
  runId: run.id,
  contextId: worker.id,
  generation: binding.generation!,
  leaseId: binding.leaseId,
};
const cancel = (commandId: unknown, pin = target) =>
  runWithSessionOriginator(admin, () =>
    nativeSessionRoute(
      Methods.NATIVE_SESSION_CANCEL,
      { sessionId: binding.sessionId, executionNodeId: 'local', worker: pin, commandId },
      admin,
    ),
  );

test('a pinned worker removes only a message its operator queued, through the input fence', async () => {
  assert.deepEqual(await cancel('operator-message'), {
    receipt: { commandId: 'operator-message' },
  });
  assert.deepEqual(calls, [
    {
      method: NATIVE_WORKER_CANCEL_COMMAND,
      params: {
        sessionId: 'session',
        executionNodeId: 'local',
        generation: 'generation',
        leaseId: 'lease',
        commandId: 'operator-message',
      },
    },
  ]);
  for (const commandId of [
    'task',
    'earlier-task',
    'recovery',
    'subtask-instruction',
    nativeWorkerInstructionCommandId(run.id, binding, 'monitor-nudge', 'Keep going'),
    completionSendBackCommandId('decision'),
  ])
    await assert.rejects(cancel(commandId), /Farmslot sent this worker instruction/);
  await assert.rejects(cancel('operator-message', { ...target, leaseId: 'stale' }), /stale/);
  await assert.rejects(cancel(undefined), /requires commandId/);
  const registration: AcceptanceRegistration = {
    schemaVersion: 1,
    runId: run.id,
    revision: 1,
    intake: {
      provider: 'github',
      repository: 'example/repo',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      capturedAt: '2026-10-31T00:00:00Z',
    },
    original: [],
    derived: [],
    units: [],
  };
  updateRun(run.id, { acceptanceRegistration: registration });
  await assert.rejects(cancel('operator-message'), /records worker messages for acceptance/);
  assert.equal(calls.length, 1);
});
