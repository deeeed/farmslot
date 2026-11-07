// Manual real-daemon conformance. No production service, identity, selector or native host changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { NodeInfo, NodeLinkAuthority } from '../../../packages/protocol/src/index.js';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import {
  cleanupOnExit,
  listProcesses,
  poll,
  startReaper,
  stopProcess,
} from '../lib/isolated-stack.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.resolve(process.argv[2] ?? path.join(source, 'temp/node-link-conformance'));
await mkdir(evidence, { recursive: true, mode: 0o700 });
await rm(path.join(evidence, 'PASS.json'), { force: true });
const metadata = path.join(evidence, 'owned-root.json');
let fixture: string;
try {
  fixture = JSON.parse(await readFile(metadata, 'utf8')).root;
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  fixture = await mkdtemp(path.join(tmpdir(), 'node-link-conformance-'));
  await writeFile(
    metadata,
    JSON.stringify({ root: fixture, source, candidate: 'unpublished source validation' }),
    { mode: 0o600 },
  );
}
fixture = await realpath(fixture);
const farm = path.join(fixture, 'farm'),
  home = path.join(fixture, 'home'),
  nodeRoot = path.join(fixture, 'node');
for (const directory of [
  farm,
  home,
  nodeRoot,
  path.join(farm, 'pool'),
  path.join(farm, 'projects'),
  path.join(farm, 'runs'),
  path.join(fixture, 'workspace'),
])
  await mkdir(directory, { recursive: true });
