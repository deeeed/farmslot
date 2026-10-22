import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { Methods, type Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

let run: Run | undefined;
const home = await mkdtemp(path.join(tmpdir(), 'native-supervision-'));
const keys = ['FARMSLOT_HOME', 'FARMSLOT_RUNS_DIR', 'FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID'] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
process.env.FARMSLOT_HOME = home;
process.env.FARMSLOT_RUNS_DIR = path.join(home, 'runs');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'automation';
after(async () => {
  try {
    if (run) {
      const completedAt = new Date().toISOString();
      updateRun(run.id, {
        status: 'done',
        completedAt,
        reviewWorkspace: run.reviewWorkspace
          ? { ...run.reviewWorkspace, cleanedAt: completedAt }
          : undefined,
        agentContexts: run.agentContexts?.map((context) => ({
          ...context,
          nativeSession: context.nativeSession
            ? { ...context.nativeSession, closedAt: completedAt }
            : undefined,
        })),
      });
      await persistRunNow(run);
      await deleteRun(run.id);
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(home, { recursive: true, force: true });
  }
});
const { CredentialStoreRuntime, CredentialStoreWriter } =
  await import('@farmslot/credential-store');
const writer = new CredentialStoreWriter(new CredentialStoreRuntime({ FARMSLOT_HOME: home }), true);
const admin = [{ role: 'admin', scope: { kind: 'global' } }] as const;
const owner = writer.createPrincipal({ type: 'service', displayName: 'automation' }, [...admin]);
writer.issueCredential(owner.id, 'fixture');
writer.createPrincipal({ type: 'service', displayName: 'reused-person' }, []);
writer.retirePrincipals(['reused-person']);
const person = writer.createPrincipal(
  { type: 'person', displayName: 'Person' },
  [...admin],
  'reused-person',
  { reuseRetiredId: true },
);
assert.equal(person.generation, 1);
const node = await import('../runners/native/node.js');
const calls: Array<{ owner: string; method: string }> = [];
mock.module('../runners/native/node.js', {
  namedExports: {
    ...node,
    routeNativeExecution: async (
      ownerId: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ owner: ownerId, method });
      return {
        session: {
          id: params.sessionId,
          ownerPrincipalId: ownerId,
          executionNodeId: params.executionNodeId,
          workerLeaseId: params.leaseId,
        },
        scope: { leaseId: params.leaseId },
      };
    },
  },
});
const { nativeSessionRoute } = await import('./native-session.js');
const { runWithSessionOriginator } = await import('../security/work-originator.js');
const { createRun, deleteRun, updateRun, persistRunNow } = await import('../runs/store.js');

test('a replacement admin supervises the pinned generation-zero worker without owning native execution', async () => {
  run = runWithSessionOriginator(owner, () =>
    createRun({
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: 'REVIEW-1',
      transport: 'native',
      reviewWorkspaceTarget: { machine: 'fixture-node' },
    }),
  );
  const binding = {
    sessionId: randomUUID(),
    leaseId: randomUUID(),
    generation: randomUUID(),
    commandId: randomUUID(),
    ownerPrincipalId: owner.id,
    executionNodeId: 'local',
  };
  const worker = {
    runId: run.id,
    contextId: 'review',
    leaseId: binding.leaseId,
    generation: binding.generation,
  };
  const context = {
    id: 'review',
    role: 'review' as const,
    label: 'Review',
    status: 'idle' as const,
    slotId: 'fixture',
    runId: run.id,
    nativeSession: binding,
  };
  for (const executionNodeId of ['local', 'macpro', 'mini']) {
    updateRun(run.id, {
      status: 'monitoring',
      reviewWorkspace: {
        workspaceId: 'fixture',
        machine: 'fixture-node',
        executionNodeId,
        checkoutPath: path.join(home, 'source'),
        taskPath: path.join(home, 'task'),
        artifactPath: path.join(home, 'task', 'artifacts'),
      },
      agentContexts: [{ ...context, nativeSession: { ...binding, executionNodeId } }],
    });
    const params = { sessionId: binding.sessionId, executionNodeId, worker };
    await runWithSessionOriginator(person, () =>
      nativeSessionRoute(Methods.NATIVE_SESSION_READ, params, person),
    );
    assert.equal(calls.at(-1)?.owner, owner.id);
    await runWithSessionOriginator(person, () =>
      nativeSessionRoute(Methods.NATIVE_SESSION_INTERRUPT, params, person),
    );
    assert.equal(calls.at(-1)?.owner, owner.id);
    const count = calls.length;
    await assert.rejects(
      runWithSessionOriginator(person, () =>
        nativeSessionRoute(
          Methods.NATIVE_SESSION_READ,
          { ...params, worker: { ...worker, leaseId: 'stale' } },
          person,
        ),
      ),
      /unavailable or stale/,
    );
    assert.equal(calls.length, count);
    await assert.rejects(
      runWithSessionOriginator(person, () =>
        nativeSessionRoute(
          Methods.NATIVE_SESSION_READ,
          { sessionId: binding.sessionId, executionNodeId },
          person,
        ),
      ),
      /replacement identity/,
    );
    await assert.rejects(
      runWithSessionOriginator(person, () =>
        nativeSessionRoute(Methods.NATIVE_SESSION_LIST, params, person),
      ),
      /replacement identity/,
    );
    await assert.rejects(
      runWithSessionOriginator(person, () =>
        nativeSessionRoute(Methods.NATIVE_SESSION_READ, params, { ...person, roles: [] }),
      ),
      /does not grant worker controls/,
    );
    await assert.rejects(
      runWithSessionOriginator(owner, () =>
        nativeSessionRoute(Methods.NATIVE_SESSION_READ, params, person),
      ),
      /authority does not match/,
    );
    assert.equal(calls.length, count);
  }
  assert.equal(run.nativeOwnerPrincipalId, owner.id);
  assert.equal(calls.length, 6);
});
