import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';
import { wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-auth-revocation';
export const RUNNER_AGNOSTIC = true;

export async function runScenario({ outDir, explicit }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'codex', pass: true, skipped: true };
  const report = { runner: 'codex', checks: [], pass: false, inferenceExpected: false };
  const clients = [];
  const credentials = [];
  let admin;
  const fault = process.env.FARMSLOT_NATIVE_AUTH_CLOSE_FAULT;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.ok(
      fault && path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
    );
    assert.equal(fs.existsSync(fault), false);
    const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(pids.length, 1);
    assert.ok(fs.existsSync(`${fault}.${pids[0]}.loaded`));
    const clientName = `native-revoked-response-${randomUUID()}`;
    fs.writeFileSync(fault, JSON.stringify({ gatewayPid: pids[0], clientName }), { mode: 0o600 });
    admin = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    clients.push(admin);
    const ok = async (method, params) => {
      const response = await admin.request(method, params);
      assert.equal(response.ok, true, response.error?.message);
      return response.payload;
    };
    const issue = async (principalId) => {
      const issued = await ok('credential.issue', {
        principalId,
        displayName: 'Private revocation proof',
      });
      credentials.push(issued.credential.id);
      return issued;
    };
    const machine = `native-revocation-${randomUUID()}`;
    const principal = (
      await ok('principal.create', {
        subject: {
          type: 'node',
          machine,
          displayName: machine,
          nativeOwnerPrincipalId: admin.principalId,
        },
        roles: [],
      })
    ).principal;
    const nodeCredential = await issue(principal.id);
    let heldRequest;
    const node = await connect(nodeCredential.secret, 'node', (frame, ws) => {
      if (frame.params?.method === 'native.session.read') heldRequest = { frame, ws };
      else
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { sessions: [] } }));
    });
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
    const issued = await issue(admin.principalId);
    const caller = await connect(
      issued.secret,
      'ui',
      undefined,
      process.env.FARMSLOT_GATEWAY,
      clientName,
    );
    clients.push(caller);
    const sessionId = randomUUID();
    const pending = caller
      .request('native.session.read', { executionNodeId: machine, sessionId })
      .then(
        (response) => ({ response }),
        (error) => ({ error: error.message }),
      );
    await wait(() => heldRequest, Boolean, 10000);
    await ok('credential.revoke', { credentialId: issued.credential.id });
    await wait(() => fs.existsSync(`${fault}.held`), Boolean, 10000);
    const marker = `private-response-${randomUUID()}`;
    heldRequest.ws.send(
      JSON.stringify({
        type: 'res',
        id: heldRequest.frame.id,
        ok: true,
        payload: {
          session: { id: sessionId, ownerPrincipalId: admin.principalId, executionNodeId: machine },
          privateMarker: marker,
        },
      }),
    );
    const result = await pending;
    assert.equal(
      result.error,
      undefined,
      'A closed/failed transport does not prove the native response fence',
    );
    report.responseAccepted = result.response.ok;
    assert.equal(result.response.ok, false, 'A revoked client received a delayed native response');
    assert.equal(result.response.error.code, 'AUTH_FORBIDDEN');
    assert.ok(
      !JSON.stringify(result.response).includes(marker),
      'Private native payload crossed revocation',
    );
    report.checks.push(
      'an applied credential revocation with its socket close delayed still blocks private native response delivery',
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (fault && fs.existsSync(fault)) fs.writeFileSync(`${fault}.release`, '', { mode: 0o600 });
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
