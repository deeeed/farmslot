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
  const revokeRole = process.env.FARMSLOT_NATIVE_AUTH_REVOKE_ROLE === '1';
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
    const ownerId = revokeRole
      ? (
          await ok('principal.create', {
            subject: { type: 'person', displayName: 'Private native role-reduction proof' },
            roles: [{ role: 'admin', scope: { kind: 'global' } }],
          })
        ).principal.id
      : admin.principalId;
    const machine = `native-revocation-${randomUUID()}`;
    const principal = (
      await ok('principal.create', {
        subject: {
          type: 'node',
          machine,
          displayName: machine,
          nativeOwnerPrincipalId: ownerId,
        },
        roles: [],
      })
    ).principal;
    const nodeCredential = await issue(principal.id);
    const heldRequests = [];
    let hold = false;
    const sessionId = randomUUID();
    const inventory = {
      sessions: [
        { id: sessionId, ownerPrincipalId: ownerId, executionNodeId: machine, workerManaged: true },
      ],
    };
    const node = await connect(nodeCredential.secret, 'node', (frame, ws) => {
      if (hold) heldRequests.push({ frame, ws });
      else ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: inventory }));
    });
    clients.push(node);
    assert.equal(
      (
        await node.request('node.connect', {
          machine,
          pid: process.pid,
          nativeSessions: { ownerPrincipalId: ownerId },
        })
      ).ok,
      true,
    );
    const issued = await issue(ownerId);
    const caller = await connect(
      issued.secret,
      'ui',
      undefined,
      process.env.FARMSLOT_GATEWAY,
      clientName,
    );
    clients.push(caller);
    if (revokeRole) {
      for (const params of [{ executionNodeId: machine }, {}]) {
        const baseline = await caller.request('native.session.list', params);
        assert.equal(baseline.ok, true, baseline.error?.message);
        assert.ok(
          baseline.payload.sessions.some(
            (session) => session.id === sessionId && session.workerManaged,
          ),
        );
      }
    }
    hold = true;
    const requests = [
      ['native.session.read', { executionNodeId: machine, sessionId }],
      ...(revokeRole
        ? [
            ['native.session.read', { executionNodeId: machine, sessionId: 'private-error' }],
            ['native.session.list', { executionNodeId: machine }],
            ['native.session.list', {}],
          ]
        : []),
    ];
    const pending = requests.map(([method, params]) =>
      caller.request(method, params).then(
        (response) => ({ response }),
        (error) => ({ error: error.message }),
      ),
    );
    await wait(
      () => heldRequests.length,
      (count) => count === requests.length,
      10000,
    );
    if (revokeRole)
      await ok('principal.revokeRole', {
        principalId: ownerId,
        role: 'admin',
        scope: { kind: 'global' },
      });
    else await ok('credential.revoke', { credentialId: issued.credential.id });
    await wait(() => fs.existsSync(`${fault}.held`), Boolean, 10000);
    if (revokeRole) {
      const retained = await caller.request('native.session.catalog', {});
      assert.equal(retained.ok, true, retained.error?.message);
      assert.ok(retained.payload.runners.every((runner) => !runner.supportsWorkers));
    }
    const marker = `private-response-${randomUUID()}`;
    for (const heldRequest of heldRequests) {
      const privateError = heldRequest.frame.params.params.sessionId === 'private-error';
      heldRequest.ws.send(
        JSON.stringify({
          type: 'res',
          id: heldRequest.frame.id,
          ok: !privateError,
          ...(privateError
            ? { error: { code: 'NATIVE_SESSION_ERROR', message: marker } }
            : {
                payload:
                  heldRequest.frame.params.method === 'native.session.list'
                    ? inventory
                    : {
                        session: {
                          id: sessionId,
                          ownerPrincipalId: ownerId,
                          executionNodeId: machine,
                        },
                        privateMarker: marker,
                      },
              }),
        }),
      );
    }
    for (const result of await Promise.all(pending)) {
      assert.equal(
        result.error,
        undefined,
        'A closed/failed transport does not prove the native response fence',
      );
      report.responseAccepted = result.response.ok;
      assert.equal(
        result.response.ok,
        false,
        'A revoked client received a delayed native response',
      );
      assert.equal(result.response.error.code, 'AUTH_FORBIDDEN');
      assert.ok(
        !JSON.stringify(result.response).includes(marker),
        'Private native payload crossed revocation',
      );
    }
    report.checks.push(
      revokeRole
        ? 'Admin role reduction retains native enrollment but blocks delayed session replies, private errors, and direct/aggregate worker inventories before socket close'
        : 'an applied credential revocation with its socket close delayed still blocks private native response delivery',
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