for (const entry of ['packages', 'services', 'node_modules']) {
  try {
    await symlink(path.join(source, entry), path.join(farm, entry));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}
await cp(path.join(source, 'scripts'), path.join(farm, 'scripts'), { recursive: true });
await writeFile(path.join(farm, 'CLAUDE.md'), '# Owned node-link validation root\n');
await writeFile(path.join(farm, '.farm-status.json'), '{"slots":[]}\n');
const machine = 'node-link-proof';
await writeFile(
  path.join(farm, 'pool', machine + '.json'),
  JSON.stringify({
    machine,
    host: '127.0.0.1',
    os: process.platform,
    env: { FARMSLOT_NODE_LINK_ENABLED: '1' },
    slots: [],
  }),
);
const inherited = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (
    /^FARMSLOT_|^GATEWAY_|^TMUX|^MACHINE_NAME$|^SCREEN_CONTROL_SOCKET$|^NODE_TEST_CONTEXT$/.test(
      key,
    )
  )
    delete process.env[key];
}
Object.assign(process.env, {
  FARMSLOT_ROOT: farm,
  FARMSLOT_HOME: home,
  FARMSLOT_POOL_DIR: path.join(farm, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(farm, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(farm, 'runs'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'token',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  TMUX_TMPDIR: path.join('/private/tmp', `nl-tmux-${path.basename(fixture).slice(-6)}`),
});
await mkdir(process.env.TMUX_TMPDIR, { recursive: true });
const reaper = startReaper();
let nodeProcess: ChildProcess | undefined;
let server: ReturnType<typeof createServer> | undefined;
let webSockets:
  | Awaited<
      ReturnType<
        (typeof import('../../../services/gateway/src/server.js'))['createWebSocketServer']
      >
    >
  | undefined;
let ownedTmux = false;
let ownedEffectPid: number | undefined;
let ownedEffectMarker: string | undefined;
async function stopOwnedEffect(): Promise<void> {
  if (!ownedEffectPid) return;
  const row = listProcesses().find((entry) => entry.pid === ownedEffectPid);
  if (!row) {
    ownedEffectPid = undefined;
    return;
  }
  if (!ownedEffectMarker || !row.command.includes(ownedEffectMarker))
    throw new Error('Owned effect PID changed; refusing to signal it');
  process.kill(-ownedEffectPid, 'SIGTERM');
  await poll(
    'owned effect closeout',
    async () => !listProcesses().some((entry) => entry.pid === ownedEffectPid) || undefined,
    5000,
  );
  ownedEffectPid = undefined;
}
let client: Awaited<ReturnType<GatewayClient['connect']>> | undefined;
const cleanup = cleanupOnExit(async () => {
  client?.close();
  await stopProcess(nodeProcess);
  await stopOwnedEffect();
  if (ownedTmux) await execFileAsync('tmux', ['kill-server'], { env: process.env });
  for (const peer of webSockets?.clients ?? []) peer.terminate();
  if (webSockets) await new Promise<void>((resolve) => webSockets!.close(() => resolve()));
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await rm(path.join('/private/tmp', `nl-tmux-${path.basename(fixture).slice(-6)}`), {
    recursive: true,
    force: true,
  });
  reaper.done();
  for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key];
  Object.assign(process.env, inherited);
});
let pass = false;
try {
  const { createGatewayAuthRuntime } =
    await import('../../../services/gateway/src/security/auth.js');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const operator = auth.writer.createPrincipal(
    { type: 'service', displayName: 'Owned protocol proof' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const operatorCredential = auth.writer.issueCredential(operator.id, 'Owned protocol proof');
  const { registerGatewayStatusProcess } =
    await import('../../../services/gateway/src/projects/repo-root.js');
  registerGatewayStatusProcess();
  const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
  server = createServer();
  webSockets = createWebSocketServer(server, auth);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  client = await new GatewayClient({
    url,
    credential: { token: operatorCredential.secret },
    timeout: 30_000,
  }).connect();
  const existing = await client.call<{
    principals: Array<{ id: string; subject: { type: string; machine?: string } }>;
  }>('principal.list', {});
  const nodePrincipal =
    existing.principals.find(
      (principal) => principal.subject.type === 'node' && principal.subject.machine === machine,
    ) ??
    (
      await client.call<{ principal: { id: string } }>('principal.create', {
        subject: { type: 'node', machine, displayName: 'Owned node daemon' },
        roles: [],
      })
    ).principal;
  const credential = await client.call<{ secret: string }>('credential.issue', {
    principalId: nodePrincipal.id,
    displayName: 'Owned node daemon',
  });
  await writeFile(path.join(nodeRoot, '.env'), `FARMSLOT_NODE_TOKEN=${credential.secret}\n`, {
    mode: 0o600,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FARMSLOT_HOME: path.join(nodeRoot, 'home'),
    FARMSLOT_NODE_TOKEN: credential.secret,
    GATEWAY_URL: url,
    MACHINE_NAME: machine,
    SCREEN_CONTROL_SOCKET: path.join(fixture, 'screen.sock'),
    TSX_TSCONFIG_PATH: path.join(source, 'services/node/tsconfig.json'),
  };
  const startNode = () => {
    const fd = openSync(path.join(evidence, 'node.log'), 'a', 0o600);
    nodeProcess = spawn(
      process.execPath,
      [
        '--import',
        path.join(source, 'node_modules/tsx/dist/loader.mjs'),
        path.join(source, 'services/node/src/index.ts'),
      ],
      { cwd: nodeRoot, env, detached: true, stdio: ['ignore', fd, fd] },
    );
    closeSync(fd);
    reaper.group(nodeProcess.pid);
  };
  startNode();
  const connected = await poll(
    'real issued node daemon',
    async () => {
      if (nodeProcess?.exitCode !== null) throw new Error('Owned node exited; inspect node.log');
      const reply = await client!.call<{ nodes: NodeInfo[] }>('nodes.list', {});
      return reply.nodes.find((node) => node.machine === machine && node.nodeLink?.commands === 1);
    },
    30_000,
  );
  assert.equal(connected.nodeLink?.streams, 1);
  const { getNode } = await import('../../../services/gateway/src/fleet/machine-registry.js');
  let registered = getNode(machine);
  assert(registered?.nodePrincipal);
  const { invokeNodeLink } = await import('../../../services/gateway/src/fleet/node-link.js');
  const { sendNodeRequest } = await import('../../../services/gateway/src/fleet/node-rpc.js');
  const root = path.join(fixture, 'workspace');
  const authority: NodeLinkAuthority = {
    requester: { principalId: operator.id, generation: 0 },
    executor: registered.nodePrincipal,
    grantId: 'real-file-policy',
    approvalId: 'owned-proof',
    approval: 'framework',
  };
  const invocation = {
    commandId: `real-daemon-create-only-file:${operator.id}`,
    target: { nodeId: machine, resourceId: 'owned-workspace' },
    authority,
    root,
    assertCurrent: () => {
      assert.equal(getNode(machine), registered);
    },
  };
  const fileName = `receipt-${operator.id}.txt`;
  const request = {
    operation: 'file.write' as const,
    input: { root, relPath: fileName, content: 'NODE_LINK_REAL_DAEMON', expectedHash: null },
  };
  const first = await invokeNodeLink(request, invocation);
  await writeFile(path.join(evidence, 'file-receipt.json'), JSON.stringify(first, null, 2));
  assert.equal(first.state, 'completed');
  assert.equal(await readFile(path.join(root, fileName), 'utf8'), 'NODE_LINK_REAL_DAEMON');
  assert.deepEqual(await invokeNodeLink(request, invocation), first);
  await assert.rejects(
    invokeNodeLink({ ...request, input: { ...request.input, content: 'changed' } }, invocation),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const intentFile = path.join(
    home,
    'node-link-intents',
    machine,
    createHash('sha256').update(invocation.commandId).digest('hex') + '.json',
  );
  const retained = JSON.parse(await readFile(intentFile, 'utf8'));
  await sendNodeRequest(
    registered,
    'node.link.authorize',
    { ...retained.grant, expiresAt: Date.now() + 60_000 },
    { requireSameConnection: true },
  );
  assert.deepEqual(
    await sendNodeRequest(registered, 'node.link.command', retained.command, {
      requireSameConnection: true,
    }),
    first,
  );
  const initialPid = nodeProcess?.pid;
  await stopProcess(nodeProcess);
  await poll('private node disconnect', async () => !getNode(machine) || undefined, 10_000);
  startNode();
  await poll(
    'restarted private node',
    async () => {
      const next = getNode(machine);
      return next && next.pid !== initialPid && next.nodeLink?.commands === 1 ? next : undefined;
    },
    30_000,
  );
  registered = getNode(machine);
  assert(registered?.nodePrincipal);
  await sendNodeRequest(
    registered,
    'node.link.authorize',
    { ...retained.grant, expiresAt: Date.now() + 60_000 },
    { requireSameConnection: true },
  );
  const restartedReceipt = await sendNodeRequest(
    registered,
    'node.link.receipt',
    retained.command,
    { requireSameConnection: true },
  );
  assert.deepEqual(restartedReceipt, first);
  let output = '';
  const processResult = await invokeNodeLink(
    {
      operation: 'process.run',
      input: {
        argv: [process.execPath, '-e', 'process.stdout.write("REAL_STREAM")'],
        cwd: root,
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      },
    },
    {
      ...invocation,
      commandId: `real-daemon-process:${operator.id}`,
      authority: { ...authority, grantId: 'real-process-policy' },
      onOutput: (_stream, data) => {
        output += data;
      },
    },
  );
  assert.equal(processResult.state, 'completed');
  assert.equal(output, 'REAL_STREAM');
  // A hard daemon crash does not prove an effect's result. Boot journals failed(unknown),
  // releases its command fence and leaves any deliberate retry to the domain recovery path.
  ownedEffectMarker = path.join(root, `interrupted-effect-${operator.id}.json`);
  const crashInvocation = {
    ...invocation,
    commandId: `crash-effect:${operator.id}`,
    authority: { ...authority, grantId: 'crash-policy' },
    timeoutMs: 10_000,
  };
  const crashRequest = {
    operation: 'process.run' as const,
    input: {
      argv: [
        process.execPath,
        '-e',
        'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)',
        ownedEffectMarker,
      ],
      cwd: root,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    },
  };
  const interruptedIndex = path.join(nodeRoot, 'home', 'node-link', machine, 'pending.json');
  const preAdmissionIndex = await readFile(interruptedIndex);
  const interrupted = invokeNodeLink(crashRequest, crashInvocation).then(
    (receipt) => ({ ok: true, receipt }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  ownedEffectPid = await poll(
    'owned effect admitted before crash',
    async () => {
      try {
        return JSON.parse(await readFile(ownedEffectMarker!, 'utf8')).pid || undefined;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    5000,
  );
  const stopped = once(nodeProcess!, 'exit');
  process.kill(nodeProcess!.pid!, 'SIGKILL');
  await stopped;
  const uncertain = await interrupted;
  assert.equal(uncertain.ok, false);
  await stopOwnedEffect();
  // Fault injection only in this stopped owned fixture: model loss of the index
  // publication while preserving the actual daemon's durable admitted receipt.
  await writeFile(interruptedIndex, preAdmissionIndex);
  await poll('crashed node disconnect', async () => !getNode(machine) || undefined, 10_000);
  startNode();
  registered = await poll(
    'node restarted after interrupted admission',
    async () => getNode(machine),
    30_000,
  );
  assert(registered.nodePrincipal);
  const failedUnknown = await invokeNodeLink(crashRequest, crashInvocation);
  assert.equal(failedUnknown.state, 'failed');
  assert.equal(failedUnknown.error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(failedUnknown.closeoutConfirmed, false);
  const replay = await invokeNodeLink(
    {
      operation: 'file.write',
      input: {
        root,
        relPath: `domain-replay-${operator.id}`,
        content: 'explicit replay',
        expectedHash: null,
      },
    },
    {
      ...invocation,
      commandId: `explicit-domain-replay:${operator.id}`,
      authority: { ...authority, grantId: 'domain-replay-policy' },
    },
  );
  assert.equal(replay.state, 'completed');
  // The shortened, private TMUX_TMPDIR belongs only to this fixture.
  // A raw-input fixture records received bytes, independent of shell echo/redraw timing.
  const inputFile = path.join(root, `pty-input-${operator.id}.txt`);
  const readyFile = path.join(root, `pty-ready-${operator.id}.json`);
  const terminalFixture = path.join(root, 'terminal-fixture.cjs');
  await writeFile(
    terminalFixture,
    `const fs=require('node:fs');
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',data=>{fs.appendFileSync(process.argv[2],data);process.stdout.write(data)});
fs.writeFileSync(process.argv[3],JSON.stringify({pid:process.pid}));`,
  );
  await execFileAsync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      'node-link-pty',
      '-c',
      root,
      process.execPath,
      terminalFixture,
      inputFile,
      readyFile,
    ],
    { env: process.env },
  );
  ownedTmux = true;
  await poll(
    'raw terminal fixture readiness',
    async () => {
      try {
        return JSON.parse(await readFile(readyFile, 'utf8')).pid || undefined;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    5000,
  );
  const { openLinkedPty } =
    await import('../../../services/gateway/src/fleet/node-link-terminal.js');
  const { sendWorkerTerminalInput } =
    await import('../../../services/gateway/src/runtime/worker-terminal-stream.js');
  let terminalOutput = '';
  let attachmentExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    attachmentExited = resolve;
  });
  const attachment = await openLinkedPty({
    nodeId: machine,
    resourceId: 'owned-terminal',
    session: 'node-link-pty',
    cols: 80,
    rows: 24,
    assertCurrent: () => {
      assert.equal(getNode(machine), registered);
    },
    onData: (data) => {
      terminalOutput += data;
    },
    onExit: attachmentExited,
  });
  await attachment.resize(100, 30);
  const worker = { nodeId: machine, session: 'node-link-pty', target: 'node-link-pty' };
  const keys = 'Up';
  const seq = { stream: 'node-link-proof', n: 1 };
  await sendWorkerTerminalInput(worker, keys, undefined, seq);
  await sendWorkerTerminalInput(worker, keys, undefined, seq);
  await sendWorkerTerminalInput(worker, ';', undefined, { stream: seq.stream, n: 2 });
  await sendWorkerTerminalInput(worker, '_SECOND_BATCH', undefined, { stream: seq.stream, n: 3 });
  await poll(
    'numbered terminal input side effect',
    async () => {
      try {
        return (await readFile(inputFile, 'utf8')) === keys + ';_SECOND_BATCH' || undefined;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    5000,
  );
  await poll(
    'real terminal stream marker',
    async () => terminalOutput.includes('Up;_SECOND_BATCH') || undefined,
    5000,
  );
  attachment.kill();
  await exited;
  await execFileAsync('tmux', ['has-session', '-t', '=node-link-pty'], { env: process.env });
  await sendWorkerTerminalInput(worker, '_AFTER_DETACH', undefined, { stream: seq.stream, n: 4 });
  await poll(
    'worker preserved after observer detach',
    async () =>
      (await readFile(inputFile, 'utf8')) === keys + ';_SECOND_BATCH_AFTER_DETACH' || undefined,
    5000,
  );
  pass = true;
  await writeFile(
    path.join(evidence, 'PASS.json'),
    JSON.stringify(
      {
        pass,
        fixture,
        realDaemonPID: nodeProcess.pid,
        node: connected,
        tokenPrinted: false,
        publicServicesChanged: false,
        createOnlyEffectOnce: true,
        changedKeyRefused: true,
        realStream: output,
        restartKeptOriginalOutcome: true,
        interruptedAdmissionFailedUnknown: true,
        staleValidIndexRecovered: true,
        domainReplayFenceReleased: true,
        nodeOwnedPty: true,
        numberedInputOnce: true,
        detachPreservedWorkerSession: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      pass,
      realDaemonPID: nodeProcess.pid,
      nodeProtocol: connected.protocolVersion,
      runtime: connected.runtimeVersion,
    }),
  );
} finally {
  await cleanup();
  await writeFile(
    path.join(evidence, 'CLEANUP.json'),
    JSON.stringify({
      pass,
      nodeExited: nodeProcess?.exitCode !== null || nodeProcess?.signalCode !== null,
      fixtureRetained: true,
      publicServicesChanged: false,
    }),
  );
}
