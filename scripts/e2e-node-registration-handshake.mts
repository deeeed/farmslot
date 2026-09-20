#!/usr/bin/env tsx
/**
 * Node registration handshake proof against a REAL isolated gateway.
 *
 * Boots a gateway on an ephemeral port with its own FARMSLOT_HOME, seeds the
 * credential store offline, then drives the node daemon's own transport helper
 * (services/node/src/gateway-handshake.ts) over a plain `ws` socket — never a
 * full node daemon, which would contend for the canonical screen-control
 * socket. Every claim is read back through the gateway (`nodes.list` as an
 * admin), not inferred from client-side state.
 *
 *   yarn exec tsx scripts/e2e-node-registration-handshake.mts direct
 *   yarn exec tsx scripts/e2e-node-registration-handshake.mts recipe [artifacts-dir]
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import {
  CredentialStoreRuntime,
  CredentialStoreWriter,
} from '../packages/credential-store/src/index.js';
import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import { PROTOCOL_VERSION } from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';
import {
  authenticateNode,
  GatewayRequestError,
  isDeterministicHandshakeRejection,
  registerNode,
} from '../services/node/src/gateway-handshake.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scenario = process.argv[2];

if (scenario === 'recipe') {
  const catalog = JSON.parse(
    await readFile(
      path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'),
      'utf8',
    ),
  );
  const actions = ['command', 'end'];
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: catalog.$schema,
      actions: Object.fromEntries(actions.map((name) => [name, catalog.actions[name]])),
    },
    adapters: createStandardCoreAdapters({ actions }),
    runner: {
      source: 'worktree',
      git_ref: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      name: 'Node registration handshake validation',
    },
  });
  const result = await runner.run({
    recipeDocument: JSON.parse(
      await readFile(
        path.join(root, 'docs/examples/recipes/farmslot/node-registration-handshake.recipe.json'),
        'utf8',
      ),
    ),
    artifactsDir: path.resolve(
      root,
      process.argv[3] ?? `temp/node-registration-handshake/${Date.now()}`,
    ),
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'Node registration handshake validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
assert(scenario === 'direct', 'Expected direct or recipe');

// --- Isolated gateway fixture ------------------------------------------------
const fixture = await mkdtemp(path.join(tmpdir(), 'farmslot-node-handshake-'));
// The gateway reads its own branch at boot, so the fixture root must be a checkout.
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
const home = path.join(fixture, 'home');
await mkdir(home, { recursive: true, mode: 0o700 });
for (const name of ['pool', 'projects', 'runs']) await mkdir(path.join(fixture, name));
for (const name of ['scripts', 'services', 'packages'])
  await symlink(path.join(root, name), path.join(fixture, name));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated node handshake fixture\n');
await writeFile(
  path.join(fixture, '.farm-status.json'),
  JSON.stringify({ checked_at: new Date().toISOString(), slots: [] }),
);

// Seed principals offline: the gateway boots already activated, so the only
// authority in play is what the store says — no bootstrap env token.
const seeded = (() => {
  const writer = new CredentialStoreWriter(
    new CredentialStoreRuntime({ FARMSLOT_HOME: home }),
    true,
  );
  const admin = writer.createPrincipal({ type: 'person', displayName: 'proof-admin' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const owner = writer.createPrincipal({ type: 'person', displayName: 'proof-owner' }, []);
  const node = writer.createPrincipal(
    {
      type: 'node',
      displayName: 'proof-node',
      machine: 'proof-node',
      nativeOwnerPrincipalId: owner.id,
    },
    [],
  );
  // A node principal issued WITHOUT a native owner — the shape behind the
  // live AUTH_FORBIDDEN that stayed silent on the daemon.
  const orphan = writer.createPrincipal(
    { type: 'node', displayName: 'proof-orphan', machine: 'proof-orphan' },
    [],
  );
  return {
    ownerId: owner.id,
    adminSecret: writer.issueCredential(admin.id, 'proof-admin').secret,
    nodeSecret: writer.issueCredential(node.id, 'proof-node').secret,
    orphanSecret: writer.issueCredential(orphan.id, 'proof-orphan').secret,
  };
})();

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const url = `ws://127.0.0.1:${port}`;
const log = path.join(fixture, 'gateway.log');
const output = openSync(log, 'w', 0o600);
const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', output, output],
  env: {
    ...process.env,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: home,
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_TEST_STATUS_FILE: path.join(fixture, '.farm-status.json'),
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
  },
});
closeSync(output);
const terminate = () => {
  if (gateway.exitCode !== null || !gateway.pid) return;
  try {
    process.kill(-gateway.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};
process.once('exit', terminate);

// --- Proof nodes --------------------------------------------------------------
interface NodeInfo {
  machine: string;
  protocolVersion?: string;
  versionMatch?: boolean;
}
const evidence: Array<{ node: string; claim: string; ok: boolean; evidence: unknown }> = [];
function record(node: string, claim: string, ok: boolean, detail: unknown) {
  evidence.push({ node, claim, ok, evidence: detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${node} — ${claim}`);
  if (!ok) console.log(JSON.stringify(detail, null, 2));
  return ok;
}
async function openSocket(): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
}
async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}
async function failure(promise: Promise<unknown>): Promise<GatewayRequestError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof GatewayRequestError) return error;
    throw error;
  }
}

let admin: GatewayConnection | undefined;
let allOk = true;
try {
  const client = new GatewayClient({
    url,
    timeout: 10_000,
    credential: { token: seeded.adminSecret },
  });
  const deadline = Date.now() + 30_000;
  while (!admin && Date.now() < deadline) {
    if (gateway.exitCode !== null)
      throw new Error(`Isolated gateway exited with ${gateway.exitCode}; see ${log}`);
    try {
      admin = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError)) throw error;
      await delay(200);
    }
  }
  assert(admin, `Isolated gateway did not become ready; see ${log}`);
  const listNodes = async () => (await admin!.call<{ nodes: NodeInfo[] }>('nodes.list', {})).nodes;

  // 1. Auth succeeds but registration is refused: the daemon must SEE the
  //    refusal (code + gateway message) instead of waiting forever, and the
  //    machine must not appear in the registry.
  {
    const socket = await openSocket();
    const auth = await authenticateNode(socket, {
      machine: 'proof-orphan',
      credential: { token: seeded.orphanSecret },
    });
    const refusal = await failure(
      registerNode(socket, {
        machine: 'proof-orphan',
        pid: process.pid,
        capabilities: [],
        nativeSessions: { ownerPrincipalId: 'legacy-env' },
      }),
    );
    const machines = (await listNodes()).map((node) => node.machine);
    allOk =
      record(
        'registration-refusal-surfaces',
        'auth.connect succeeds, node.connect is refused with AUTH_FORBIDDEN and the gateway message; the refusal is classified deterministic and never carries the secret',
        auth.ok === true &&
          refusal?.code === 'AUTH_FORBIDDEN' &&
          /owner must match/u.test(refusal.message) &&
          isDeterministicHandshakeRejection(refusal) &&
          !refusal.message.includes(seeded.orphanSecret),
        { auth: auth.ok, refusal: refusal && { code: refusal.code, message: refusal.message } },
      ) && allOk;
    allOk =
      record(
        'refused-node-not-listed',
        'a refused registration leaves the machine out of nodes.list',
        !machines.includes('proof-orphan'),
        { machines },
      ) && allOk;
    await closeSocket(socket);
  }

  // 2. A non-node credential presented as clientKind node is refused at auth.
  {
    const socket = await openSocket();
    const refusal = await failure(
      authenticateNode(socket, {
        machine: 'proof-node',
        credential: { token: seeded.adminSecret },
      }),
    );
    allOk =
      record(
        'non-node-credential-refused',
        'auth.connect with a person credential is refused AUTH_FORBIDDEN with a node-subject action',
        refusal?.code === 'AUTH_FORBIDDEN' &&
          /node-subject principal/u.test(refusal.message) &&
          /issue a node credential/u.test(refusal.userAction ?? ''),
        refusal && { code: refusal.code, message: refusal.message, userAction: refusal.userAction },
      ) && allOk;
    await closeSocket(socket);
  }

  // 3. The correct owner registers: the ACK arrives, the registry lists the
  //    machine with a matching protocol version, and closing the socket
  //    removes it again.
  {
    const socket = await openSocket();
    await authenticateNode(socket, {
      machine: 'proof-node',
      credential: { token: seeded.nodeSecret },
    });
    const registration = await registerNode(socket, {
      machine: 'proof-node',
      pid: process.pid,
      capabilities: [],
      nativeSessions: { ownerPrincipalId: seeded.ownerId },
    });
    const listed = (await listNodes()).find((node) => node.machine === 'proof-node');
    allOk =
      record(
        'registration-ack-then-listed',
        'node.connect ACKs registered:true and nodes.list shows the machine at the gateway protocol version',
        registration.registered === true &&
          listed?.protocolVersion === PROTOCOL_VERSION &&
          listed.versionMatch === true,
        { registration, listed },
      ) && allOk;
    await closeSocket(socket);
    await delay(200);
    const after = (await listNodes()).map((node) => node.machine);
    allOk =
      record(
        'closed-node-unlisted',
        'closing the registered socket removes the machine from nodes.list',
        !after.includes('proof-node'),
        { machines: after },
      ) && allOk;
  }
} catch (error) {
  allOk = false;
  throw error;
} finally {
  admin?.close();
  terminate();
  if (allOk) await rm(fixture, { recursive: true, force: true });
  else console.log(`fixture kept for inspection: ${fixture}`);
}

console.log(JSON.stringify({ status: allOk ? 'pass' : 'fail', nodes: evidence }));
process.exit(allOk ? 0 : 1);
