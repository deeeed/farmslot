import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { Methods, type Principal, type Run, type RunDecision } from '@farmslot/protocol';

import { resolveAgentTarget, upsertAgentContext } from '../agents/contexts.js';
import { decisionResolve } from '../methods/decisions.js';
import { restartNativeWorkerContexts } from '../runners/native/worker-restart.js';
import {
  archiveRun,
  createRun,
  deleteRun,
  persistRunNow,
  runsDirectory,
  updateRun,
} from '../runs/store.js';

import { assertNativeWorkerRpcAccess } from './native-worker-access.js';
import { assertNativeRunOwner } from './native-worker-owner.js';
import { runWithSessionOriginator } from './work-originator.js';

const owner: Principal = {
  id: 'native-owner-test',
  subject: { type: 'person', displayName: 'Owner' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const other: Principal = {
  id: 'other-admin-test',
  subject: { type: 'person', displayName: 'Other' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};

test('fresh native restart retains closed history after the slot was detached', async (t) => {
  const { params, runs } = setup(t);
  const run = runWithSessionOriginator(owner, () => createRun({ ...params, transport: 'native' }));
  runs.push(run);
  const binding = {
    sessionId: randomUUID(),
    generation: randomUUID(),
    leaseId: randomUUID(),
    commandId: randomUUID(),
    ownerPrincipalId: owner.id,
    executionNodeId: 'local',
    closedAt: new Date().toISOString(),
  };
  updateRun(run.id, {
    status: 'cancelled',
    slotId: null,
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Dev',
        status: 'idle',
        slotId: 'detached-native-fixture',
        runId: run.id,
        nativeSession: binding,
      },
    ],
  });
  await restartNativeWorkerContexts(run.id, () => {});
  assert.equal(run.agentContexts?.[0]?.nativeSession, undefined);
  assert.deepEqual(run.agentContexts?.[0]?.nativeSessionHistory, [binding]);
  await restartNativeWorkerContexts(run.id, () => {});
  assert.deepEqual(run.agentContexts?.[0]?.nativeSessionHistory, [binding]);
});

test('decision-only resolution checks the resolved native run owner before effects', async (t) => {
  const { params, runs } = setup(t);
  const run = runWithSessionOriginator(owner, () => createRun({ ...params, transport: 'native' }));
  runs.push(run);
  const decision: RunDecision = {
    id: randomUUID(),
    type: 'monitor_timeout',
    title: 'Continue',
    description: 'Fixture',
    createdAt: new Date().toISOString(),
    actions: [{ id: 'continue', label: 'Continue', style: 'primary' }],
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  await assert.rejects(
    runWithSessionOriginator(other, () =>
      decisionResolve({
        decisionId: decision.id,
        actionId: 'continue',
      }),
    ),
    /another principal/,
  );
  assert.equal(run.decisions[0]?.resolvedAt, undefined);
  assert.equal(run.status, 'blocked');
  // Owner reaches normal action validation; the ownership guard does not blanket-refuse.
  await assert.rejects(
    runWithSessionOriginator(owner, () =>
      decisionResolve({
        decisionId: decision.id,
        actionId: 'invalid',
      }),
    ),
    /Action not found/,
  );
});

function setup(t: TestContext) {
  const previous = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
  const runs: Run[] = [];
  t.after(async () => {
    for (const run of runs) {
      updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
    if (previous === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previous;
  });
  return {
    runs,
    params: {
      flowType: 'dev' as const,
      project: 'native-worker-test',
      ticketOrPr: `PROJ-${randomUUID()}`,
    },
  };
}

test('native ownership comes from the authenticated creator and survives durable/internal handoff', async (t) => {
  const { params, runs } = setup(t);
  assert.throws(() => createRun({ ...params, transport: 'native' }), /principal.*own/);
  assert.throws(
    () => runWithSessionOriginator(other, () => createRun({ ...params, transport: 'native' })),
    /principal.*own/,
  );
  const forged = { ...params, transport: 'native' as const, nativeOwnerPrincipalId: owner.id };
  assert.throws(
    () => runWithSessionOriginator(owner, () => createRun(forged)),
    /cannot be supplied/,
  );
  const run = runWithSessionOriginator(owner, () => createRun({ ...params, transport: 'native' }));
  runs.push(run);
  await persistRunNow(run, 'native ownership test');
  const stored = JSON.parse(await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'));
  assert.equal(stored.nativeOwnerPrincipalId, owner.id);
  assert.equal(stored.transport, 'native');
  const child = createRun({
    ...params,
    ticketOrPr: `${params.ticketOrPr}-child`,
    parentRunId: run.id,
  });
  runs.push(child);
  assert.equal(child.transport, 'native');
  assert.equal(child.nativeOwnerPrincipalId, owner.id);
  assert.throws(
    () => runWithSessionOriginator(other, () => createRun({ ...params, parentRunId: run.id })),
    /another principal/,
  );
  assert.throws(() => updateRun(run.id, { transport: 'tmux' }), /fixed for the run/);
  assert.throws(() => updateRun(run.id, { nativeOwnerPrincipalId: other.id }), /cannot be changed/);
  const terminal = { ...run, transport: 'native' as const, nativeOwnerPrincipalId: undefined };
  assert.throws(
    () => runWithSessionOriginator(owner, () => assertNativeRunOwner(terminal)),
    /no recorded profile owner/,
  );
});

test('generic native run and slot targets enforce ownership without blocking node registration or tmux runs', async (t) => {
  const { params, runs } = setup(t);
  const native = runWithSessionOriginator(owner, () =>
    createRun({ ...params, transport: 'native', slotId: 'native-owner-fixture' }),
  );
  const tmux = createRun({
    ...params,
    ticketOrPr: `${params.ticketOrPr}-tmux`,
    slotId: 'tmux-owner-fixture',
  });
  runs.push(native, tmux);
  assert.equal(tmux.transport, undefined);
  assert.equal(tmux.nativeOwnerPrincipalId, undefined);
  await assert.rejects(
    resolveAgentTarget(native.slotId!, { runId: native.id }),
    /Use native session controls/,
  );
  await assert.rejects(
    resolveAgentTarget(native.slotId!, { runId: native.id, target: 'fixture:0' }),
    /Use native session controls/,
  );
  const binding = {
    sessionId: randomUUID(),
    leaseId: randomUUID(),
    executionNodeId: 'local',
    ownerPrincipalId: owner.id,
    commandId: randomUUID(),
  };
  await assert.rejects(
    upsertAgentContext(native.id, 'dev', {
      nativeSession: binding,
      target: { session: 'fixture', target: 'fixture:0' },
    }),
    /cannot also have a tmux target/,
  );
  await assert.rejects(
    upsertAgentContext(native.id, 'dev', {
      nativeSession: { ...binding, ownerPrincipalId: other.id },
      target: null,
    }),
    /must preserve its run owner/,
  );
  await runWithSessionOriginator(owner, () =>
    assertNativeWorkerRpcAccess(Methods.RUN_CANCEL, { runId: native.id }),
  );
  await runWithSessionOriginator(other, async () => {
    await assert.rejects(
      assertNativeWorkerRpcAccess(Methods.RUN_CANCEL, { runId: native.id }),
      /another principal/,
    );
    await assert.rejects(
      assertNativeWorkerRpcAccess(Methods.RUN_BULK_DELETE, { runIds: [tmux.id, native.id] }),
      /another principal/,
    );
    await assert.rejects(
      assertNativeWorkerRpcAccess(Methods.SLOT_RELEASE, { slotId: native.slotId }),
      /another principal/,
    );
    await assert.rejects(
      assertNativeWorkerRpcAccess(Methods.RUNTIME_POSTURE_APPLY, {
        target: { slotId: native.slotId },
      }),
      /another principal/,
    );
    await assertNativeWorkerRpcAccess(Methods.RUN_CANCEL, { runId: tmux.id });
    await assertNativeWorkerRpcAccess('node.connect', { machine: 'native-owner-fixture' });
    await assertNativeWorkerRpcAccess(Methods.GATEWAY_PING, {});
  });
  updateRun(native.id, { status: 'done', completedAt: new Date().toISOString() });
  await runWithSessionOriginator(other, () =>
    assertNativeWorkerRpcAccess(Methods.SLOT_RELEASE, { slotId: native.slotId }),
  );
  updateRun(native.id, {
    agentContexts: native.agentContexts?.map((context) => ({ ...context, nativeSession: binding })),
  });
  assert.throws(() => updateRun(native.id, { agentContexts: [] }), /before confirmed close/);
  assert.throws(() => updateRun(native.id, { slotId: null }), /before changing its slot/);
  assert.throws(
    () => updateRun(native.id, { project: 'different-project' }),
    /before changing its slot/,
  );
  await assert.rejects(deleteRun(native.id), /before confirmed close/);
  await assert.rejects(archiveRun(native.id), /before confirmed close/);
  updateRun(native.id, {
    agentContexts: native.agentContexts?.map((context) => ({
      ...context,
      nativeSession: {
        ...binding,
        closedAt: new Date().toISOString(),
        recovery: {
          fromGeneration: randomUUID(),
          commandId: randomUUID(),
          requestedAt: new Date().toISOString(),
        },
      },
    })),
  });
  await assert.rejects(deleteRun(native.id), /before confirmed close/);
  assert.throws(() => updateRun(native.id, { agentContexts: [] }), /before confirmed close/);
  await runWithSessionOriginator(other, () =>
    assert.rejects(
      assertNativeWorkerRpcAccess(Methods.SLOT_RELEASE, { slotId: native.slotId }),
      /another principal/,
    ),
  );
  updateRun(native.id, {
    agentContexts: native.agentContexts?.map((context) => ({
      ...context,
      nativeSession: { ...binding, closedAt: new Date().toISOString() },
    })),
  });
  await runWithSessionOriginator(other, () =>
    assertNativeWorkerRpcAccess(Methods.SLOT_RELEASE, { slotId: native.slotId }),
  );
});

test('native worker configuration is copied, persisted and cannot silently change runner or directory binding', async (t) => {
  const { params, runs } = setup(t);
  const nativeProfile = {
    executionNodeId: 'local',
    runner: 'claude',
    profileId: 'work',
    accountContextId: randomUUID(),
  };
  assert.throws(
    () =>
      runWithSessionOriginator(owner, () =>
        createRun({
          ...params,
          nativeProfile,
        }),
      ),
    /requires native worker transport/,
  );
  assert.throws(
    () =>
      runWithSessionOriginator(owner, () =>
        createRun({
          ...params,
          transport: 'native',
          runner: 'codex',
          nativeProfile,
        }),
      ),
    /another worker runner/,
  );
  for (const invalid of [null, false, '', { ...nativeProfile, directory: '/unexpected' }]) {
    const request = { ...params, transport: 'native' as const, nativeProfile };
    Reflect.set(request, 'nativeProfile', invalid);
    assert.throws(
      () => runWithSessionOriginator(owner, () => createRun(request)),
      /Invalid native profile reference/,
    );
  }
  const run = runWithSessionOriginator(owner, () =>
    createRun({
      ...params,
      transport: 'native',
      nativeProfile,
    }),
  );
  runs.push(run);
  assert.equal(run.metrics.runner, nativeProfile.runner);
  assert.deepEqual(run.nativeProfile, nativeProfile);
  assert.notEqual(run.nativeProfile, nativeProfile);
  await persistRunNow(run, 'native profile test');
  const stored = JSON.parse(await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'));
  assert.deepEqual(stored.nativeProfile, nativeProfile);
  assert.throws(
    () =>
      updateRun(run.id, {
        nativeProfile: { ...nativeProfile, accountContextId: randomUUID() },
      }),
    /configuration is fixed/,
  );
  assert.doesNotThrow(() => updateRun(run.id, { nativeProfile: { ...nativeProfile } }));
});
