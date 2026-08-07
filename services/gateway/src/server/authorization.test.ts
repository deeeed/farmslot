process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  type CredentialIssueResult,
  type GatewayAuthConnectResult,
  Methods,
  NODE_FRAME_MAGIC,
  type Principal,
  type PrincipalCreateResult,
  type ProjectConfig,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';
import { createWebSocketServer } from '../server.js';
import { resolveWebhookWorkOriginator } from '../webhook.js';

test('authorization denial survives the response frame with a teaching Next action', async () => {
  const runtime = isolatedRuntime();
  const principal = runtime.writer.createPrincipal({ type: 'person', displayName: 'sam' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  const issue = runtime.writer.issueCredential(principal.id, 'sam-laptop');
  const harness = await startServer(runtime);
  try {
    const ws = await connect(harness.url);
    const auth = await request(ws, Methods.AUTH_CONNECT, {
      clientKind: 'ui',
      token: issue.secret,
    });
    assert.equal(auth.ok, true);
    assert.deepEqual((auth.payload as { principal?: unknown }).principal, {
      id: principal.id,
      displayName: 'sam',
      subjectKind: 'person',
      roles: [{ role: 'operator', scope: { kind: 'global' } }],
    });

    const permitted = await request(ws, Methods.DISPATCH_QUEUE_LIST, {});
    assert.equal(permitted.ok, true);

    const privileged = await request(ws, Methods.DISPATCH_QUEUE_ADD, {});
    assert.equal(privileged.ok, false);
    assert.match(privileged.error?.message ?? '', /requires the admin role[\s\S]*principal 'sam'/u);
    assert.match(
      privileged.error?.userAction ?? '',
      /farmslot principal grant sam --role admin --scope global/u,
    );
    assert.doesNotMatch(privileged.error?.message ?? '', /owner/u);

    const unproven = await request(ws, Methods.BACKLOG_UPCOMING, {});
    assert.equal(unproven.ok, false);
    assert.match(unproven.error?.message ?? '', /not on the proven-conformant allowlist/u);
    assert.notEqual(unproven.error?.message, privileged.error?.message);
    ws.close();
    await onceClose(ws);
  } finally {
    await harness.close();
  }
});

test('auth.connect enforces node subject and returns all virtual and stored self summaries', async () => {
  const solo = isolatedRuntime();
  const soloHarness = await startServer(solo);
  try {
    const ui = await connect(soloHarness.url);
    const uiAuth = await request(ui, Methods.AUTH_CONNECT, { clientKind: 'ui' });
    const uiPrincipal = (uiAuth.payload as GatewayAuthConnectResult).principal;
    assert.equal(uiPrincipal?.id, 'local-admin');
    assert.equal(uiPrincipal?.subjectKind, 'person');
    ui.close();
    await onceClose(ui);

    const node = await connect(soloHarness.url);
    const nodeAuth = await request(node, Methods.AUTH_CONNECT, { clientKind: 'node' });
    const nodePrincipal = (nodeAuth.payload as GatewayAuthConnectResult).principal;
    assert.equal(nodePrincipal?.id, 'local-node');
    assert.equal(nodePrincipal?.subjectKind, 'node');
    node.close();
    await onceClose(node);
  } finally {
    await soloHarness.close();
  }

  const activated = isolatedRuntime();
  const operator = activated.writer.createPrincipal({ type: 'person', displayName: 'operator' }, [
    { role: 'operator', scope: { kind: 'global' } },
  ]);
  const operatorIssue = activated.writer.issueCredential(operator.id, 'operator');
  const activatedHarness = await startServer(activated);
  try {
    const ws = await connect(activatedHarness.url);
    const rejected = await request(ws, Methods.AUTH_CONNECT, {
      clientKind: 'node',
      token: operatorIssue.secret,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, 'AUTH_FORBIDDEN');
    assert.match(rejected.error?.userAction ?? '', /issue a node credential/u);
    ws.close();
    await onceClose(ws);
  } finally {
    await activatedHarness.close();
  }
});

test('all seven node frame paths accept node principals and refuse non-node principals', async () => {
  const runtime = isolatedRuntime();
  const admin = runtime.writer.createPrincipal({ type: 'person', displayName: 'frame-admin' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const adminIssue = runtime.writer.issueCredential(admin.id, 'frame-admin');
  const node = runtime.writer.createPrincipal(
    { type: 'node', displayName: 'frame-node', machine: 'frame-node' },
    [],
  );
  const nodeIssue = runtime.writer.issueCredential(node.id, 'frame-node');
  const frames: Array<{ name: string; data: string | Buffer }> = [
    {
      name: 'binary',
      data: Buffer.from([NODE_FRAME_MAGIC, 0, 0, 1, 0, 1, 1, 0x73, 0]),
    },
    {
      name: 'response',
      data: JSON.stringify({ type: 'res', id: 'unknown-node-request', ok: true, payload: {} }),
    },
    {
      name: 'fs.changed',
      data: JSON.stringify({
        type: 'event',
        event: 'node.fs.changed',
        payload: {
          requestId: 'unknown-watch',
          machine: 'frame-node',
          path: '/tmp/unknown',
          content: '',
        },
      }),
    },
    {
      name: 'exec.output',
      data: JSON.stringify({
        type: 'event',
        event: 'node.exec.output',
        payload: { requestId: 'unknown-node-request', stream: 'stdout', data: '' },
      }),
    },
    {
      name: 'resource.changed',
      data: JSON.stringify({
        type: 'event',
        event: 'node.resource.changed',
        payload: {
          machine: 'frame-node',
          slotId: 'frame-test-slot',
          resourceId: 'gateway',
          status: 'unknown',
        },
      }),
    },
    {
      name: 'tmux.workers.changed',
      data: JSON.stringify({
        type: 'event',
        event: 'node.tmux.workers.changed',
        payload: { machine: 'frame-node', panes: [] },
      }),
    },
    {
      name: 'metrics',
      data: JSON.stringify({
        type: 'event',
        event: 'node.metrics',
        payload: {
          machine: 'frame-node',
          metrics: {
            cpuPercent: 0,
            memoryPercent: 0,
            memoryUsedGb: 0,
            memoryTotalGb: 1,
            diskPercent: 0,
            loadAvg1: 0,
            loadAvg5: 0,
            collectedAt: new Date(0).toISOString(),
          },
        },
      }),
    },
  ];
  const harness = await startServer(runtime);
  try {
    for (const frame of frames) {
      const nodeWs = await connect(harness.url);
      const nodeAuth = await request(nodeWs, Methods.AUTH_CONNECT, {
        clientKind: 'node',
        token: nodeIssue.secret,
      });
      assert.equal(nodeAuth.ok, true, `${frame.name}: node authentication`);
      nodeWs.send(frame.data);
      await waitForFrameHandling();
      assert.equal(nodeWs.readyState, WebSocket.OPEN, `${frame.name}: node principal accepted`);
      nodeWs.close();
      await onceClose(nodeWs);

      const adminWs = await connect(harness.url);
      const adminAuth = await request(adminWs, Methods.AUTH_CONNECT, {
        clientKind: 'ui',
        token: adminIssue.secret,
      });
      assert.equal(adminAuth.ok, true, `${frame.name}: non-node authentication`);
      const closed = onceClose(adminWs);
      adminWs.send(frame.data);
      const denial = await closed;
      assert.equal(denial.code, 1008, `${frame.name}: non-node principal refused`);
      assert.match(denial.reason, /node authentication required/u, frame.name);
    }
  } finally {
    await harness.close();
  }
});

test(
  'unexpected resolver faults close structured node frames as internal failures',
  { timeout: 5_000 },
  async () => {
    const runtime = isolatedRuntime();
    const node = runtime.writer.createPrincipal(
      { type: 'node', displayName: 'fault-node', machine: 'fault-node' },
      [],
    );
    const nodeIssue = runtime.writer.issueCredential(node.id, 'fault-node');
    const harness = await startServer(runtime);
    try {
      const ws = await connect(harness.url);
      const auth = await request(ws, Methods.AUTH_CONNECT, {
        clientKind: 'node',
        token: nodeIssue.secret,
      });
      assert.equal(auth.ok, true);

      const resolveSessionPrincipal = runtime.resolver.resolveSessionPrincipal;
      runtime.resolver.resolveSessionPrincipal = () => {
        throw new Error('node resolver reload proof');
      };
      try {
        const close = onceClose(ws);
        ws.send(
          JSON.stringify({
            type: 'event',
            event: 'node.metrics',
            payload: {
              machine: 'fault-node',
              metrics: {
                cpuPercent: 0,
                memoryPercent: 0,
                memoryUsedGb: 0,
                memoryTotalGb: 1,
                diskPercent: 0,
                loadAvg1: 0,
                loadAvg5: 0,
                collectedAt: new Date(0).toISOString(),
              },
            },
          }),
        );
        const closed = await close;
        assert.equal(closed.code, 1011);
        assert.equal(closed.reason, 'internal gateway error');
        assert.doesNotMatch(closed.reason, /node resolver reload proof/u);
      } finally {
        runtime.resolver.resolveSessionPrincipal = resolveSessionPrincipal;
      }
    } finally {
      await harness.close();
    }
  },
);

test(
  'unexpected resolver faults return generic authenticated RPC errors without leakage',
  { timeout: 5_000 },
  async () => {
    const runtime = isolatedRuntime();
    const admin = runtime.writer.createPrincipal({ type: 'person', displayName: 'fault-admin' }, [
      { role: 'admin', scope: { kind: 'global' } },
    ]);
    const adminIssue = runtime.writer.issueCredential(admin.id, 'fault-admin');
    const harness = await startServer(runtime);
    try {
      const ws = await connect(harness.url);
      const auth = await request(ws, Methods.AUTH_CONNECT, {
        clientKind: 'ui',
        token: adminIssue.secret,
      });
      assert.equal(auth.ok, true);

      const resolveSessionPrincipal = runtime.resolver.resolveSessionPrincipal;
      runtime.resolver.resolveSessionPrincipal = () => {
        throw new Error('rpc resolver reload proof');
      };
      try {
        const response = await request(ws, Methods.GATEWAY_PING, {});
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, 'INTERNAL_ERROR');
        assert.equal(response.error?.message, 'Internal gateway error');
        assert.doesNotMatch(JSON.stringify(response), /rpc resolver reload proof/u);
      } finally {
        runtime.resolver.resolveSessionPrincipal = resolveSessionPrincipal;
      }
      ws.close();
      await onceClose(ws);
    } finally {
      await harness.close();
    }
  },
);

test('latching activation closes every open solo session immediately', async () => {
  const runtime = isolatedRuntime();
  const harness = await startServer(runtime);
  try {
    const ws = await connect(harness.url);
    const close = onceClose(ws);
    const principal = runtime.writer.createPrincipal(
      { type: 'person', displayName: 'first-operator' },
      [{ role: 'operator', scope: { kind: 'global' } }],
    );
    runtime.writer.issueCredential(principal.id, 'first-operator');
    const closed = await close;
    assert.equal(closed.code, 1008);
    assert.match(closed.reason, /authorization changed/u);
  } finally {
    await harness.close();
  }
});

test('activation-latching issuance returns both one-time secrets before closing the session', async () => {
  const runtime = isolatedRuntime();
  const harness = await startServer(runtime);
  try {
    const ws = await connect(harness.url);
    const auth = await request(ws, Methods.AUTH_CONNECT, { clientKind: 'ui' });
    assert.equal(auth.ok, true);
    const created = await request(ws, Methods.PRINCIPAL_CREATE, {
      subject: { type: 'person', displayName: 'first-operator' },
      roles: [{ role: 'operator', scope: { kind: 'global' } }],
    });
    assert.equal(created.ok, true);
    const close = onceClose(ws);
    const issued = await request(ws, Methods.CREDENTIAL_ISSUE, {
      principalId: (created.payload as PrincipalCreateResult).principal.id,
      displayName: 'first-operator',
    });
    assert.equal(issued.ok, true);
    const issue = issued.payload as CredentialIssueResult;
    assert.match(issue.secret, /^fs_/u);
    assert.match(issue.adminGrant?.secret ?? '', /^fs_/u);
    assert.equal(issue.activationLatched, true);
    assert.equal((await close).code, 1008);
  } finally {
    await harness.close();
  }
});

test('webhook ingress requires a configured stored admin service principal', () => {
  const runtime = isolatedRuntime();
  const project = { webhooks: { auto_dispatch: true } } as ProjectConfig;
  const principals = new Map<string, Principal>();
  const resolvePrincipal = (principalId: string) => principals.get(principalId) ?? null;

  const missingConfiguration = resolveWebhookWorkOriginator(project, 'github', resolvePrincipal);
  assert.equal(missingConfiguration.ok, false);
  if (!missingConfiguration.ok) assert.match(missingConfiguration.message, /github_principal_id/u);

  const authority = runtime.writer.createPrincipal(
    { type: 'service', displayName: 'github-ingress' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  principals.set(authority.id, authority);
  const configured = resolveWebhookWorkOriginator(
    {
      ...project,
      webhooks: { ...project.webhooks, github_principal_id: authority.id },
    },
    'github',
    resolvePrincipal,
  );
  assert.deepEqual(configured, {
    ok: true,
    originator: { kind: 'principal', principalId: authority.id },
  });
});

function isolatedRuntime() {
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: mkdtempSync(join(tmpdir(), 'farmslot-server-auth-')),
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  return runtime;
}

async function startServer(runtime: ReturnType<typeof isolatedRuntime>) {
  const server = createServer();
  const wss = createWebSocketServer(server, runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

let requestId = 0;
async function request(ws: WebSocket, method: string, params: unknown): Promise<ResponseFrame> {
  const id = `auth-test-${++requestId}`;
  const response = new Promise<ResponseFrame>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as ResponseFrame;
      if (frame.type !== 'res' || frame.id !== id) return;
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
    ws.once('error', reject);
  });
  const frame: RequestFrame = { type: 'req', id, method, params };
  ws.send(JSON.stringify(frame));
  return response;
}

function onceClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitForFrameHandling(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
