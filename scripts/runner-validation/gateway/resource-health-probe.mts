// Manual public-RPC proof. Scoped lookups use the real kernel listener; the
// controlled host-wide refusal reproduces a census that cannot meet its budget.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import type {
  ResourceHealthResult,
  RuntimeCapabilityAcquireParams,
  RuntimeCapabilityAcquireResult,
  RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';
import type { WebSocketServer } from 'ws';
import type { GatewayClient as Client } from '../../../packages/cli/src/gateway-client.js';

const source = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), 'resource-health-proof-'));
const out = path.resolve(
  process.env.FARMSLOT_RESOURCE_HEALTH_PROOF_OUT ?? 'temp/resource-health-proof',
);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const moduleUrl = (file: string) => pathToFileURL(path.join(source, file)).href;
const slotId = 'health-proof-slot';
const project = 'health-proof';
const repo = path.join(root, 'repo');
for (const dir of [
  'scripts',
  'services/gateway',
  'pool',
  `projects/${project}`,
  'repo',
  'home',
  'runs',
  'bin',
])
  mkdirSync(path.join(root, dir), { recursive: true });
for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'])
  cpSync(path.join(source, file), path.join(root, file));
mkdirSync(out, { recursive: true });
const realLsof = existsSync('/usr/sbin/lsof')
  ? '/usr/sbin/lsof'
  : execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim();
