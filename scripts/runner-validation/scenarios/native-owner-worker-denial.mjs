import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Methods } from '@farmslot/protocol';

import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';

export const SCENARIO_ID = 'native-owner-worker-denial';
export const RUNNER_AGNOSTIC = true;

/** Use a real stopped worker; a separate administrator always restores the owner's role. */
export async function runScenario({ explicit, outDir }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'native', pass: true, skipped: true };
  if (process.env.FARMSLOT_NATIVE_DENIAL_UNCLAIMED_RUN_ID) return unclaimedSlotScenario(outDir);
  const report = { runner: 'native', checks: [], pass: false, inferenceExpected: false };
  const clients = [];
  let admin;
  let owner;
  let roleChanged = false;
  let originalRoles;
  let pin;
  let before;
  const ok = async (client, method, params = {}) => {
    const response = await client.request(method, params, 30000);
    assert.equal(response.ok, true, `${method}: ${response.error?.message}`);
    return response.payload;
  };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(process.env.FARMSLOT_NATIVE_DENIAL_RUN_ID);
    assert.ok(process.env.FARMSLOT_NATIVE_DENIAL_ADMIN_TOKEN);
    owner = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    clients.push(owner);
    admin = await connect(process.env.FARMSLOT_NATIVE_DENIAL_ADMIN_TOKEN, 'ui');
    clients.push(admin);
    assert.notEqual(admin.principalId, owner.principalId);
    const { principals } = await ok(admin, Methods.PRINCIPAL_LIST);
    const administrator = principals.find((item) => item.id === admin.principalId);
    assert.ok(
      administrator?.roles.some((item) => item.role === 'admin' && item.scope.kind === 'global'),
    );
    originalRoles = principals.find((item) => item.id === owner.principalId)?.roles;
    assert.deepEqual(originalRoles, [{ role: 'admin', scope: { kind: 'global' } }]);
    const { run } = await ok(owner, Methods.RUN_GET, {
      runId: process.env.FARMSLOT_NATIVE_DENIAL_RUN_ID,
    });
    assert.ok(
      ['done', 'cancelled', 'failed'].includes(run.status),
      'Use a completed validation run',
    );
    assert.equal(run.nativeOwnerPrincipalId, owner.principalId);
    const context = run.agentContexts.find(
      (item) => item.id === (process.env.FARMSLOT_NATIVE_DENIAL_CONTEXT_ID ?? 'dev'),
    );
    const binding = context?.nativeSession;
    assert.ok(binding?.generation && !binding.releasedAt);
    pin = {
      executionNodeId: binding.executionNodeId,
      sessionId: binding.sessionId,
      worker: {
        runId: run.id,
        contextId: context.id,
        generation: binding.generation,
        leaseId: binding.leaseId,
      },
    };
    before = await ok(owner, Methods.NATIVE_SESSION_READ, pin);
    assert.equal(before.session.workerManaged, true);
    assert.equal(before.session.processStopped, true);
    assert.ok(
      before.commands.some((item) => item.accepted),
      'Worker must have executed an actual task',
    );
    report.runId = run.id;
    report.sessionId = binding.sessionId;
    report.runner = before.session.runner;
    report.checks.push(
      'Actual stopped worker history accessible with its administrator and pinned context',
    );

    // Mark before the call so a lost applied reply still triggers restoration.
    roleChanged = true;
    await ok(admin, Methods.PRINCIPAL_REVOKE_ROLE, {
      principalId: owner.principalId,
      role: 'admin',
      scope: { kind: 'global' },
    });
    const native = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'companion');
    clients.push(native);
    assert.equal(native.principalId, owner.principalId);
    const catalog = await ok(native, Methods.NATIVE_SESSION_CATALOG);
    assert.ok(catalog.runners.length && catalog.runners.every((item) => !item.supportsWorkers));
    const target = { executionNodeId: pin.executionNodeId, sessionId: pin.sessionId };
    for (const method of [
      Methods.NATIVE_SESSION_READ,
      Methods.NATIVE_SESSION_SEND,
      Methods.NATIVE_SESSION_RESPOND,
      Methods.NATIVE_SESSION_INTERRUPT,
      Methods.NATIVE_SESSION_CLOSE,
      Methods.NATIVE_SESSION_WORKSPACE_READ,
    ]) {
      const response = await native.request(method, {
        ...target,
        commandId: randomUUID(),
        text: 'Forbidden worker input.',
        requestId: 'forbidden',
        decision: 'deny',
        path: 'fixture.txt',
      });
      assert.equal(
        response.ok,
        false,
        `${method} allowed a native-only owner to reach its worker without a selector`,
      );
      assert.equal(
        response.error?.code,
        'AUTH_FORBIDDEN',
        `${method} did not refuse at the worker access boundary`,
      );
      assert.equal(
        response.error?.message,
        'Native workspace enrollment does not grant worker access',
      );
      report.checks.push(`${method}: known worker ID without selector refused`);
    }
    for (const params of [{}, { executionNodeId: target.executionNodeId }]) {
      const inventory = await ok(native, Methods.NATIVE_SESSION_LIST, params);
      assert.ok(
        inventory.sessions.every((item) => !item.workerManaged && item.id !== target.sessionId),
      );
    }
    report.checks.push('Native-only aggregate and node inventories hide actual worker sessions');
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    try {
      if (roleChanged) {
        await ok(admin, Methods.PRINCIPAL_GRANT, {
          principalId: owner.principalId,
          role: 'admin',
          scope: { kind: 'global' },
        });
        const { principals } = await ok(admin, Methods.PRINCIPAL_LIST);
        assert.deepEqual(
          principals.find((item) => item.id === owner.principalId)?.roles,
          originalRoles,
        );
        const restored = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
        clients.push(restored);
        const after = await ok(restored, Methods.NATIVE_SESSION_READ, pin);
        assert.equal(after.session.processStopped, true);
        assert.equal(after.session.generation, before.session.generation);
        assert.equal(after.cursor, before.cursor);
        assert.deepEqual(after.commands, before.commands);
        assert.deepEqual(after.pendingRequests, before.pendingRequests);
        report.checks.push(
          'Administrator role restored; worker process, commands and event cursor unchanged',
        );
      }
    } catch (error) {
      report.pass = false;
      report.cleanupError = error.message;
    }
    for (const client of clients) client.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}

