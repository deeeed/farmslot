import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';

const { WebSocket } = createRequire(path.join(ROOT, 'services/gateway/package.json'))('ws');
export const SCENARIO_ID = 'native-owner-ingress';
export const RUNNER_AGNOSTIC = true;

// Unlike connect(), this client observes events before auth resolves, so an unauthorized
// HELLO cannot slip through between the auth response and listener installation.
async function observeOwner(token, kind, url) {
  const ws = new WebSocket(url);
  const events = [];
  const pending = new Map();
  let fault;
  const fail = (error) => {
    fault = error;
    for (const entry of pending.values()) entry.reject(error);
  };
  ws.on('error', fail);
  ws.on('close', () => fail(new Error('Owner proof connection closed')));
  ws.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch (error) {
      fail(new Error('Malformed owner proof frame', { cause: error }));
      ws.close();
      return;
    }
    if (frame.type === 'event') events.push({ event: frame.event });
    if (frame.type === 'res') pending.get(frame.id)?.resolve(frame);
  });
  const request = async (method, params = {}, timeoutMs = 30_000) => {
    if (fault) throw fault;
    const id = randomUUID();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Owner proof ${method} timed out`)), timeoutMs);
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const auth = await request('auth.connect', { clientKind: kind, token });
    assert.equal(auth.ok, true, 'Owner credential failed authentication');
    assert.equal(auth.payload.principal.subjectKind, 'person');
    assert.deepEqual(auth.payload.principal.roles, [], 'Proof owner must have no global roles');
    return { ws, request, events, principalId: auth.payload.principal.id };
  } catch (error) {
    ws.close();
    throw error;
  }
}

async function ok(client, method, params, timeoutMs) {
  const response = await client.request(method, params, timeoutMs);
  assert.equal(response.ok, true, `${method} failed: ${response.error?.code ?? 'no response'}`);
  return response.payload;
}

async function refused(client, method, params, code = 'AUTH_FORBIDDEN') {
  const response = await client.request(method, params);
  assert.equal(response.ok, false, `${method} unexpectedly succeeded`);
  assert.equal(response.error?.code, code, `${method} failed for the wrong reason`);
}

async function until(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function loadFixture() {
  const file = process.env.FARMSLOT_NATIVE_INGRESS_FIXTURE;
  assert.ok(file, 'Set FARMSLOT_NATIVE_INGRESS_FIXTURE to the provisioned private node metadata');
  const resolved = path.resolve(file);
  assert.ok(resolved.startsWith(path.join(ROOT, 'temp/native-validation') + path.sep));
  const fixture = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  for (const key of [
    'gateway',
    'ownerPrincipalId',
    'nodePrincipalId',
    'executionNodeId',
    'cwd',
    'runner',
  ])
    assert.ok(typeof fixture[key] === 'string' && fixture[key], `Fixture requires ${key}`);
  assert.equal(fixture.gateway, process.env.FARMSLOT_GATEWAY);
  const url = new URL(fixture.gateway);
  assert.ok(['ws:', 'wss:'].includes(url.protocol));
  assert.ok(
    !url.username && !url.password && !url.search && !url.hash,
    'Gateway fixture URL must not contain credentials or query parameters',
  );
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.ok(url.port && url.port !== '7777', 'Use an explicitly isolated gateway port');
  assert.notEqual(fixture.executionNodeId, 'local');
  assert.ok(path.isAbsolute(fixture.cwd));
  assert.ok(['codex', 'claude', 'cursor', 'grok'].includes(fixture.runner));
  return fixture;
}

/** Real production RPCs and a provisioned remote runner; the extra node only triggers broadcasts. */
export async function runScenario({ outDir, explicit, timeoutMs = 180_000 }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'native', skipped: true, pass: true };
  const report = { runner: 'native', checks: [], pass: false, inferenceExpected: true };
  const clients = [];
  const credentials = [];
  let admin;
  let caller;
  let session;
  let fixture;
  const check = (name, details = {}) => report.checks.push({ name, pass: true, ...details });
  try {
    fixture = loadFixture();
    report.runner = fixture.runner;
    report.executionNodeId = fixture.executionNodeId;
    report.gateway = fixture.gateway;
    admin = await connect(process.env.FARMSLOT_GATEWAY_TOKEN, 'ui');
    clients.push(admin);
    const principals = (await ok(admin, 'principal.list', {})).principals;
    const owner = principals.find((entry) => entry.id === fixture.ownerPrincipalId);
    const nodePrincipal = principals.find((entry) => entry.id === fixture.nodePrincipalId);
    assert.equal(owner?.subject.type, 'person');
    assert.deepEqual(owner.roles, [], 'Provision the real execution node for a role-free owner');
    assert.equal(nodePrincipal?.subject.type, 'node');
    assert.equal(nodePrincipal.subject.machine, fixture.executionNodeId);
    assert.equal(nodePrincipal.subject.nativeOwnerPrincipalId, owner.id);
    // Exercise the actual administrative binding API without changing the deployed assignment.
    await ok(admin, 'principal.bindNativeOwner', {
      nodePrincipalId: nodePrincipal.id,
      ownerPrincipalId: owner.id,
    });
    assert.ok(
      (await ok(admin, 'nodes.list', {})).nodes.some(
        (node) => node.machine === fixture.executionNodeId,
      ),
      'The private remote execution node must already be connected',
    );
    const issue = async (principalId) => {
      const result = await ok(admin, 'credential.issue', {
        principalId,
        displayName: 'Private native ingress proof',
      });
      credentials.push(result.credential.id);
      return result.secret;
    };
    const ownerToken = await issue(owner.id);
    caller = await observeOwner(ownerToken, 'ui', fixture.gateway);
    clients.push(caller);
    const companion = await observeOwner(ownerToken, 'companion', fixture.gateway);
    clients.push(companion);
    assert.equal(caller.principalId, owner.id);
    assert.equal(companion.principalId, owner.id);
    await ok(caller, 'gateway.ping', {});
    await ok(companion, 'gateway.ping', {});
    const catalog = await ok(caller, 'native.session.catalog', {});
    assert.ok(
      catalog.contexts.some(
        (context) =>
          context.executionNodeId === fixture.executionNodeId && context.cwd === fixture.cwd,
      ),
      'Provision an owned catalog context for the private node/cwd',
    );
    assert.ok(
      catalog.contexts.every(
        (context) => context.executionNodeId && context.executionNodeId !== 'local',
      ),
      'Remote-only owner received a gateway-local context',
    );
    assert.ok(
      catalog.runners.every((runner) => !runner.supportsWorkers && !runner.supportsQueuedWorkers),
    );
    const inventory = await ok(caller, 'native.session.list', {}, 90_000);
    assert.ok(
      inventory.sessions.every(
        (entry) =>
          entry.ownerPrincipalId === owner.id &&
          entry.executionNodeId !== 'local' &&
          !entry.workerManaged,
      ),
    );
    assert.ok(
      (inventory.unavailableExecutionNodes ?? []).every(
        (entry) => entry.executionNodeId !== 'local',
      ),
    );
    await ok(caller, 'native.session.list', { executionNodeId: fixture.executionNodeId });
    check('role-free-ui-companion-auth-and-owned-catalog-inventory');

    const marker = randomUUID();
    const other = (
      await ok(admin, 'principal.create', {
        subject: { type: 'person', displayName: `ingress-other-${marker}` },
        roles: [],
      })
    ).principal;
    const otherMachine = `native-ingress-events-${marker}`;
    const otherNodePrincipal = (
      await ok(admin, 'principal.create', {
        subject: {
          type: 'node',
          displayName: otherMachine,
          machine: otherMachine,
          nativeOwnerPrincipalId: other.id,
        },
        roles: [],
      })
    ).principal;
    const otherClient = await observeOwner(await issue(other.id), 'ui', fixture.gateway);
    clients.push(otherClient);
    let unexpectedForwards = 0;
    const eventNode = await connect(await issue(otherNodePrincipal.id), 'node', (frame, ws) => {
      unexpectedForwards++;
      ws.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: 'PROOF_UNEXPECTED_FORWARD',
            message: 'Target guard allowed a forbidden native request',
          },
        }),
      );
    });
    clients.push(eventNode);
    let observedGlobalEvent = false;
    const observeGlobal = (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'event' && JSON.stringify(frame.payload ?? null).includes(otherMachine))
        observedGlobalEvent = true;
    };
    admin.ws.on('message', observeGlobal);
    await ok(eventNode, 'node.connect', {
      machine: otherMachine,
      pid: process.pid,
      nativeSessions: { ownerPrincipalId: other.id },
    });
    await until(
      () => observedGlobalEvent,
      'admin receives real node registration broadcast',
      10_000,
    );
    await ok(caller, 'gateway.ping', {});
    await ok(companion, 'gateway.ping', {});
    assert.deepEqual(caller.events, [], 'UI received HELLO/global broadcasts');
    assert.deepEqual(companion.events, [], 'Companion received HELLO/global broadcasts');
    admin.ws.off('message', observeGlobal);
    check('no-hello-or-global-events-despite-observed-admin-broadcast');

    const foreignTarget = await caller.request('native.session.list', {
      executionNodeId: otherMachine,
    });
    report.foreignTarget = {
      forwardedRequests: unexpectedForwards,
      accepted: foreignTarget.ok,
      code: foreignTarget.error?.code,
    };
    assert.equal(
      unexpectedForwards,
      0,
      'Cross-owner target request reached the event-only foreign node',
    );
    assert.equal(foreignTarget.ok, false, 'Foreign target unexpectedly succeeded');
    assert.equal(foreignTarget.error?.code, 'NATIVE_SESSION_ERROR');
    await refused(
      otherClient,
      'native.session.list',
      { executionNodeId: fixture.executionNodeId },
      'NATIVE_SESSION_ERROR',
    );
    assert.equal(unexpectedForwards, 0, 'Cross-owner target request reached the other node');
    const localTarget = await caller.request('native.session.list', { executionNodeId: 'local' });
    report.localTarget = { accepted: localTarget.ok, code: localTarget.error?.code };
    assert.equal(localTarget.ok, false, 'Remote-only owner accessed local native inventory');
    assert.equal(localTarget.error?.code, 'AUTH_FORBIDDEN');
    await refused(caller, 'native.session.create', { runner: fixture.runner, cwd: fixture.cwd });
    await refused(caller, 'principal.bindNativeOwner', {
      nodePrincipalId: otherNodePrincipal.id,
      ownerPrincipalId: owner.id,
    });
    check('cross-owner-and-local-targets-refused-before-native-forward');

    for (const [method, params] of [
      ['fleet.status', {}],
      ['run.list', {}],
      ['run.get', { runId: marker }],
      ['gateway.status', {}],
      ['principal.list', {}],
      ['credential.list', {}],
      ['terminal.subscribe', { slotId: `ingress-${marker}` }],
    ])
      await refused(caller, method, params);
    const origin = new URL(fixture.gateway);
    origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:';
    for (const endpoint of [
      `/api/file?slotId=ingress-${marker}&path=TASK.md`,
      `/api/run-artifact?runId=${marker}&path=TASK.md`,
    ]) {
      const response = await fetch(new URL(endpoint, origin), {
        headers: { Authorization: `Bearer ${ownerToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 403, `Role-free owner reached ${endpoint.split('?')[0]}`);
    }
    check('global-farm-subscription-and-http-artifact-denial');

    session = (
      await ok(
        caller,
        'native.session.create',
        {
          executionNodeId: fixture.executionNodeId,
          runner: fixture.runner,
          cwd: fixture.cwd,
          ...(fixture.model ? { model: fixture.model } : {}),
        },
        90_000,
      )
    ).session;
    assert.equal(session.ownerPrincipalId, owner.id);
    assert.equal(session.executionNodeId, fixture.executionNodeId);
    assert.notEqual(session.workerManaged, true);
    const target = { executionNodeId: fixture.executionNodeId, sessionId: session.id };
    const baseline = await ok(caller, 'native.session.read', target);
    const commandId = randomUUID();
    const token = `NATIVE_INGRESS_${randomUUID().replaceAll('-', '')}`;
    const workerSelector = await caller.request('native.session.read', {
      ...target,
      worker: {
        runId: marker,
        contextId: 'dev',
        generation: session.generation,
        leaseId: randomUUID(),
      },
    });
    report.workerSelector = {
      accepted: workerSelector.ok,
      code: workerSelector.error?.code,
      message: workerSelector.error?.message,
    };
    assert.equal(
      workerSelector.ok,
      false,
      'Standalone owner worker selector unexpectedly succeeded',
    );
    assert.equal(
      workerSelector.error?.code,
      'AUTH_FORBIDDEN',
      'Explicit worker selector was not denied at the standalone ingress guard',
    );
    assert.equal(
      workerSelector.error?.message,
      'Native workspace enrollment does not grant worker controls',
    );
    await refused(otherClient, 'native.session.read', target, 'NATIVE_SESSION_ERROR');
    await refused(
      otherClient,
      'native.session.send',
      { ...target, commandId, text: 'Unauthorized marker. Do not execute.' },
      'NATIVE_SESSION_ERROR',
    );
    const after = await ok(caller, 'native.session.read', target);
    assert.equal(after.cursor, baseline.cursor, 'Denied access produced native events');
    assert.equal(after.session.state, baseline.session.state);
    check('worker-selector-and-other-owner-session-input-denied-without-effects');
    if (fixture.workerTarget) {
      assert.equal(fixture.workerTarget.executionNodeId, fixture.executionNodeId);
      assert.ok(
        typeof fixture.workerTarget.sessionId === 'string' && fixture.workerTarget.sessionId,
      );
      for (const method of [
        'native.session.read',
        'native.session.send',
        'native.session.respond',
        'native.session.interrupt',
        'native.session.close',
      ]) {
        await refused(caller, method, {
          ...fixture.workerTarget,
          commandId: randomUUID(),
          text: 'Forbidden worker input.',
          requestId: 'forbidden',
          decision: 'deny',
        });
      }
      check('real-worker-target-with-omitted-selector-refused');
    } else {
      report.notCovered = [
        'Omitted-selector access to a real worker-managed session requires fixture.workerTarget.',
      ];
    }

    await ok(caller, 'native.session.send', {
      ...target,
      commandId,
      text: `Reply exactly ${token}. Do not use tools, change files, or contact anyone.`,
    });
    const events = [];
    let cursor = 0;
    let page;
    await until(
      async () => {
        page = await ok(companion, 'native.session.read', { ...target, after: cursor, limit: 500 });
        events.push(...page.events);
        cursor = page.cursor;
        return events.some(
          (event) => event.commandId === commandId && event.type === 'turn.completed',
        );
      },
      'real runner tiny turn completion',
      timeoutMs,
    );
    const own = events.filter((event) => event.commandId === commandId);
    assert.ok(own.some((event) => event.type === 'command.accepted'));
    assert.ok(own.some((event) => event.type === 'turn.started'));
    assert.equal(own.find((event) => event.type === 'turn.completed').status, 'completed');
    assert.ok(
      own
        .filter((event) => event.type === 'text.delta')
        .map((event) => event.text ?? '')
        .join('')
        .includes(token),
    );
    check('real-remote-create-send-accept-stream-read-through-ui-and-companion', {
      sessionId: session.id,
    });
    const closed = await ok(caller, 'native.session.close', target);
    assert.equal(closed.closed, true);
    const stopped = await ok(caller, 'native.session.read', target);
    assert.equal(stopped.session.processStopped, true);
    check('owned-native-process-close-confirmed');
    assert.deepEqual(caller.events, []);
    assert.deepEqual(companion.events, []);
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (session && caller) {
      try {
        await ok(caller, 'native.session.close', {
          executionNodeId: fixture.executionNodeId,
          sessionId: session.id,
        });
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
    if (admin)
      for (const credentialId of credentials) {
        try {
          await ok(admin, 'credential.revoke', { credentialId });
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
