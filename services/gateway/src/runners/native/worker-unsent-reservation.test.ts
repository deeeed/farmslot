import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  type AgentContext,
  contextIdFor,
  type NativeWorkerSessionBinding,
  type Run,
} from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

// The real run store and its ownership guards, under an isolated home with a native owner.
const home = await mkdtemp(path.join(tmpdir(), 'unsent-reservation-'));
const keys = ['FARMSLOT_HOME', 'FARMSLOT_RUNS_DIR', 'FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID'] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
process.env.FARMSLOT_HOME = home;
process.env.FARMSLOT_RUNS_DIR = path.join(home, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'automation';
const created: Run[] = [];
after(async () => {
  try {
    for (const run of created) {
      const completedAt = new Date().toISOString();
      const current = getRun(run.id);
      const settled = updateRun(run.id, {
        status: 'done',
        completedAt,
        agentContexts: current?.agentContexts?.map((context) => ({
          ...context,
          nativeSession: context.nativeSession
            ? { ...context.nativeSession, releasedAt: completedAt }
            : undefined,
        })),
      });
      await persistRunNow(settled);
      await deleteRun(run.id);
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
const { CredentialStoreRuntime, CredentialStoreWriter } =
  await import('@farmslot/credential-store');
const writer = new CredentialStoreWriter(new CredentialStoreRuntime({ FARMSLOT_HOME: home }), true);
const owner = writer.createPrincipal({ type: 'service', displayName: 'automation' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
writer.issueCredential(owner.id, 'fixture');
const { runWithSessionOriginator } = await import('../../security/work-originator.js');
const { createRun, deleteRun, getRun, persistRunNow, updateRun } =
  await import('../../runs/store.js');
const { forgetUnsentNativeLaunch } = await import('./worker-unsent-reservation.js');
const contextId = contextIdFor('primary');

/** A native dispatch's reservation recorded through the real store, before ENSURE was sent. */
function reservedRun(): { run: Run; binding: NativeWorkerSessionBinding } {
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'dev',
      project: 'fixture',
      ticketOrPr: `PROJ-${Date.now()}`,
      transport: 'native',
    }),
  );
  created.push(run);
  const binding: NativeWorkerSessionBinding = {
    sessionId: randomUUID(),
    leaseId: randomUUID(),
    commandId: randomUUID(),
    ownerPrincipalId: owner.id,
    executionNodeId: 'local',
    launchDigest: 'digest-of-the-refused-launch',
    safetyTier: 'sandboxed',
  };
  const context: AgentContext = {
    id: contextId,
    runId: run.id,
    slotId: 'unsent-slot',
    role: 'primary',
    label: 'Primary',
    status: 'launching',
    taskFile: 'tasks/unsent/TASK.md',
    runner: 'claude',
    model: 'sonnet',
    nativeSession: binding,
  };
  return { run: updateRun(run.id, { slotId: 'unsent-slot', agentContexts: [context] }), binding };
}

test('an unsent launch is forgotten in one write the store guard admits', async () => {
  const { run, binding } = reservedRun();
  // The store never lets a held reservation be dropped; forgetting keeps its session and lease.
  assert.throws(
    () =>
      updateRun(run.id, {
        agentContexts: [{ ...run.agentContexts![0]!, nativeSession: undefined }],
      }),
    /Native worker ownership cannot be discarded/,
  );
  await forgetUnsentNativeLaunch({
    runId: run.id,
    role: 'primary',
    contextId,
    binding,
    checkRun: () => {},
  });
  const context = getRun(run.id)!.agentContexts![0]!;
  assert.equal(context.nativeSession?.sessionId, binding.sessionId);
  assert.equal(context.nativeSession?.leaseId, binding.leaseId);
  assert.equal(context.nativeSession?.launchDigest, undefined);
  assert.equal(context.nativeSession?.safetyTier, undefined);
  assert.equal(context.nativeSessionHistory, undefined, 'no session is invented for history');
});

test('a superseded attempt leaves the reservation its replay may be reusing', async () => {
  const { run, binding } = reservedRun();
  await assert.rejects(
    forgetUnsentNativeLaunch({
      runId: run.id,
      role: 'primary',
      contextId,
      binding,
      checkRun: () => {
        throw new Error('Native worker dispatch generation changed');
      },
    }),
    /generation changed/,
  );
  const context = getRun(run.id)!.agentContexts![0]!;
  assert.equal(context.nativeSession?.launchDigest, binding.launchDigest);
});
