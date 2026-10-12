/** Manual ADR-069 fleet proof through isolated services and owned proof slots. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isTerminalRunStatus } from '@farmslot/protocol';

import type {
  SourceConfiguration,
  SourceMaterialization,
  SourcesSyncResult,
  Run,
  NativeSessionReadResult,
} from '@farmslot/protocol';

interface ProofNode {
  id: string;
  ssh?: string;
  bundle: string;
  home: string;
  serviceNodeModules: string;
  forwardPort?: number;
  codexPath?: string;
  platform?: string;
  resources?: Record<string, Record<string, string | number | boolean>>;
}
interface ProofConfiguration {
  sources: SourceConfiguration;
  nodes: ProofNode[];
  consumerProject?: string;
  workerModel?: string;
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
      ...(configuration.workerModel ? { FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: admin.id } : {}),
      GATEWAY_URL: `ws://127.0.0.1:${node.ssh ? node.forwardPort : port}`,
      TSX_TSCONFIG_PATH: path.join(node.bundle, 'tsconfig.json'),
      SCREEN_CONTROL_SOCKET: path.join(node.home, 'screen.sock'),
      TMUX_TMPDIR: path.join(node.home, 'no-tmux'),
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
          host: node.ssh ? node.ssh.split('@').at(-1) : 'localhost',
          ssh_user: node.ssh?.split('@')[0] ?? process.env.USER,
          codex_path: node.codexPath,
          os: 'darwin',
          platform: node.platform ?? 'cli',
          project,
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
      const recovery = await client.call<SourcesSyncResult>('sources.sync', {
        ...request,
        operationId: `proof-remount-${node.id}`,
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
  if (configuration.consumerProject) {
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
      let result = await read();
      while (result.exitCode !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = await read();
      }
      assert.equal(result.exitCode, 0);
      const records = JSON.parse(result.stdout) as Array<{ nodeId: string; lockDigest: string }>;
      assert.ok(
        records.every(
          (record) => record.nodeId === node.id && record.lockDigest === synced.locks[0].digest,
        ),
      );
      consumers.push({ nodeId: node.id, records });
    }
    evidence.consumers = consumers;
    await writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  if (configuration.workerModel) {
    const workers = [];
    const workerProject =
      configuration.consumerProject ?? Object.keys(configuration.sources.packs)[0];
    const program =
      "const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const receipt=JSON.parse(fs.readFileSync(process.env.FARMSLOT_SOURCE_RECEIPT,'utf8'));assert.equal(receipt.lock.digest,process.env.FARMSLOT_SOURCE_LOCK_DIGEST);const id=process.env.FARMSLOT_SOURCE_PACK_ID;const root=path.join(receipt.roots[id],process.env.FARMSLOT_SOURCE_PACK_ENTRY);assert.ok(JSON.parse(fs.readFileSync(path.join(root,'project.json'),'utf8')).name);fs.writeFileSync('source-worker.json',JSON.stringify({nodeId:receipt.receipt.nodeId,lockDigest:receipt.lock.digest,commits:receipt.receipt.sources.map(source=>source.commit)}))";
    const { writeNativeFixtureTask } = await import('../runner-validation/lib/native-task.mjs');
    for (const node of configuration.nodes) {
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
      const cleared = (await sendNodeRequest(connection, 'exec', {
        argv: ['node', '-e', "require('node:fs').unlinkSync('source-worker.json')"],
        cwd: path.join(node.home, 'source-proof-worktree'),
        timeout: 5_000,
      })) as { exitCode: number };
      assert.equal(cleared.exitCode, 0);
      const second = await awaitWorker(await make('retained', first.run));
      assert.equal(second.binding.sessionId, first.binding.sessionId);
      assert.equal(second.session.nativeSessionId, first.session.nativeSessionId);
      assert.equal(second.binding.launchDigest, first.binding.launchDigest);
      assert.notEqual(second.binding.leaseId, first.binding.leaseId);
      assert.notEqual(
        second.run.sourceProvenance!.lock.digest,
        first.run.sourceProvenance!.lock.digest,
      );
      assert.equal(
        second.run.sourceProvenance!.workerLock.digest,
        first.run.sourceProvenance!.workerLock.digest,
      );
      const templates = await runtime.withRunSources(second.run, async () => {
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
          second.run.id,
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
          runId: second.run.id,
          lockDigest: second.run.sourceProvenance!.lock.digest,
          records,
          rendered: true,
        };
      });
      workers.push({ nodeId: node.id, first, second, templates });
      evidence.workers = workers;
      await writeFile(path.join(output, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n');
      await client.call('run.cancel', { runId: second.run.id });
    }
    evidence.workers = workers;
  }
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
  const mount = path.dirname(context.materialization.roots[context.pack.sourceId]);
  await sourceCommand('hdiutil', ['detach', '-quiet', mount]);
  const remount = await client.call<SourcesSyncResult>('sources.sync', {
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
  throw error;
} finally {
  runtime.stopSourceReconciliation();
  const teardownErrors: string[] = [];
  try {
    for (const runId of proofRuns) {
      try {
        const current = (await client.call<{ run: Run }>('run.get', { runId })).run;
        if (!isTerminalRunStatus(current.status)) await client.call('run.cancel', { runId });
      } catch (error) {
        teardownErrors.push(`${runId}: ${(error as Error).message}`);
      }
    }
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