writeFileSync(
  path.join(root, 'bin/lsof'),
  [
    '#!/bin/sh',
    'scoped() {',
    '  intersect=0; pid=0',
    '  for arg do',
    '    [ "$arg" != -a ] || intersect=1',
    '    [ "$arg" != -p ] || pid=1',
    '  done',
    '  test "$intersect" = 1 && test "$pid" = 1',
    '}',
    'if ! scoped "$@"; then',
    '  echo "Controlled host-wide census exceeded probe budget" >&2',
    '  exit 124',
    'fi',
    `exec ${quote(realLsof)} "$@"`,
    '',
  ].join('\n'),
);
chmodSync(path.join(root, 'bin/lsof'), 0o755);
Object.assign(process.env, {
  PATH: `${root}/bin:${process.env.PATH}`,
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, 'capabilities.json'),
  FARMSLOT_BACKLOG_FILE: path.join(root, 'backlog.json'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(root, 'queue.json'),
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_GATEWAY_TOKEN: 'synthetic-parent-credential-not-for-this-fixture',
});
await import(moduleUrl('services/gateway/src/runtime/mock-pty.test-support.ts'));
const listener = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ Browser: 'Kernel listener health fixture' }));
});
const server = createServer();
let client: Client | undefined;
let wss: WebSocketServer | undefined;
try {
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const cdpPort = address.port;
  assert.equal((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).status, 200);
  writeFileSync(path.join(repo, 'browser.pid'), String(process.pid) + '\n');
  const action = { kind: 'resource', resource_id: 'browser', action: 'health' };
  json(path.join(root, `projects/${project}/project.json`), {
    name: project,
    runtime_dir: '.',
    slot_actions: { 'browser-retain': { label: 'Retain listener', command: 'true' } },
    resources: {
      browser: {
        type: 'browser',
        label: 'Real kernel listener',
        watch: { type: 'pid-file', path: 'browser.pid' },
        hooks: { health: 'kill -0 "$(cat browser.pid)"' },
      },
    },
    runtime_capabilities: {
      providers: {
        'browser-proof': {
          label: 'Browser proof',
          description: 'Probe ownership without boot or stop',
          version: '1',
          share_policy: 'exclusive',
          cost: {
            class: 'low',
            resources: [{ id: 'browser', kind: 'process', access: 'exclusive', scope: 'slot' }],
          },
          actions: {
            acquire: action,
            health: action,
            release: { kind: 'slot-action', action_id: 'browser-retain' },
          },
          affected_resources: [
            { resource_id: 'browser', ownership: 'slot-lifecycle', release_effect: 'retain' },
          ],
          release_effects: ['Retain the disposable listener'],
          keep_warm_ms: 0,
        },
      },
    },
  });
  json(path.join(root, 'pool/local.json'), {
    machine: 'health-proof-local',
    host: 'localhost',
    project,
    platform: 'cli',
    slots: [
      {
        id: slotId,
        project,
        repo,
        session: slotId,
        enabled: false,
        mode: 'dispatch',
        resources: { browser: { cdp_port: cdpPort } },
      },
    ],
  });
  json(path.join(root, '.farm-status.json'), {
    slots: [
      {
        slot: slotId,
        slot_epoch: 1,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        current_run_id: null,
      },
    ],
  });
  const original = await import(moduleUrl('services/gateway/src/fleet/resource-exec.ts'));
  let negative = false;
  let restoredOldLookups = 0;
  mock.module(moduleUrl('services/gateway/src/fleet/resource-exec.ts'), {
    namedExports: {
      ...original,
      execResourceCommand: async (slot: string, cwd: string, command: string, timeout: number) => {
        if (negative && command.includes('$(cdp_listeners "$1")')) {
          command = command.replace('$(cdp_listeners "$1")', '$(cdp_listeners)');
          restoredOldLookups++;
        }
        return original.execResourceCommand(slot, cwd, command, timeout);
      },
    },
  });
  const store = await import(moduleUrl('services/gateway/src/runs/store.ts'));
  await store.loadAllRuns();
  const owner = store.createRun({ flowType: 'dev', project, ticketOrPr: 'PROJ-999999', slotId });
  await import(moduleUrl('services/gateway/src/methods/runtime-capabilities.ts'));
  const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import(
    moduleUrl('services/gateway/src/security/auth.ts')
  );
  const { createWebSocketServer } = await import(moduleUrl('services/gateway/src/server.ts'));
  const { GatewayClient } = await import(moduleUrl('packages/cli/src/gateway-client.ts'));
  const auth = createGatewayAuthRuntime({
    FARMSLOT_HOME: process.env.FARMSLOT_HOME,
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(auth, { host: '127.0.0.1' });
  wss = createWebSocketServer(server, auth);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = server.address();
  assert.ok(gateway && typeof gateway !== 'string');
  client = new GatewayClient({
    url: `ws://127.0.0.1:${gateway.port}`,
    timeout: 30000,
    credential: null,
  });
  const acquire: RuntimeCapabilityAcquireParams = {
    slotId,
    ownerRunId: owner.id,
    capabilityId: 'browser-proof',
    proofRequirement: {
      capabilityId: 'browser-proof',
      reason: 'Kernel ownership probe',
      mode: 'state',
    },
  };
  negative = true;
  const refusedHealth = await client!.call<ResourceHealthResult>('resource.health', { slotId });
  assert.equal(
    refusedHealth.resources.find((resource) => resource.id === 'browser')?.status,
    'stopped',
  );
  const refusedAcquire = await client!.call<RuntimeCapabilityAcquireResult>(
    'runtime.capability.acquire',
    acquire,
  );
  assert.equal(refusedAcquire.ok, false);
  assert.ok(restoredOldLookups > 0, 'the negative control restored the former global lookup');
  negative = false;
  const healthy = await client!.call<ResourceHealthResult>('resource.health', { slotId });
  assert.equal(healthy.resources.find((resource) => resource.id === 'browser')?.status, 'running');
  const acquired = await client!.call<RuntimeCapabilityAcquireResult>(
    'runtime.capability.acquire',
    acquire,
  );
  assert.ok(acquired.ok, JSON.stringify(acquired));
  assert.equal(acquired.lease.health.state, 'healthy');
  const released = await client!.call<RuntimeCapabilityReleaseResult>(
    'runtime.capability.release',
    { slotId, ownerRunId: owner.id, keepWarm: false },
  );
  assert.equal(released.ok, true);
  assert.equal(readFileSync(path.join(repo, 'browser.pid'), 'utf8').trim(), String(process.pid));
  assert.equal(
    (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).status,
    200,
    'retaining release preserves the listener',
  );
  json(path.join(out, 'receipt.json'), {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    sourceHash: createHash('sha256')
      .update(readFileSync(path.join(source, 'services/gateway/src/fleet/resource-manager.ts')))
      .digest('hex'),
    publicMethods: ['resource.health', 'runtime.capability.acquire', 'runtime.capability.release'],
    negative: { restoredOldLookups, healthyHttpStatus: 200, refusedHealth, refusedAcquire },
    positive: { healthy, leaseHealth: acquired.lease.health, released: released.ok },
    listenerPidPreserved: true,
    listenerHttpStatusAfterRelease: 200,
    liveOperatorWrites: 0,
    inheritedCredentialIgnored: true,
    note: 'Controlled refusal applies only to global queries. Scoped queries use real lsof and a real disposable TCP listener. This is gateway health proof, not Terminal acceptance.',
  });
  console.log(
    'Public resource health and capability acquisition pass with scoped kernel ownership; former global lookup refused.',
  );
} finally {
  if (wss) {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss!.close(resolve));
  }
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
}
