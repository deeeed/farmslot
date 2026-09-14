import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';

export const SCENARIO_ID = 'native-auth-session';
export const RUNNER_AGNOSTIC = true;

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
    const ok = async (method, params) => {
      const result = await admin.request(method, params);
      assert.equal(result.ok, true, result.error?.message);
      return result.payload;
    };
    const issue = async (principalId) => {
      const issued = await ok('credential.issue', {
        principalId,
        displayName: 'Private socket identity proof',
      });
      credentials.push(issued.credential.id);
      return issued.secret;
    };
    const id = randomUUID();
    const other = (
      await ok('principal.create', {
        subject: { type: 'person', displayName: `socket-other-${id}` },
        roles: [],
      })
    ).principal;
    const ownerToken = await issue(admin.principalId);
    const otherToken = await issue(other.id);
    const caller = await connect(ownerToken, 'ui');
    clients.push(caller);
    const same = await caller.request('auth.connect', { clientKind: 'ui', token: ownerToken });
    assert.equal(same.ok, true);
    const userSwitch = await caller.request('auth.connect', {
      clientKind: 'ui',
      token: otherToken,
    });
    report.userSwitchAccepted = userSwitch.ok;

    const machine = `native-socket-proof-${id}`;
    const nodePrincipal = (
      await ok('principal.create', {
        subject: {
          type: 'node',
          displayName: machine,
          machine,
          nativeOwnerPrincipalId: admin.principalId,
        },
        roles: [],
      })
    ).principal;
    const otherNodePrincipal = (
      await ok('principal.create', {
        subject: { type: 'node', displayName: `other-node-${id}`, machine: `other-node-${id}` },
        roles: [],
      })
    ).principal;
    const nodeToken = await issue(nodePrincipal.id);
    const otherNodeToken = await issue(otherNodePrincipal.id);
    const node = await connect(nodeToken, 'node');
    clients.push(node);
    assert.equal(
      (
        await node.request('node.connect', {
          machine,
          pid: process.pid,
          nativeSessions: { ownerPrincipalId: admin.principalId },
        })
      ).ok,
      true,
    );
    const nodeSwitch = await node.request('auth.connect', {
      clientKind: 'node',
      token: otherNodeToken,
    });
    report.nodeSwitchAccepted = nodeSwitch.ok;
    assert.equal(userSwitch.ok, false, 'An authenticated socket changed its person identity');
    assert.equal(nodeSwitch.ok, false, 'A registered node socket changed its issued identity');
    assert.equal(userSwitch.error.code, 'AUTH_RECONNECT_REQUIRED');
    assert.equal(nodeSwitch.error.code, 'AUTH_RECONNECT_REQUIRED');
    assert.equal(
      (await caller.request('principal.list', {})).ok,
      true,
      'Rejected authentication changed the original caller authority',
    );
    assert.deepEqual(await ok('native.session.list', { executionNodeId: machine }), {
      sessions: [],
    });
    const kindSwitch = await caller.request('auth.connect', {
      clientKind: 'companion',
      token: ownerToken,
    });
    assert.equal(kindSwitch.ok, false);
    assert.equal(kindSwitch.error.code, 'AUTH_RECONNECT_REQUIRED');
    const fresh = await connect(otherToken, 'ui');
    clients.push(fresh);
    assert.equal(fresh.principalId, other.id);
    assert.equal((await fresh.request('principal.list', {})).ok, false);
    report.checks.push(
      'duplicate authentication is safe; person, node and client-kind changes require a fresh connection without changing original authority',
    );
    report.checks.push(
      'the other identity can authenticate independently without gaining farm administration',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (admin)
      for (const credentialId of credentials) {
        try {
          assert.equal((await admin.request('credential.revoke', { credentialId })).ok, true);
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
