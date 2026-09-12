import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

const { WebSocket } = createRequire(path.join(ROOT, 'services/gateway/package.json'))('ws');
export const SCENARIO_ID = 'native-node-broker-smoke';
export const RUNNER_AGNOSTIC = true;

async function connect(token, kind, onRequest, url = process.env.FARMSLOT_GATEWAY) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let fault;
  const fail = (error) => {
    fault = error;
    for (const entry of pending.values()) entry.reject(error);
  };
  ws.on('error', fail);
  ws.on('close', () => fail(new Error('Validation connection closed')));
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'res') pending.get(frame.id)?.resolve(frame);
    else if (frame.type === 'req') {
      if (onRequest && frame.method === 'native.session') onRequest(frame, ws);
      else
        ws.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload:
              frame.method === 'native.session' && frame.params?.method === 'native.session.list'
                ? { sessions: [] }
                : {},
          }),
        );
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const request = async (method, params) => {
    if (fault) throw fault;
    const id = randomUUID();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Validation ${method} timed out`)), 10000);
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  try {
    const auth = await request('auth.connect', { clientKind: kind, token });
    if (!auth.ok) throw new Error('Validation credential did not authenticate');
    return { ws, request, principalId: auth.payload.principal.id };
  } catch (error) {
    ws.close();
    throw error;
  }
}

/** Controlled node replies exercise the real broker trust boundary, not runner execution. */
export async function runScenario({ outDir }) {
  const report = { runner: 'codex', checks: [], pass: false, inferenceExpected: false };
  const clients = [];
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    const token = process.env.FARMSLOT_NATIVE_BROKER_NODE_TOKEN;
    assert.ok(token, 'Supply a separately issued node credential for native-broker-validation');
    const owner = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    clients.push(owner);
    let payload;
    let failure;
    let intercept;
    const node = await connect(token, 'node', (frame, ws) => {
      // Open clients refresh aggregate inventory on node events; those reads are not the probe.
      if (frame.params?.method === 'native.session.list')
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { sessions: [] } }));
      else if (intercept) intercept(frame);
      else
        ws.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: !failure,
            payload,
            ...(failure ? { error: { code: failure, message: 'Validation rejection' } } : {}),
          }),
        );
    });
    clients.push(node);
    const otherNode = await connect(token, 'node');
    clients.push(otherNode);
    const machine = 'native-broker-validation';
    const declaration = { ownerPrincipalId: owner.principalId, supportsEnsure: true };
    const register = (client, name) =>
      client.request('node.connect', {
        machine: name,
        pid: process.pid,
        nativeSessions: declaration,
      });
    const mismatch = await register(node, 'wrong-native-broker-machine');
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, 'AUTH_FORBIDDEN');
    const spoof = await register(owner, machine);
    assert.equal(spoof.ok, false);
    assert.equal(spoof.error.code, 'AUTH_FORBIDDEN');
    assert.equal((await register(node, machine)).ok, true);
    const publicNodes = await owner.request('nodes.list', {});
    assert.equal(publicNodes.ok, true);
    assert.ok(publicNodes.payload.nodes.some((item) => item.machine === machine));
    assert.ok(
      publicNodes.payload.nodes.every((item) => !('nativeSessions' in item)),
      'Public node inventory exposed native ownership',
    );
    report.checks.push({
      name: 'native-declarations-require-exact-machine-node-credential',
      pass: true,
    });
    const session = {
      id: randomUUID(),
      ownerPrincipalId: owner.principalId,
      executionNodeId: machine,
    };
    for (const method of ['create', 'ensure', 'read', 'close']) {
      for (const invalid of [
        { sessions: [] },
        { sessions: [session] },
        { session: { ...session, id: '' } },
        { session: { ...session, ownerPrincipalId: 'another-owner' } },
        { session: { ...session, executionNodeId: 'local' } },
        ...(method === 'create' ? [] : [{ session: { ...session, id: 'another-session' } }]),
      ]) {
        payload = invalid;
        const result = await owner.request(`native.session.${method}`, {
          executionNodeId: machine,
          sessionId: session.id,
          runner: 'codex',
          cwd: '/unused-broker-fixture',
        });
        assert.equal(result.ok, false, `${method} accepted malformed or mismatched node identity`);
        assert.equal(result.error.code, 'NATIVE_SESSION_ERROR');
      }
      payload = { session };
      const valid = await owner.request(`native.session.${method}`, {
        executionNodeId: machine,
        sessionId: session.id,
        runner: 'codex',
        cwd: '/unused-broker-fixture',
      });
      assert.equal(valid.ok, true, `${method} rejected an owned matching session identity`);
    }
    report.checks.push({
      name: 'single-session-replies-including-ensure-reject-foreign-identities-and-accept-matching-ids',
      pass: true,
    });
    for (const code of ['INVALID_PARAMS', 'AUTH_FORBIDDEN', 'NATIVE_SESSION_ERROR']) {
      failure = code;
      const result = await owner.request('native.session.read', {
        executionNodeId: machine,
        sessionId: session.id,
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code, 'Node error code changed at the gateway');
    }
    failure = undefined;
    report.checks.push({
      name: 'public-node-projection-and-native-error-codes-preserved',
      pass: true,
    });
    payload = { session, events: [], commands: [], pendingRequests: [], cursor: 0, hasMore: false };
    let intercepted;
    const arrived = new Promise((resolve) => {
      intercept = (frame) => {
        intercepted = frame;
        resolve();
      };
    });
    let settled = false;
    const response = owner
      .request('native.session.read', { executionNodeId: machine, sessionId: session.id })
      .then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return { ok: false, error: { message: error.message } };
        },
      );
    await Promise.race([
      arrived,
      response.then(() => {
        throw new Error('Request ended before reaching its node');
      }),
    ]);
    otherNode.ws.send(JSON.stringify({ type: 'res', id: intercepted.id, ok: true, payload }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, 'A different socket answered the native request');
    const replacement = await register(otherNode, machine);
    assert.equal(replacement.ok, true, JSON.stringify(replacement.error));
    otherNode.ws.send(JSON.stringify({ type: 'res', id: intercepted.id, ok: true, payload }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false, 'A replacement connection answered an in-flight native request');
    node.ws.send(JSON.stringify({ type: 'res', id: intercepted.id, ok: true, payload }));
    const completed = await response;
    assert.equal(completed.ok, true, JSON.stringify(completed.error));
    report.checks.push({
      name: 'only-original-node-connection-can-answer-native-request',
      pass: true,
    });
    if (process.env.FARMSLOT_NATIVE_SOLO_GATEWAY) {
      assert.equal(process.env.FARMSLOT_NATIVE_SOLO_GATEWAY, 'ws://127.0.0.1:18781');
      const solo = await connect(
        undefined,
        'ui',
        undefined,
        process.env.FARMSLOT_NATIVE_SOLO_GATEWAY,
      );
      clients.push(solo);
      const inventory = await solo.request('nodes.list', {});
      assert.equal(inventory.ok, true);
      assert.ok(inventory.payload.nodes.some((item) => item.machine === 'native-solo-validation'));
      assert.ok(inventory.payload.nodes.every((item) => !('nativeSessions' in item)));
      const file = await solo.request('fs.read', {
        slotId: 'native-solo-validation',
        path: 'proof.txt',
      });
      assert.equal(file.ok, true);
      assert.equal(file.payload.content, 'legacy-node-file-proof\n');
      const native = await solo.request('native.session.list', {
        executionNodeId: 'native-solo-validation',
      });
      assert.equal(native.ok, false);
      assert.equal(
        native.error.code,
        'NATIVE_SESSION_ERROR',
        'Solo caller must reach the native routing gate, not fail generic authentication',
      );
      report.checks.push({
        name: 'solo-native-opt-in-retains-real-node-filesystem-without-native-authority',
        pass: true,
      });
    }
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    for (const client of clients) client.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, outPath, pass: report.pass, report };
}