/** The caller supplies a real run paused before FIND_SLOT claims its requested slot. */
async function unclaimedSlotScenario(outDir) {
  const report = { runner: 'native', checks: [], pass: false, inferenceExpected: false };
  const clients = [];
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const owner = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    clients.push(owner);
    const admin = await connect(process.env.FARMSLOT_NATIVE_DENIAL_ADMIN_TOKEN, 'ui');
    clients.push(admin);
    assert.notEqual(owner.principalId, admin.principalId);
    const runId = process.env.FARMSLOT_NATIVE_DENIAL_UNCLAIMED_RUN_ID;
    const readRun = async () => {
      const response = await owner.request(Methods.RUN_GET, { runId });
      assert.equal(response.ok, true, response.error?.message);
      return response.payload.run;
    };
    const before = await readRun();
    assert.equal(before.transport, 'native');
    assert.equal(before.nativeOwnerPrincipalId, owner.principalId);
    assert.ok(['created', 'slot-finding'].includes(before.status));
    assert.ok(before.slotId);
    assert.ok(!before.agentContexts?.some((context) => context.nativeSession));
    const fleet = await admin.request(Methods.FLEET_STATUS, {});
    assert.equal(fleet.ok, true, fleet.error?.message);
    const slot = fleet.payload.fleet.slots.find((item) => item.slot === before.slotId);
    assert.ok(slot);
    assert.notEqual(slot.currentRunId, runId);
    // The mismatched expected owner makes release a read-only no-op after authorization.
    const released = await admin.request(Methods.SLOT_RELEASE, {
      slotId: before.slotId,
      expectedRunId: randomUUID(),
    });
    assert.equal(released.ok, true, released.error?.message);
    assert.equal(released.payload.released, false);
    const after = await readRun();
    assert.equal(after.status, before.status);
    assert.equal(after.slotId, before.slotId);
    assert.deepEqual(after.agentContexts, before.agentContexts);
    const denied = await admin.request(Methods.RUN_GET, { runId });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'AUTH_FORBIDDEN');
    report.runId = runId;
    report.checks.push(
      'A requested but unclaimed native slot permits another admin slot access; the native run itself remains owner-only and unchanged',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    for (const client of clients) client.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
