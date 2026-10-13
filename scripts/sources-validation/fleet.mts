/** Manual ADR-069 fleet proof through isolated services and owned proof slots. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createSourceCommandClient,
  isTerminalRunStatus,
  type NativeSessionReadResult,
  type NativeWorkerSessionBinding,
  type Run,
  type SourceConfiguration,
  type SourceMaterialization,
  type SourcesSyncParams,
  type SourcesSyncResult,
} from '@farmslot/protocol';

import { startSourceClientScenarios } from './client-scenarios.mjs';
import { ProofSourceUpstream } from './upstream.js';

interface ProofNode {
  id: string;
  ssh?: string;
  host?: string;
  bundle: string;
  home: string;
  serviceNodeModules: string;
  forwardPort?: number;
  codexPath?: string;
  platform?: string;
  resources?: Record<string, Record<string, string | number | boolean>>;
}
interface ProofConfiguration {
  clientProof?: boolean;
  reviewFixesOnly?: boolean;
  selectionOnly?: boolean;
  localUpstream?: boolean;
  sources: SourceConfiguration;
  nodes: ProofNode[];
  consumerProject?: string;
  workerModel?: string;
}
interface ProofWorkerResult {
  active: { run: Run; binding: NativeWorkerSessionBinding };
}

const execute = promisify(execFile);
async function pipeScript(program: string, args: string[], script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let errorOutput = '';
    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    child.on('error', reject);
    child.stdin.end(script);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${program} proof operation failed: ${errorOutput}`)),
    );
  });
}
const code = fileURLToPath(new URL('../../', import.meta.url));
const configuration = JSON.parse(
  await readFile(path.resolve(process.argv[2]), 'utf8'),
) as ProofConfiguration;
const output = path.resolve(process.argv[3]);
if (
  configuration.nodes.some((node) =>
    node.ssh
      ? !node.bundle.split('/').some((part) => part.startsWith('source-proof-')) ||
        !node.home.split('/').some((part) => part.startsWith('source-proof-'))
      : !node.bundle.startsWith(output + '/') || !node.home.startsWith(output + '/'),
  )
)
  throw new Error('Node roots must be new owned proof directories');
if (
  !configuration.nodes.length ||
  !configuration.nodes.every(
    (node) =>
      node.id.startsWith('source-proof-') &&
      path.isAbsolute(node.bundle) &&
      path.isAbsolute(node.home) &&
      path.isAbsolute(node.serviceNodeModules) &&
      (!node.ssh || node.forwardPort),
  )
)
  throw new Error(
    'Provide isolated source-proof-* node identities, absolute proof roots and remote forward ports',
  );
await mkdir(output, { recursive: true });
if ((await realpath(output)) !== output)
  throw new Error('Proof output must use its canonical absolute path');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const children: ReturnType<typeof spawn>[] = [];
const ownedNodes: ProofNode[] = [];
const logs: ReturnType<typeof createWriteStream>[] = [];
const evidence: Record<string, unknown> = {
  result: 'INCOMPLETE',
  scope: configuration.selectionOnly
    ? 'selection-delta'
    : configuration.reviewFixesOnly
      ? 'review-fixes-delta'
      : 'full-fleet',
};
let upstream: ProofSourceUpstream | undefined;
let proofFailure: unknown;
let stopProofReconciliation: (() => void) | undefined;
let clientScenarios: Awaited<ReturnType<typeof startSourceClientScenarios>> | undefined;

// Do not inherit an operator gateway profile or node credential into the isolated realm.
for (const key of Object.keys(process.env))
  if (/^(FARMSLOT_|GATEWAY_|SCREEN_CONTROL_)/.test(key)) delete process.env[key];
await mkdir(path.join(output, 'no-tmux'));
process.env.TMUX_TMPDIR = path.join(output, 'no-tmux');
delete process.env.TMUX;
for (const dir of ['pool', 'projects', 'runs', 'home']) await mkdir(path.join(output, dir));

for (const name of [
  'scripts',
  'services',
  'packages',
  'schemas',
  'node_modules',
  'CLAUDE.md',
  'package.json',
])
  await symlink(path.join(code, name), path.join(output, name));
Object.assign(process.env, {
  FARMSLOT_ROOT: output,
  FARMSLOT_POOL_DIR: path.join(output, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(output, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(output, 'runs'),
  FARMSLOT_HOME: path.join(output, 'home'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  GATEWAY_HOST: '127.0.0.1',
});
await writeFile(path.join(output, 'home', 'sources.json'), JSON.stringify(configuration.sources));
await writeFile(path.join(output, '.farm-status.json'), JSON.stringify({ slots: [] }));
const runtime = await import('../../services/gateway/src/sources/runtime.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../services/gateway/src/security/auth.js');
const { createWebSocketServer } = await import('../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../packages/cli/src/gateway-client.js');
const { getNode } = await import('../../services/gateway/src/fleet/machine-registry.js');
const { sendNodeRequest } = await import('../../services/gateway/src/fleet/node-rpc.js');
const { sourceCommand } = await import('../../packages/slot-config/src/sources/index.js');
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const admin = auth.writer.createPrincipal({ type: 'person', displayName: 'source-proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(admin.id, 'source-proof');
if (configuration.workerModel) process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = admin.id;
const nodeCredentials = new Map(
  configuration.nodes.map((node) => {
    const principal = auth.writer.createPrincipal(
      {
        type: 'node',
        displayName: node.id,
        machine: node.id,
        ...(configuration.workerModel ? { nativeOwnerPrincipalId: admin.id } : {}),
      },
      [],
    );
    return [node.id, auth.writer.issueCredential(principal.id, node.id).secret];
  }),
);
const server = createServer((_request, response) => response.end('isolated source proof'));
const wss = createWebSocketServer(server, auth);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const client = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  timeout: 180_000,
  credential: { token: credential.secret },
});
const localBundle = path.join(output, 'node-bundle');
const proofRuns: string[] = [];
const sourceCommands = createSourceCommandClient((method, params) => client.call(method, params));
const syncAttempts: SourcesSyncResult[] = [];
evidence.syncAttempts = syncAttempts;
async function syncWithFreshStatusRetry(params: SourcesSyncParams): Promise<SourcesSyncResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await client.call<SourcesSyncResult>('sources.sync', {
      ...params,
      operationId: attempt ? `${params.operationId}-fresh-${attempt}` : params.operationId,
    });
    syncAttempts.push(result);
    if (
      !result.errors.length ||
      !result.errors.every((error) => error.reason.includes('timeout after 15000ms'))
    )
      return result;
    console.log(
      `Owned source status timed out for ${result.operationId}; retain it and prepare a fresh operation`,
    );
  }
  return syncAttempts.at(-1)!;
}

try {
  await mkdir(localBundle, { recursive: true });
  if (configuration.localUpstream) {
    upstream = await ProofSourceUpstream.start(path.join(output, 'upstream'), code);
    process.env.GIT_SSL_CAINFO = upstream.caFile;
    configuration.sources = {
      schemaVersion: 1,
      revision: 1,
      pollIntervalMs: 30_000,
      sources: [{ id: 'proof-pack', kind: 'pack', repo: upstream.repository }],
      packs: {
        'source-proof': { sourceId: 'proof-pack', entry: 'scripts/sources-validation/fixture' },
        'farmslot-farm': { sourceId: 'proof-pack', entry: 'framework' },
      },
    };
    evidence.upstream = {
      repository: upstream.repository,
      branches: ['main', 'experiment/farm', 'experiment/node', 'experiment/run'],
    };
  }
  await writeFile(path.join(output, 'home', 'sources.json'), JSON.stringify(configuration.sources));
  if (upstream) await cp(upstream.caFile, path.join(localBundle, 'source-proof-ca.pem'));
  for (const entry of [
    'services/node/src',
    'packages/protocol/dist',
    'packages/protocol/scripts',
    'packages/slot-config/src',
    'packages/protocol/package.json',
    'packages/slot-config/package.json',
    'CLAUDE.md',
    'scripts/dev.sh',
    'services/gateway/package.json',
  ]) {
    await mkdir(path.dirname(path.join(localBundle, entry)), { recursive: true });
    await cp(path.join(code, entry), path.join(localBundle, entry), { recursive: true });
  }
  await writeFile(path.join(localBundle, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(localBundle, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        esModuleInterop: true,
      },
    }),
  );
  for (const node of configuration.nodes) {
    if (node.ssh) {
      await execute('ssh', [
        '-o',
        'BatchMode=yes',
        node.ssh,
        `test ! -e ${quote(node.home)} && test ! -e ${quote(node.bundle)} && mkdir -p ${quote(node.bundle)}`,
      ]);
      await execute('rsync', ['-a', `${localBundle}/`, `${node.ssh}:${node.bundle}/`]);
    } else await cp(localBundle, node.bundle, { recursive: true });
    ownedNodes.push(node);
    const links = [
      ['ws', path.join(node.serviceNodeModules, 'ws')],
      ['tsx', path.join(node.serviceNodeModules, 'tsx')],
      ['@noble', path.join(node.serviceNodeModules, '@noble')],
      ['@farmslot/agent-runtime', path.join(node.serviceNodeModules, '@farmslot/agent-runtime')],
      ['@farmslot/capabilities', path.join(node.serviceNodeModules, '@farmslot/capabilities')],
      ['@farmslot/slot-config', '../../packages/slot-config'],
      ['@farmslot/protocol', '../../packages/protocol'],
    ];
    const env = {
      FARMSLOT_ROOT: node.bundle,
      FARMSLOT_HOME: node.home,
      FARMSLOT_NODE_TOKEN: nodeCredentials.get(node.id)!,
      MACHINE_NAME: node.id,
      ...(configuration.workerModel ? { FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: admin.id } : {}),
      GATEWAY_URL: `ws://127.0.0.1:${node.ssh ? node.forwardPort : port}`,
      TSX_TSCONFIG_PATH: path.join(node.bundle, 'tsconfig.json'),
      SCREEN_CONTROL_SOCKET: path.join(node.home, 'screen.sock'),
      TMUX_TMPDIR: path.join(node.home, 'no-tmux'),
      ...(upstream ? { GIT_SSL_CAINFO: path.join(node.bundle, 'source-proof-ca.pem') } : {}),
    };
    const script =
      [
        `mkdir -p ${quote(node.home)} ${quote(path.join(node.bundle, 'node_modules/@farmslot'))}`,
        `mkdir -p ${quote(path.join(node.home, 'no-tmux'))}`,
        ...(configuration.consumerProject || configuration.workerModel
          ? [
              `mkdir -p ${quote(path.join(node.home, 'source-proof-worktree'))}`,
              `git -C ${quote(path.join(node.home, 'source-proof-worktree'))} init -q -b main`,
              ...(configuration.workerModel
                ? [
                    `git -C ${quote(path.join(node.home, 'source-proof-worktree'))} -c core.hooksPath=/dev/null commit --allow-empty -S -m 'test: initialize source proof'`,
                  ]
                : []),
            ]
          : []),
        ...links.map(
          ([name, target]) =>
            `ln -s ${quote(target)} ${quote(path.join(node.bundle, 'node_modules', name))}`,
        ),
        `cd ${quote(node.bundle)}`,
        ...Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`),
        'node node_modules/tsx/dist/cli.mjs services/node/src/index.ts &',
        'proof_pid=$!',
        'trap \'kill -TERM "$proof_pid" 2>/dev/null; wait "$proof_pid"\' EXIT TERM INT HUP',
        'wait "$proof_pid"',
      ].join('\n') + '\n';
    const child = node.ssh
      ? spawn(
          'ssh',
          [
            '-T',
            '-o',
            'BatchMode=yes',
            '-o',
            'ExitOnForwardFailure=yes',
            '-o',
            'ServerAliveInterval=15',
            '-o',
            'ServerAliveCountMax=4',
            '-R',
            `${node.forwardPort}:127.0.0.1:${port}`,
            ...(upstream ? ['-R', `${upstream.port}:127.0.0.1:${upstream.port}`] : []),
            node.ssh,
            'bash -s',
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
      : spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const log = createWriteStream(path.join(output, `${node.id}.log`));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.stdin.end(script);
    child.once('close', (code, signal) => {
      console.log(JSON.stringify({ event: 'proof-process-exit', nodeId: node.id, code, signal }));
    });
    children.push(child);
    logs.push(log);
  }
  if (configuration.consumerProject || configuration.workerModel) {
    const project = configuration.consumerProject ?? Object.keys(configuration.sources.packs)[0];
    if (
      configuration.consumerProject &&
      (project !== 'source-proof' || !configuration.sources.packs[project])
    )
      throw new Error('Consumer proof requires the committed source-proof fixture pack');
    for (const node of configuration.nodes) {
      const slotId = `${node.id}-consumer`;
      await writeFile(
        path.join(output, 'pool', `${node.id}.json`),
        JSON.stringify({
          machine: node.id,
          host: node.host ?? (node.ssh ? node.ssh.split('@').at(-1) : 'localhost'),
          ssh_user: node.ssh?.split('@')[0] ?? process.env.USER,
          codex_path: node.codexPath,
          os: 'darwin',
          platform: node.platform ?? 'cli',
          project,
          review_workspaces: { max_concurrent: 1 },
          slots: [
            {
              id: slotId,
              repo: path.join(node.home, 'source-proof-worktree'),
              session: slotId,
              mode: 'dispatch',
              resources: node.resources ?? (configuration.consumerProject ? { probe: {} } : {}),
            },
          ],
        }),
      );
    }
    await writeFile(
      path.join(output, '.farm-status.json'),
      JSON.stringify({
        slots: configuration.nodes.map((node) => ({
          slot: `${node.id}-consumer`,
          machine: node.id,
          project,
          lifecycle: 'ready',
          agent: 'idle',
          current_run_id: null,
          resources: node.resources ?? (configuration.consumerProject ? { probe: {} } : {}),
        })),
      }),
    );
  }
  await runtime.initializeSources();
  const deadline = Date.now() + 90_000;
  while (true) {
    const status = await client.call<{ nodes: Array<{ machine: string }> }>('nodes.list', {});
    if (
      status.nodes.filter((node) => nodeCredentials.has(node.machine)).length ===
      configuration.nodes.length
    )
      break;
    if (
      children.some((child) => child.exitCode !== null && child.exitCode !== 0) ||
      Date.now() > deadline
    )
      throw new Error('Proof node failed registration; inspect retained logs');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const request = {
    operationId: 'proof-sync',
    expectedDeclarationRevision: configuration.sources.revision,
  };
  let synced = await client.call<SourcesSyncResult>('sources.sync', request);
  assert.deepEqual(synced.errors, []);
  assert.deepEqual(await client.call('sources.sync', request), synced);
  evidence.sync = synced;
  if (upstream && configuration.reviewFixesOnly) {
    evidence.deltaNodeBaseline = await sourceCommands.execute(
      await sourceCommands.prepareUnpin(
        { sourceId: 'proof-pack', scope: 'node', targetId: configuration.nodes[0].id },
        'proof-delta-node-main-bootstrap',
      ),
    );
  }
  if (upstream && !configuration.reviewFixesOnly) {
    const firstNode = configuration.nodes[0].id;
    const farmCommand = await sourceCommands.preparePin(
      { sourceId: 'proof-pack', ref: 'experiment/farm', scope: 'farm', targetId: 'farm' },
      'proof-farm-pin',
    );
    const farm = await sourceCommands.execute(farmCommand);
    assert.deepEqual(await sourceCommands.execute(farmCommand), farm);
    const farmNodes = new Set(
      runtime
        .sourceAuthority()!
        .locks()
        .filter((lock) => lock.pinRevision === farm.pinRevision)
        .map((lock) => lock.context.nodeId),
    );
    for (const node of configuration.nodes) assert(farmNodes.has(node.id));
    const nodeCommand = await sourceCommands.preparePin(
      { sourceId: 'proof-pack', ref: 'experiment/node', scope: 'node', targetId: firstNode },
      'proof-node-pin',
    );
    const nodePin = await sourceCommands.execute(nodeCommand);
    const nodeStatus = await sourceCommands.status({ nodeId: firstNode });
    assert.equal(nodeStatus.effectiveSelections![0].effectiveRef, 'experiment/node');
    assert(nodeStatus.effectiveSelections![0].shadowedPins.some((pin) => pin.scope === 'farm'));
    const mainCommand = await sourceCommands.prepareUnpin(
      { sourceId: 'proof-pack', scope: 'node', targetId: firstNode },
      'proof-node-main',
    );
    const main = await sourceCommands.execute(mainCommand);
    const mainStatus = await sourceCommands.status({ nodeId: firstNode });
    assert.equal(mainStatus.effectiveSelections![0].effectiveRef, 'main');
    assert.equal(mainStatus.effectiveSelections![0].pin!.selection, 'main');
    assert(
      mainStatus.effectiveSelections![0].shadowedPins.some((pin) => pin.ref === 'experiment/farm'),
    );
    const scopedSync = await syncWithFreshStatusRetry(
      (await sourceCommands.prepareSync({}, 'proof-scoped-sync')).params,
    );
    assert.deepEqual(scopedSync.errors, []);
    const inputs = configuration.nodes.map((node) => {
      const lock = scopedSync.locks.find(
        (lock) => lock.context.nodeId === node.id && lock.context.project === 'source-proof',
      );
      assert(lock);
      return { nodeId: node.id, lock };
    });
    assert.equal(inputs[0].lock.entries[0].effectiveRef, 'main');
    if (inputs.length > 1) assert.equal(inputs[1].lock.entries[0].effectiveRef, 'experiment/farm');
    const baseline = (await runtime.projectContext('source-proof', { nodeId: firstNode }))
      .materialization.lock;
    const afterCommit = await upstream.advance('main', 'advanced-main');
    await upstream.alias('experiment/same', 'main');
    const deadline = Date.now() + 90_000;
    while (true) {
      const status = await sourceCommands.status({ sourceId: 'proof-pack', nodeId: firstNode });
      if (
        status.resolutions.some(
          (record) =>
            record.ref === 'main' && record.commit === afterCommit && record.status === 'resolved',
        )
      )
        break;
      if (Date.now() > deadline)
        throw new Error('Branch update was not observed by independent source polling');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      main.pin.baseMainCommit,
      (await sourceCommands.status({ nodeId: firstNode })).effectiveSelections![0].pin!
        .baseMainCommit,
    );
    assert.notEqual(baseline.entries[0].commit, afterCommit);
    assert.deepEqual(
      (await sendNodeRequest(getNode(firstNode)!, 'sources.verify', {
        lock: baseline,
      })) as SourceMaterialization,
      await sendNodeRequest(getNode(firstNode)!, 'sources.verify', { lock: baseline }),
    );
    evidence.scopes = {
      farm,
      nodePin,
      main,
      inputs,
      branchAdvance: {
        before: baseline.entries[0].commit,
        after: afterCommit,
        baseMainPreserved: true,
      },
    };
    synced = await syncWithFreshStatusRetry(
      (await sourceCommands.prepareSync({}, 'proof-current-main-sync')).params,
    );
    assert.deepEqual(synced.errors, []);
  }
  const protections = [];
  for (const node of configuration.reviewFixesOnly ? [] : configuration.nodes)
    for (const lock of synced.locks.filter(
      (lock) => !lock.context.nodeId || lock.context.nodeId === node.id,
    )) {
      const connection = getNode(node.id)!;
      const materialization = (await sendNodeRequest(
        connection,
        'sources.materialize',
        { lock },
        { timeout: 120_000, requireSameConnection: true },
      )) as SourceMaterialization;
      const source = Object.values(materialization.roots)[0];
      const program =
        "const fs=require('node:fs');const path=require('node:path');const root=process.argv[1];let write,chmod;try{fs.writeFileSync(path.join(root,'source-write-probe'),'refuse')}catch(e){write=e.code}try{fs.chmodSync(root,0o777)}catch(e){chmod=e.code}console.log(JSON.stringify({write,chmod}));if(write!=='EROFS'||chmod!=='EROFS')process.exit(1)";
      const result = (await sendNodeRequest(
        connection,
        'exec',
        { argv: ['node', '-e', program, source], timeout: 10_000 },
        { timeout: 15_000, requireSameConnection: true },
      )) as { exitCode: number; stdout: string };
      assert.equal(result.exitCode, 0);
      const detach = (await sendNodeRequest(
        connection,
        'exec',
        {
          argv: ['hdiutil', 'detach', '-quiet', path.dirname(source)],
          timeout: 30_000,
        },
        { timeout: 35_000, requireSameConnection: true },
      )) as { exitCode: number };
      assert.equal(detach.exitCode, 0);
      await assert.rejects(
        sendNodeRequest(
          connection,
          'sources.verify',
          { lock },
          { timeout: 30_000, requireSameConnection: true },
        ),
        /missing/,
      );
      const recovery = await syncWithFreshStatusRetry({
        ...request,
        operationId: `proof-remount-${node.id}-${lock.digest}`,
        nodeId: node.id,
      });
      assert.deepEqual(recovery.errors, []);
      const restored = await sendNodeRequest(
        connection,
        'sources.verify',
        { lock },
        { timeout: 30_000, requireSameConnection: true },
      );
      assert.deepEqual(restored, materialization);
      protections.push({
        node: node.id,
        ...JSON.parse(result.stdout),
        remount: {
          receiptId: materialization.receipt.id,
          lockDigest: lock.digest,
          unchanged: true,
        },
      });
    }
  evidence.protection = protections;
  await writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (configuration.consumerProject && !configuration.reviewFixesOnly) {
    const consumers = [];
    for (const node of configuration.nodes) {
      const slotId = `${node.id}-consumer`;
      const connection = getNode(node.id)!;
      const action = await client.call<{ ok: boolean; detail: string }>('slot.action.run', {
        slotId,
        actionId: 'slot:probe',
      });
      assert.equal(action.ok, true, action.detail);
      const copied = await client.call<{ ok: boolean; command: string }>('slot.action.run', {
        slotId,
        actionId: 'slot:copy',
      });
      assert.equal(copied.ok, true);
      const copy = (await sendNodeRequest(connection, 'exec', {
        cmd: copied.command,
        cwd: path.join(node.home, 'source-proof-worktree'),
        timeout: 10_000,
      })) as { exitCode: number };
      assert.equal(copy.exitCode, 0);
      const health = await client.call<{ resources: Array<{ id: string; status: string }> }>(
        'resource.health',
        { slotId },
      );
      assert.ok(
        health.resources.some(
          (resource) => resource.id === 'probe' && resource.status === 'running',
        ),
      );
      const control = await client.call<{ ok: boolean }>('resource.control', {
        slotId,
        resourceId: 'probe',
        action: 'boot',
      });
      assert.equal(control.ok, true);
      const { sendWatchInstructions } =
        await import('../../services/gateway/src/fleet/resource-manager.js');
      await sendWatchInstructions(node.id);
      const read = () =>
        sendNodeRequest(connection, 'exec', {
          argv: [
            'node',
            '-e',
            "const fs=require('node:fs');console.log(JSON.stringify(['action','copy','health','control','watch'].map(kind=>JSON.parse(fs.readFileSync('source-'+kind+'.json','utf8')))))",
          ],
          cwd: path.join(node.home, 'source-proof-worktree'),
          timeout: 5_000,
        }) as Promise<{ exitCode: number; stdout: string }>;
      const deadline = Date.now() + 15_000;
      let records: Array<{ nodeId: string; lockDigest: string }>;
      while (true) {
        const result = await read();
        records = result.exitCode === 0 ? JSON.parse(result.stdout) : [];
        if (
          records.length === 5 &&
          records.every(
            (record) =>
              record.nodeId === node.id &&
              synced.locks.some(
                (lock) => lock.context.nodeId === node.id && lock.digest === record.lockDigest,
              ),
          )
        )
          break;
        if (Date.now() > deadline)
          throw new Error(
            `Source consumer receipts did not reach the current node closure: ${node.id}: ${JSON.stringify(records)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      consumers.push({ nodeId: node.id, records });
    }
    evidence.consumers = consumers;
    await writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  if (upstream) {
    await sourceCommands.execute(
      await sourceCommands.prepareUnpin(
        { sourceId: 'proof-pack', scope: 'farm', targetId: 'farm' },
        'proof-farm-main',
      ),
    );
  }
  if (configuration.workerModel) {
    const workers = [];
    const workerProject =
      configuration.consumerProject ?? Object.keys(configuration.sources.packs)[0];
    const program =
      "const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const receipt=JSON.parse(fs.readFileSync(process.env.FARMSLOT_SOURCE_RECEIPT,'utf8'));assert.equal(receipt.lock.digest,process.env.FARMSLOT_SOURCE_LOCK_DIGEST);const id=process.env.FARMSLOT_SOURCE_PACK_ID;const root=path.join(receipt.roots[id],process.env.FARMSLOT_SOURCE_PACK_ENTRY);assert.ok(JSON.parse(fs.readFileSync(path.join(root,'project.json'),'utf8')).name);fs.writeFileSync('source-worker.json',JSON.stringify({nodeId:receipt.receipt.nodeId,lockDigest:receipt.lock.digest,commits:receipt.receipt.sources.map(source=>source.commit)}))";
    const { writeNativeFixtureTask } = await import('../runner-validation/lib/native-task.mjs');
    for (const node of configuration.reviewFixesOnly
      ? configuration.nodes.slice(0, 1)
      : configuration.nodes) {
      const slotId = `${node.id}-consumer`;
      const connection = getNode(node.id)!;
      console.log(`Native worker proof starting on ${node.id}`);
      const task = async (suffix: string) => {
        const taskFile = path.join(output, 'tasks', 'dev', `${node.id}-${suffix}`, 'TASK.md');
        await mkdir(path.dirname(taskFile), { recursive: true });
        await writeNativeFixtureTask(
          taskFile,
          '# Worker: dev\n\n## Checklist\n\n' +
            `- [ ] Run exactly: node -e ${quote(program)}\n` +
            '- [ ] Check both checklist boxes, then end this turn. Do not write a terminal signal, commit, publish, or contact another service.\n',
          workerProject,
        );
        return taskFile;
      };
      const make = async (suffix: string, parent?: Run) => {
        const created = await client.call<{ run: Run }>('run.createNative', {
          flowType: 'dev',
          project: workerProject,
          ticketOrPr: `MANUAL-${Date.now()}`,
          slotId,
          allowedSlots: [slotId],
          taskFile: await task(suffix),
          runner: 'codex',
          model: configuration.workerModel,
          effort: 'medium',
          mode: 'interactive',
          skipPrepare: true,
          safetyTier: 'full-auto',
          ...(upstream
            ? {
                sourceSelections: [
                  {
                    sourceId: 'proof-pack',
                    selection: parent ? 'main' : 'branch',
                    ...(parent ? {} : { ref: 'experiment/same' }),
                  },
                ],
              }
            : {}),
          ...(parent
            ? {
                parentRunId: parent.id,
                familyId: parent.familyId,
                engineState: { flags: { warmSessionReuse: true } },
              }
            : {}),
        });
        proofRuns.push(created.run.id);
        evidence.workerRunIds = [...proofRuns];
        return created.run;
      };
      const awaitWorker = async (run: Run) => {
        const deadline = Date.now() + 240_000;
        while (true) {
          const current = (await client.call<{ run: Run }>('run.get', { runId: run.id })).run;
          assert.ok(
            !['blocked', 'failed', 'cancelled', 'reconciling'].includes(current.status),
            `${current.status}: ${current.error}`,
          );
          const context = current.agentContexts?.find(
            (context) => context.nativeSession && context.role === 'dev',
          );
          const binding = context?.nativeSession;
          if (binding?.generation && binding.acceptedAt) {
            const read = await client.call<NativeSessionReadResult>('native.session.read', {
              sessionId: binding.sessionId,
              executionNodeId: binding.executionNodeId,
              worker: {
                runId: run.id,
                contextId: context!.id,
                leaseId: binding.leaseId,
                generation: binding.generation,
              },
            });
            if (read.session.state === 'idle') {
              const marker = (await sendNodeRequest(connection, 'exec', {
                argv: [
                  'node',
                  '-e',
                  "console.log(require('node:fs').readFileSync('source-worker.json','utf8'))",
                ],
                cwd: path.join(node.home, 'source-proof-worktree'),
                timeout: 5_000,
              })) as { exitCode: number; stdout: string };
              if (marker.exitCode === 0) {
                const record = JSON.parse(marker.stdout);
                assert.equal(record.nodeId, node.id);
                assert.equal(record.lockDigest, current.sourceProvenance!.workerLock.digest);
                return { run: current, binding, session: read.session, record };
              }
            }
          }
          if (Date.now() > deadline) throw new Error(`Worker proof timed out: ${run.id}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };
      const first = await awaitWorker(await make('first'));
      let active = first;
      if (!configuration.selectionOnly) {
        const cleared = (await sendNodeRequest(connection, 'exec', {
          argv: ['node', '-e', "require('node:fs').unlinkSync('source-worker.json')"],
          cwd: path.join(node.home, 'source-proof-worktree'),
          timeout: 5_000,
        })) as { exitCode: number };
        assert.equal(cleared.exitCode, 0);
        active = await awaitWorker(await make('retained', first.run));
        assert.equal(active.binding.sessionId, first.binding.sessionId);
        assert.equal(active.session.nativeSessionId, first.session.nativeSessionId);
        assert.equal(active.binding.launchDigest, first.binding.launchDigest);
        assert.notEqual(active.binding.leaseId, first.binding.leaseId);
        assert.notEqual(
          active.run.sourceProvenance!.lock.digest,
          first.run.sourceProvenance!.lock.digest,
        );
        assert.equal(
          active.run.sourceProvenance!.workerLock.digest,
          first.run.sourceProvenance!.workerLock.digest,
        );
      }
      const templates = await runtime.withRunSources(active.run, async () => {
        const { loadSlotVars, loadProjectVars, currentProjectSources } =
          await import('@farmslot/slot-config');
        const { projectWorkerTemplatePath } =
          await import('../../services/gateway/src/core/worker-templates.js');
        const { expandReviewTemplate } =
          await import('../../services/gateway/src/review/templates.js');
        const { resolveCiFixTemplatePath } =
          await import('../../services/gateway/src/ci-monitor/inline-fix.js');
        const sources = currentProjectSources()!;
        const vars = await loadSlotVars(slotId);
        const pv = await loadProjectVars(workerProject);
        const records = [];
        for (const name of ['review.md', 'review-fix.md']) {
          const file = await projectWorkerTemplatePath(workerProject, name);
          assert.equal(
            file,
            path.join(
              sources.materialization.roots[sources.pack.sourceId],
              sources.pack.entry,
              'templates/worker',
              name,
            ),
          );
          const raw = await readFile(file, 'utf8');
          records.push({ name, file, sha256: createHash('sha256').update(raw).digest('hex') });
        }
        const rendered = await expandReviewTemplate(
          vars,
          'source-proof-review',
          active.run.id,
          'static-code',
        );
        assert.ok(rendered.includes('Description and evidence check'));
        assert.ok(!rendered.includes('{{farmslot_dir}}'));
        const ci = await resolveCiFixTemplatePath(workerProject);
        assert.ok(
          ci?.startsWith(sources.materialization.roots[pv.sourceContext!.pack.sourceId] + '/'),
        );
        records.push({
          name: 'ci-fix.md',
          file: ci!,
          sha256: createHash('sha256')
            .update(await readFile(ci!, 'utf8'))
            .digest('hex'),
        });
        return {
          runId: active.run.id,
          lockDigest: active.run.sourceProvenance!.lock.digest,
          records,
          rendered: true,
        };
      });
      workers.push({
        nodeId: node.id,
        mode: configuration.selectionOnly ? 'ordinary-active-worker' : 'retained-worker',
        first,
        ...(configuration.selectionOnly ? {} : { second: active }),
        active,
        templates,
      });
      evidence.workers = workers;
      await writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
    evidence.workers = workers;
  }
  if (upstream && !configuration.selectionOnly) {
    const sourceSelections = [
      { sourceId: 'proof-pack', selection: 'branch' as const, ref: 'experiment/run' },
    ];
    const params = {
      flowType: 'dev',
      project: 'source-proof',
      ticketOrPr: `MANUAL-${Date.now()}`,
      mode: 'interactive',
      runner: 'codex',
      allowedSlots: [`${configuration.nodes[0].id}-consumer`],
      skipPrepare: true,
      sourceSelections,
      actor: 'untrusted-wire-actor',
    };
    const before = await sourceCommands.status();
    await assert.rejects(
      client.call('run.create', {
        ...params,
        sourceSelections: [{ ...sourceSelections[0], ref: 'experiment/missing' }],
      }),
      /branch|unavailable|resolve|ref/i,
    );
    assert.deepEqual((await sourceCommands.status()).pins, before.pins);
    const automatic = (
      await client.call<{ run: Run }>('run.create', {
        ...params,
      })
    ).run;
    proofRuns.push(automatic.id);
    assert.equal(automatic.slotId, null);
    const automaticStatus = await sourceCommands.status({ runId: automatic.id });
    assert(
      automaticStatus.effectiveSelections![0].shadowedPins.some(
        (pin) => pin.scope === 'node' && pin.targetId === configuration.nodes[0].id,
      ),
    );
    assert(
      automaticStatus.nodes.every(
        (node) => node.nodeId === 'gateway' || node.nodeId === configuration.nodes[0].id,
      ),
    );
    await client.call('run.cancel', { runId: automatic.id });
    const planned = (await client.call<{ run: Run }>('run.create', params)).run;
    proofRuns.push(planned.id);
    assert.equal(planned.sourceProvenance, undefined);
    assert.equal(planned.sourcePlan!.lock.entries[0].effectiveRef, 'experiment/run');
    const runStatus = await sourceCommands.status({ runId: planned.id });
    assert.equal(runStatus.runSource!.canSelectSources, true);
    assert.equal(runStatus.effectiveSelections![0].pin!.scope, 'run');
    assert.equal(runStatus.effectiveSelections![0].pin!.actor, admin.id);
    await sourceCommands.execute(
      await sourceCommands.preparePin(
        { sourceId: 'proof-pack', ref: 'experiment/node', scope: 'run', targetId: planned.id },
        'proof-queued-run-pin',
      ),
    );
    const replanned = (await client.call<{ run: Run }>('run.get', { runId: planned.id })).run;
    assert.equal(replanned.sourcePlan!.lock.entries[0].effectiveRef, 'experiment/node');
    await sourceCommands.execute(
      await sourceCommands.prepareUnpin(
        { sourceId: 'proof-pack', scope: 'run', targetId: planned.id },
        'proof-queued-run-main',
      ),
    );
    const mainRun = (await client.call<{ run: Run }>('run.get', { runId: planned.id })).run;
    assert.equal(mainRun.sourcePlan!.lock.entries[0].effectiveRef, 'main');
    const queued = await client.call<{ item: { id: string; sourceSelections: unknown } }>(
      'dispatch.queue.add',
      { ...params, slotId: params.allowedSlots[0] },
    );
    assert.deepEqual(queued.item.sourceSelections, sourceSelections);
    const listed = await client.call<{ items: Array<{ id: string; sourceSelections: unknown }> }>(
      'dispatch.queue.list',
      {},
    );
    assert.deepEqual(
      listed.items.find((item) => item.id === queued.item.id)!.sourceSelections,
      sourceSelections,
    );
    await client.call('dispatch.queue.remove', { itemId: queued.item.id });
    const raceCommand = await sourceCommands.preparePin(
      { sourceId: 'proof-pack', ref: 'experiment/run', scope: 'run', targetId: planned.id },
      'proof-pin-admission-race',
    );
    const raced = await Promise.allSettled([
      sourceCommands.execute(raceCommand),
      (async () => {
        await runtime.admitRunSources(mainRun.id, {
          nodeId: configuration.nodes[0].id,
          slotId: params.allowedSlots[0],
        });
        const latest = (await client.call<{ run: Run }>('run.get', { runId: mainRun.id })).run;
        return runtime.withRunSources(
          latest,
          async () => {
            const { currentProjectSources } = await import('@farmslot/slot-config');
            return currentProjectSources()!.execution!;
          },
          { nodeId: configuration.nodes[0].id },
        );
      })(),
    ]);
    assert.equal(raced[1].status, 'fulfilled');
    const raceRun = (await client.call<{ run: Run }>('run.get', { runId: planned.id })).run;
    assert(raceRun.sourceProvenance);
    assert.equal(
      raceRun.sourceProvenance.lock.entries[0].effectiveRef,
      raced[0].status === 'fulfilled' ? 'experiment/run' : 'main',
    );
    evidence.atomicSelections = {
      automatic: { runId: automatic.id, plan: automatic.sourcePlan, status: automaticStatus },
      runId: planned.id,
      rejectedSelectionPublishedNoPins: true,
      trustedActor: admin.id,
      initial: planned.sourcePlan,
      replanned: replanned.sourcePlan,
      unpinned: mainRun.sourcePlan,
      queuedSelections: queued.item.sourceSelections,
      admissionRace: {
        pinResult: raced[0].status,
        provenance: raceRun.sourceProvenance,
        receipt: raced[1].status === 'fulfilled' ? raced[1].value.receipt : undefined,
      },
    };
    await client.call('run.cancel', { runId: planned.id });
    const { proveSourceReviewFixes } = await import('./review-fixes.mjs');
    evidence.reviewFixes = await proveSourceReviewFixes({
      client,
      upstream,
      nodeId: configuration.nodes[0].id,
      principal: admin,
      workerModel: configuration.workerModel!,
      proofRuns,
      output,
    });
    runtime.stopSourceReconciliation();
    await runtime.sourceAuthority()!.reconcile();
    const actor = auth.writer.createPrincipal(
      { type: 'person', displayName: 'source-proof-revoked' },
      [{ role: 'admin', scope: { kind: 'global' } }],
    );
    const actorCredential = auth.writer.issueCredential(actor.id, 'source-proof-revoked');
    const actorClient = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      credential: { token: actorCredential.secret },
      timeout: 120_000,
    });
    const actorSources = createSourceCommandClient((method, params) =>
      actorClient.call(method, params),
    );
    const actorCommand = await sourceCommands.preparePin(
      { sourceId: 'proof-pack', ref: 'experiment/node', scope: 'farm', targetId: 'farm' },
      'proof-actor-fetch-race',
    );
    const actorBefore = await sourceCommands.status();
    let revokedDuringFetch = false;
    const stopObserver = upstream.onNextRequest(() => {
      auth.writer.revokeRole(actor.id, 'admin', { kind: 'global' });
      revokedDuringFetch = true;
    });
    try {
      await assert.rejects(
        actorSources.execute(actorCommand),
        /admin|authority|permission|authorized|access|credential|connection closed/i,
      );
      assert(
        revokedDuringFetch,
        'The real Git fetch must occur before revoking the acting administrator',
      );
      // Revocation also closes the caller's socket; drain the real ref fetches before checking publication.
      await runtime.sourceAuthority()!.reconcile();
      const actorAfter = await sourceCommands.status();
      assert.equal(actorAfter.pinRevision, actorBefore.pinRevision);
      assert.deepEqual(actorAfter.pins, actorBefore.pins);
      evidence.actorFetchRace = { revokedDuringFetch, noPinPublication: true, actorId: actor.id };
    } finally {
      stopObserver();
      stopProofReconciliation = runtime.sourceAuthority()!.startReconciliation((id, error) => {
        console.error(`[proof-sources] ${id}: ${String(error)}`);
      });
    }
  }
  if (configuration.workerModel) {
    const workers = evidence.workers as ProofWorkerResult[];
    const { proveSelectionRestart } = await import('./selection-restart.mjs');
    assert(upstream);
    const selection = await proveSelectionRestart({
      client,
      node: configuration.nodes[0],
      worker: workers[0].active,
      upstream,
      proofRuns,
      output,
      workerModel: configuration.workerModel,
    });
    evidence.selectionRestart = selection;
    await writeFile(
      path.join(output, 'selection-restart-evidence.json'),
      JSON.stringify({ result: 'PASS', ...selection }, null, 2) + '\n',
    );
    for (const worker of workers.filter(
      (item) => !selection.closedRunIds.includes(item.active.run.id),
    )) {
      const { run, binding } = worker.active;
      const context = run.agentContexts!.find(
        (context) => context.nativeSession?.sessionId === binding.sessionId,
      )!;
      const closed = await client.call<{ session: { processStopped?: boolean } }>(
        'native.session.close',
        {
          sessionId: binding.sessionId,
          executionNodeId: binding.executionNodeId,
          worker: {
            runId: run.id,
            contextId: context.id,
            generation: binding.generation,
            leaseId: binding.leaseId,
          },
        },
      );
      assert.equal(closed.session.processStopped, true);
      await client.call('run.cancel', { runId: run.id });
    }
  }
  const admissionProject =
    configuration.consumerProject ?? Object.keys(configuration.sources.packs)[0];
  const admissionSlot = `${configuration.nodes[0].id}-consumer`;
  const created = await client.call<{ run: Run }>('run.create', {
    flowType: 'dev',
    project: admissionProject,
    ticketOrPr: `MANUAL-${Date.now()}`,
    mode: 'interactive',
    runner: 'codex',
    slotId: admissionSlot,
    skipPrepare: true,
    ...(upstream ? { sourceSelections: [{ sourceId: 'proof-pack', selection: 'main' }] } : {}),
  });
  proofRuns.push(created.run.id);
  assert.ok(created.run.sourcePlan || created.run.sourceProvenance);
  const current = (await client.call<{ run: Run }>('run.get', { runId: created.run.id })).run;
  const consumed = await runtime.withRunSources(current, async () => {
    const { currentProjectSources } = await import('@farmslot/slot-config');
    return currentProjectSources()!.execution!;
  });
  const admitted = (await client.call<{ run: Run }>('run.get', { runId: created.run.id })).run;
  assert.ok(admitted.sourceProvenance);
  assert.equal(admitted.sourceProvenance.lock.context.runId, admitted.id);
  assert.equal(consumed.receipt.nodeId, configuration.nodes[0].id);
  const frozen = structuredClone(admitted.sourceProvenance);
  if (upstream) {
    await assert.rejects(
      async () =>
        sourceCommands.execute(
          await sourceCommands.preparePin({
            sourceId: 'proof-pack',
            ref: 'experiment/run',
            scope: 'run',
            targetId: admitted.id,
          }),
        ),
      /admitted|another run|immutable/,
    );
    await sourceCommands.execute(
      await sourceCommands.preparePin(
        { sourceId: 'proof-pack', ref: 'experiment/farm', scope: 'farm', targetId: 'farm' },
        'proof-active-farm-pin',
      ),
    );
    assert.deepEqual(
      (await client.call<{ run: Run }>('run.get', { runId: admitted.id })).run.sourceProvenance,
      frozen,
    );
    const again = await runtime.withRunSources(admitted, async () => {
      const { currentProjectSources } = await import('@farmslot/slot-config');
      return currentProjectSources()!.execution!;
    });
    assert.deepEqual(again, consumed);
    await sourceCommands.execute(
      await sourceCommands.prepareUnpin(
        { sourceId: 'proof-pack', scope: 'farm', targetId: 'farm' },
        'proof-active-farm-main',
      ),
    );
    evidence.admittedFrozen = {
      runId: admitted.id,
      provenance: frozen,
      unchanged: true,
      protection: consumed.receipt.sources.map((source) => source.protection),
    };
  }
  evidence.runProvenance = admitted.sourceProvenance;
  await client.call('run.cancel', { runId: created.run.id });

  if (configuration.clientProof) {
    clientScenarios = await startSourceClientScenarios({
      output,
      gatewayPort: port,
      racePin: async ({ sourceId, scope, targetId }) => {
        await sourceCommands.execute(
          await sourceCommands.prepareUnpin({ sourceId, scope, targetId }),
        );
      },
      interruptSync: async () => {
        const node = configuration.nodes[0];
        const connection = getNode(node.id)!;
        const signal = async (name: string) => {
          if (node.ssh)
            await execute('ssh', [
              '-o',
              'BatchMode=yes',
              node.ssh,
              `kill -${name} ${connection.pid}`,
            ]);
          else process.kill(connection.pid, name as NodeJS.Signals);
        };
        const restore = async () => {
          await signal('SIGCONT');
          const deadline = Date.now() + 30_000;
          while (!getNode(node.id)) {
            if (Date.now() > deadline) throw new Error('Owned node failed recovery');
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        };
        await signal('SIGSTOP');
        connection.ws.terminate();
        const deadline = Date.now() + 5_000;
        while (getNode(node.id)) {
          if (Date.now() > deadline) {
            await restore();
            throw new Error('Owned node failed disconnect');
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return restore;
      },
    });
    await writeFile(
      path.join(output, 'client-connection.json'),
      JSON.stringify({
        port: clientScenarios.port,
        token: credential.secret,
        runId: admitted.id,
        nodeId: configuration.nodes[0].id,
      }),
      { mode: 0o600 },
    );
    console.log('Client proof ready; waiting for client-evidence.json in the owned proof root');
    const deadline = Date.now() + 45 * 60_000;
    while (true) {
      try {
        const clients = JSON.parse(
          await readFile(path.join(output, 'client-evidence.json'), 'utf8'),
        );
        assert.equal(clients.result, 'PASS');
        evidence.clients = clients;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (Date.now() > deadline) throw new Error('Client proof did not finish before the deadline');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  await clientScenarios?.close();
  clientScenarios = undefined;
  const project = Object.keys(configuration.sources.packs)[0];
  const context = await runtime.projectContext(project);
  const mount = path.dirname(context.materialization.roots[context.pack.sourceId]);
  await sourceCommand('hdiutil', ['detach', '-quiet', mount]);
  const remount = await syncWithFreshStatusRetry({
    ...request,
    operationId: 'proof-remount-gateway',
  });
  assert.deepEqual(remount.errors, []);
  assert.deepEqual(
    (await runtime.projectContext(project)).materialization,
    context.materialization,
  );
  evidence.gatewayRemount = { receiptId: context.materialization.receipt.id, unchanged: true };
  await sourceCommand('hdiutil', ['detach', '-quiet', mount]);
  await writeFile(path.join(mount, 'source-drift'), 'do not hide changed inputs');
  const refusal = await client.call<SourcesSyncResult>('sources.sync', {
    ...request,
    operationId: 'proof-drift',
  });
  assert.ok(refusal.errors.some((error) => error.reason.includes('contains files')));
  evidence.drift = refusal;
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = (error as Error).message;
  proofFailure = error;
} finally {
  stopProofReconciliation?.();
  runtime.stopSourceReconciliation();
  const teardownErrors: string[] = [];
  try {
    await clientScenarios?.close();
  } catch (error) {
    teardownErrors.push(String(error));
  }
  try {
    for (const runId of proofRuns) {
      try {
        const current = (await client.call<{ run: Run }>('run.get', { runId })).run;
        if (!isTerminalRunStatus(current.status)) await client.call('run.cancel', { runId });
      } catch (error) {
        teardownErrors.push(`${runId}: ${(error as Error).message}`);
      }
    }
    for (const node of [
      { id: 'gateway', home: path.join(output, 'home'), kind: 'gateway', ssh: undefined },
      ...ownedNodes.map((node) => ({ ...node, kind: 'node' })),
    ]) {
      try {
        const detach = `python3 - <<'PY'\nimport json,subprocess\nfrom pathlib import Path\nreceipts=Path(${JSON.stringify(path.join(node.home, 'sources', node.kind, 'receipts'))})\nmounts={str(Path(root).parent) for record in receipts.glob('*.json') for root in json.loads(record.read_text())['roots'].values()}\nfor mount in mounts:\n try:\n  mounted=Path(mount).stat().st_dev != Path(mount).parent.stat().st_dev\n except FileNotFoundError:\n  mounted=False\n if mounted:\n  subprocess.run(['hdiutil','detach','-quiet',mount],check=True)\nPY\n`;
        if (node.ssh)
          await pipeScript('ssh', ['-T', '-o', 'BatchMode=yes', node.ssh, 'bash -s'], detach);
        else await pipeScript('bash', ['-s'], detach);
      } catch (error) {
        teardownErrors.push(`${node.id}: ${(error as Error).message}`);
      }
    }
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolve) => child.once('close', resolve)),
      ),
    );
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const log of logs) log.end();
    if (upstream) await upstream.close();
    evidence.teardownErrors = teardownErrors;
    if (teardownErrors.length) evidence.result = 'FAIL';
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  if (teardownErrors.length)
    throw new AggregateError(
      [...(proofFailure ? [proofFailure] : []), ...teardownErrors.map((error) => new Error(error))],
      'Source proof failed during teardown; inspect retained evidence',
    );
}
if (proofFailure) throw proofFailure;
console.log('Source fleet proof PASS');
