import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';

export const SCENARIO_ID = 'native-node-owner-assignment';
export const RUNNER_AGNOSTIC = true;

/** Real enrollment and node sockets; this proves authorization, not native inference. */
export async function runScenario({ outDir, explicit }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'codex', pass: true, skipped: true };
  const report = { runner: 'codex', checks: [], pass: false, inferenceExpected: false };
  const clients = [];
  const credentials = [];
  let admin;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    admin = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    clients.push(admin);
    const ok = async (method, params, timeoutMs) => {
      const result = await admin.request(method, params, timeoutMs);
      assert.equal(result.ok, true, result.error?.message);
      return result.payload;
    };
    const id = randomUUID();
    const machine = `native-owner-proof-${id}`;
    const subject = { type: 'node', displayName: machine, machine };
    const nodePrincipal = (await ok('principal.create', { subject, roles: [] })).principal;
    const issue = await ok('credential.issue', {
      principalId: nodePrincipal.id,
      displayName: 'Native owner proof',
    });
    credentials.push(issue.credential.id);
    const node = await connect(issue.secret, 'node');
    clients.push(node);
    const hello = (client, ownerPrincipalId, include = true) =>
      client.request('node.connect', {
        machine,
        pid: process.pid,
        ...(include ? { nativeSessions: { ownerPrincipalId, supportsEnsure: true } } : {}),
      });
    const unbound = await hello(node, admin.principalId);
    assert.equal(unbound.ok, false, 'Unbound node declaration was accepted');
    assert.equal(unbound.error.code, 'AUTH_FORBIDDEN');
    await ok('principal.bindNativeOwner', {
      nodePrincipalId: nodePrincipal.id,
      ownerPrincipalId: admin.principalId,
    });
    await ok('principal.bindNativeOwner', {
      nodePrincipalId: nodePrincipal.id,
      ownerPrincipalId: admin.principalId,
    });
    const other = (
      await ok('principal.create', {
        subject: { type: 'person', displayName: `other-${id}` },
        roles: [],
      })
    ).principal;
    const viewerIssue = await ok('credential.issue', {
      principalId: other.id,
      displayName: 'Unprivileged binding proof',
    });
    credentials.push(viewerIssue.credential.id);
    const viewer = await connect(viewerIssue.secret, 'ui');
    clients.push(viewer);
    const unauthorized = await viewer.request('principal.bindNativeOwner', {
      nodePrincipalId: nodePrincipal.id,
      ownerPrincipalId: admin.principalId,
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, 'AUTH_FORBIDDEN');
    const reassign = await admin.request('principal.bindNativeOwner', {
      nodePrincipalId: nodePrincipal.id,
      ownerPrincipalId: other.id,
    });
    assert.equal(reassign.ok, false);
    assert.match(reassign.error.message, /immutable/);
    const spoof = await hello(node, other.id);
    assert.equal(spoof.ok, false, 'Spoofed native owner was accepted');
    assert.equal(spoof.error.code, 'AUTH_FORBIDDEN');
    assert.equal((await hello(node, admin.principalId)).ok, true);
    assert.deepEqual(await ok('native.session.list', { executionNodeId: machine }), {
      sessions: [],
    });
    report.checks.push(
      'unbound and spoofed owners fail; authenticated admin assignment persists and cannot be reassigned',
    );

    const otherNodePrincipal = (
      await ok('principal.create', {
        subject: { ...subject, displayName: `competing-${id}` },
        roles: [],
      })
    ).principal;
    const competingIssue = await ok('credential.issue', {
      principalId: otherNodePrincipal.id,
      displayName: 'Competing node proof',
    });
    credentials.push(competingIssue.credential.id);
    const competing = await connect(competingIssue.secret, 'node');
    clients.push(competing);
    const takeover = await hello(competing, undefined, false);
    assert.equal(takeover.ok, false, 'Competing node replaced the assigned machine');
    assert.equal(takeover.error.code, 'AUTH_FORBIDDEN');
    assert.deepEqual(await ok('native.session.list', { executionNodeId: machine }), {
      sessions: [],
    });
    const publicNodes = await ok('nodes.list', {});
    const entry = publicNodes.nodes.find((item) => item.machine === machine);
    assert.ok(entry);
    assert.equal('nativeAuthority' in entry, false);
    assert.equal('nativeSessions' in entry, false);
    report.checks.push(
      'a competing issued node cannot replace an assigned machine even when it omits native capabilities',
    );

    await ok('credential.revoke', { credentialId: issue.credential.id });
    const revoked = await admin.request('native.session.list', { executionNodeId: machine });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error.code, 'NATIVE_SESSION_ERROR');
    report.checks.push(
      'credential revocation prevents further native routing and private authority is absent from node inventory',
    );
    const principals = (await ok('principal.list', {})).principals;
    const assigned = new Set(
      principals
        .filter(
          (principal) =>
            principal.subject.type === 'node' &&
            principal.subject.nativeOwnerPrincipalId === admin.principalId,
        )
        .map((principal) => principal.subject.machine),
    );
    if (process.env.FARMSLOT_NATIVE_REQUIRE_UNASSIGNED_CACHE === '1') {
      const stateRoot = process.env.FARMSLOT_NATIVE_STATE_DIR;
      assert.ok(
        stateRoot &&
          path.resolve(stateRoot).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
      );
      const directory = path.join(stateRoot, 'execution-nodes');
      const unassigned = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
        .filter(
          (entry) => entry.ownerPrincipalId === admin.principalId && !assigned.has(entry.machine),
        );
      assert.ok(
        unassigned.length,
        'Migration proof requires a remembered unassigned node from the earlier negative enrollment',
      );
      report.unassignedCacheFixtures = unassigned.map((entry) => entry.machine);
    }
    const inventory = await ok('native.session.list', {}, 90000);
    assert.ok(
      (inventory.unavailableExecutionNodes ?? []).every(
        (node) => node.executionNodeId === 'local' || assigned.has(node.executionNodeId),
      ),
      'Unassigned remembered node leaked into inventory',
    );
    assert.ok(
      inventory.sessions.every(
        (session) => session.executionNodeId === 'local' || assigned.has(session.executionNodeId),
      ),
      'Unassigned session leaked into inventory',
    );
    report.checks.push(
      'aggregate native inventory filters remembered nodes through current issued owner assignments',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (admin)
      for (const credentialId of credentials) {
        try {
          const revoked = await admin.request('credential.revoke', { credentialId });
          assert.equal(revoked.ok, true, revoked.error?.message);
        } catch (error) {
          report.pass = false;
          report.cleanupError = error.message;
        }
      }
    for (const client of clients) client.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
