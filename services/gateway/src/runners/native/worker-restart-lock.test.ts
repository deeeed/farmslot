import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { NATIVE_WORKER_CANCEL } from '@farmslot/agent-runtime/native';
import type { AgentContext } from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { makeVars } = await import('../test-fixtures.js');
const vars = makeVars({ machine: 'restart-lock-fixture' });
const config = await import('../../core/config.js');
mock.module('../../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => vars },
});
const owner = await import('../../security/native-worker-owner.js');
mock.module('../../security/native-worker-owner.js', {
  namedExports: {
    ...owner,
    assertNativeRunOwner: () => {},
    resolveNativeWorkerOwner: () => 'owner',
  },
});
let available = false;
const node = await import('./node.js');
mock.module('./node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      _owner: string,
      method: string,
      params: { sessionId: string; leaseId: string },
    ) => {
      assert.equal(method, NATIVE_WORKER_CANCEL);
      return {
        cancelled: available,
        sessionId: params.sessionId,
        leaseId: params.leaseId,
        session: { state: 'closed', processStopped: true },
      };
    },
  },
});
mock.module('../../methods/runtime-posture.js', {
  namedExports: {
    getRunResourcePostureReconciler: () => ({
      apply: async () => ({ ok: true, transition: { failures: [] } }),
    }),
  },
});
mock.module('../../server.js', { namedExports: { broadcastEvent: () => {} } });
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');
const { rewriteStatusFile } = await import('../../core/state.js');
const { withRunTransition, withMachineRunTransition } =
  await import('../../run-lifecycle/transition-coordinator.js');
const { cancelNativeRunWorkers } = await import('./worker.js');
const { restartNativeWorkerContexts } = await import('./worker-restart.js');

test(
  'cancelled native restart finishes an unconfirmed handoff without reacquiring its machine lock',
  { timeout: 3000 },
  async (t) => {
    const source = createRun(
      {
        flowType: 'dev',
        project: 'restart-fixture',
        ticketOrPr: 'DEV-RESTART-SOURCE',
        slotId: vars.slotId,
        transport: 'native',
      },
      { nativeOwnerPrincipalId: 'owner' },
    );
    const destination = createRun(
      {
        flowType: 'dev',
        project: 'restart-fixture',
        ticketOrPr: 'DEV-RESTART-DESTINATION',
        slotId: vars.slotId,
        transport: 'native',
      },
      { nativeOwnerPrincipalId: 'owner' },
    );
    t.after(async () => {
      for (const run of [source, destination]) {
        updateRun(run.id, { status: 'done', agentContexts: [] });
        await deleteRun(run.id);
      }
      await rewriteStatusFile((current) => ({
        ...current,
        slots: (current?.slots ?? []).filter((row) => row.slot !== vars.slotId),
      }));
    });
    const context = (runId: string, leaseId: string): AgentContext => ({
      id: 'dev',
      role: 'dev',
      label: 'Worker',
      runId,
      slotId: vars.slotId,
      status: 'working',
      runner: 'claude',
      nativeSession: {
        sessionId: 'session',
        generation: 'generation',
        leaseId,
        commandId: 'command',
        ownerPrincipalId: 'owner',
        executionNodeId: 'local',
        launchRequestedAt: new Date().toISOString(),
      },
    });
    const retained = context(source.id, 'source-lease');
    const incoming = context(destination.id, 'destination-lease');
    incoming.nativeSession!.handoffFrom = {
      runId: source.id,
      contextId: retained.id,
      leaseId: 'source-lease',
    };
    updateRun(source.id, { status: 'monitoring', agentContexts: [retained] });
    updateRun(destination.id, { status: 'cancelled', agentContexts: [incoming] });
    await rewriteStatusFile((current) => ({
      ...current,
      slots: [
        ...(current?.slots ?? []).filter((row) => row.slot !== vars.slotId),
        { slot: vars.slotId, current_run_id: destination.id },
      ],
    }));
    await assert.rejects(cancelNativeRunWorkers(destination.id), /stop is unconfirmed/);
    available = true;
    const replay = withRunTransition(destination.id, () =>
      restartNativeWorkerContexts(destination.id, () => {}, { machineTransitionHeld: true }),
    );
    const queued = withMachineRunTransition(vars.machine, async () => 'machine-free');
    await replay;
    assert.equal(await queued, 'machine-free');
    assert.equal(getRun(source.id)?.status, 'cancelled');
    assert.equal(getRun(destination.id)?.agentContexts?.[0]?.nativeSession, undefined);
  },
);
