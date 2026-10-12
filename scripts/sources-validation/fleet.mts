/** Manual ADR-069 fleet proof. Runs isolated services; never deploys or leases a slot. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  SourceConfiguration,
  SourceMaterialization,
  SourcesSyncResult,
} from '@farmslot/protocol';

interface ProofNode {
  id: string;
  ssh?: string;
  bundle: string;
  home: string;
  serviceNodeModules: string;
  forwardPort?: number;
}
interface ProofConfiguration {
  sources: SourceConfiguration;
  nodes: ProofNode[];
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
const logs: ReturnType<typeof createWriteStream>[] = [];
const evidence: Record<string, unknown> = { result: 'INCOMPLETE' };

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
const nodeCredentials = new Map(
  configuration.nodes.map((node) => {
    const principal = auth.writer.createPrincipal(
      { type: 'node', displayName: node.id, machine: node.id },
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
try {
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
      GATEWAY_URL: `ws://127.0.0.1:${node.ssh ? node.forwardPort : port}`,
      TSX_TSCONFIG_PATH: path.join(node.bundle, 'tsconfig.json'),
      SCREEN_CONTROL_SOCKET: path.join(node.home, 'screen.sock'),
    };
    const script =
      [
        `mkdir -p ${quote(node.home)} ${quote(path.join(node.bundle, 'node_modules/@farmslot'))}`,
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
            '-R',
            `${node.forwardPort}:127.0.0.1:${port}`,
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
    children.push(child);
    logs.push(log);
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
  const synced = await client.call<SourcesSyncResult>('sources.sync', request);
  assert.deepEqual(synced.errors, []);
  assert.deepEqual(await client.call('sources.sync', request), synced);
  evidence.sync = synced;
  const protections = [];
  for (const node of configuration.nodes)
    for (const lock of synced.locks) {
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
      protections.push({ node: node.id, ...JSON.parse(result.stdout) });
    }
  evidence.protection = protections;
  const created = await client.call<{ run: import('@farmslot/protocol').Run }>('run.create', {
    flowType: 'dev',
    project: Object.keys(configuration.sources.packs)[0],
    ticketOrPr: 'MANUAL-000001',
    mode: 'interactive',
    runner: 'codex',
  });
  assert.ok(created.run.sourceProvenance);
  assert.equal(created.run.sourceProvenance.lock.context.runId, created.run.id);
  assert.deepEqual(created.run.sourceProvenance.lock.entries, synced.locks[0].entries);
  evidence.runProvenance = created.run.sourceProvenance;
  await client.call('run.cancel', { runId: created.run.id });

  const project = Object.keys(configuration.sources.packs)[0];
  const context = await runtime.projectContext(project);
  await sourceCommand('hdiutil', [
    'detach',
    '-quiet',
    path.dirname(context.materialization.roots[context.pack.sourceId]),
  ]);
  const refusal = await client.call<SourcesSyncResult>('sources.sync', {
    ...request,
    operationId: 'proof-drift',
  });
  assert.ok(refusal.errors.length);
  evidence.drift = refusal;
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = (error as Error).message;
  throw error;
} finally {
  runtime.stopSourceReconciliation();
  const teardownErrors: string[] = [];
  try {
    for (const node of configuration.nodes) {
      try {
        const detach = `python3 - <<'PY'\nimport json,subprocess\nfrom pathlib import Path\nreceipts=Path(${JSON.stringify(path.join(node.home, 'sources/node/receipts'))})\nmounts={str(Path(root).parent) for record in receipts.glob('*.json') for root in json.loads(record.read_text())['roots'].values()}\nfor mount in mounts:\n subprocess.run(['hdiutil','detach','-quiet',mount],check=True)\nPY\n`;
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
    evidence.teardownErrors = teardownErrors;
    if (teardownErrors.length) evidence.result = 'FAIL';
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  if (teardownErrors.length) throw new Error(teardownErrors.join('; '));
}
console.log('Source fleet proof PASS');
