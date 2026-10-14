// Manual public-RPC proof against a disposable gateway and a real native worker.
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { NativeSessionClient, type NativeWorkerTarget } from '@farmslot/agent-runtime/native';
import { NativeProcessTree } from '@farmslot/agent-runtime/native/process-tree';
import { matchesProcess } from '@farmslot/agent-runtime/native/storage';
import { FLOW_STEPS, type NativeWorkerSessionBinding, type Run } from '@farmslot/protocol';

import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
import { shellQuote } from '../../../services/gateway/src/core/tmux.js';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
const interruption = new AbortController();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type ProofWorker = NativeWorkerSessionBinding & NativeWorkerTarget;
async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    interruption.signal.throwIfAborted();
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function stopTree(tree: NativeProcessTree) {
  const stopped = async () => {
    const deadline = Date.now() + 3_000;
    while (!tree.empty() && Date.now() < deadline) await pause(50);
    return tree.empty();
  };
  tree.stop();
  if (!(await stopped())) {
    tree.terminate();
    if (!(await stopped())) throw new Error('Owned proof process did not stop');
  }
}

if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/index.js');
} else {
  const scratch = await mkdtemp(path.join(tmpdir(), 'finalize-publication-proof-'));
  const root = path.join(scratch, 'root');
  const repo = path.join(root, 'checkout');
  const project = 'finalize-publication-proof';
  const runId = randomUUID();
  const slotId = `publication-proof-${randomUUID()}`;
  const out = path.resolve(
    process.env.FARMSLOT_FINALIZE_PROOF_OUT ?? 'temp/finalize-publication-proof',
    randomUUID(),
  );
  const native = new NativeSessionClient(path.join(scratch, 'native'));
  let worker: ProofWorker | undefined;
  let workerTree: NativeProcessTree | undefined;
  let gateway: ChildProcess | undefined;
  let proofFailure: unknown;
  let passed = false;
  const logs: string[] = [];
  const finish = path.join(scratch, 'finish-worker');
  const interrupt = () => interruption.abort(new Error('Proof interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await mkdir(out, { recursive: true });
    await execute('git', ['clone', '--quiet', '--shared', '--sparse', source, root]);
    await symlink(path.join(source, 'scripts'), path.join(root, 'scripts'), 'dir');
    await json(path.join(root, 'services/gateway/package.json'), {
      name: 'fixture',
      version: '0.0.0',
    });
    await mkdir(repo, { recursive: true });
    await execute('git', ['init', '--quiet', repo]);
    const wip = path.join(repo, 'uncommitted-proof.txt');
    await writeFile(wip, 'Retained uncommitted source/proof fixture\n');
    await mkdir(path.join(repo, 'tasks/fixture'), { recursive: true });
    const taskFile = path.join(root, 'projects', project, 'tasks/fixture/TASK.md');
    await mkdir(path.dirname(taskFile), { recursive: true });
    await writeFile(taskFile, '# Finalize publication guard fixture\n');
    await writeFile(
      path.join(repo, 'tasks/fixture/TASK.md'),
      '# Finalize publication guard fixture\n',
    );
    await json(path.join(root, 'projects', project, 'project.json'), {
      name: project,
      runtime_dir: 'tasks',
      task_dir: 'tasks',
      hooks: {},
    });
    await json(path.join(root, 'pool/local.json'), {
      schema_version: 2,
      machine: hostname(),
      host: 'localhost',
      ssh_user: userInfo().username,
      os: process.platform,
      project,
      platform: 'cli',
      slots: [
        {
          id: slotId,
          project,
          platform: 'cli',
          repo,
          session: slotId,
          enabled: true,
          mode: 'dispatch',
        },
      ],
    });
    await json(path.join(root, 'pool/status-local.json'), {
      slots: [{ slot: slotId, lifecycle: 'held', phase: 'occupied', current_run_id: runId }],
    });
    await json(path.join(repo, '.farm-status'), {
      lifecycle: 'held',
      phase: 'occupied',
      current_run_id: runId,
      slot_id: slotId,
    });
    const session = await native.ensureWorker(
      'test-automation',
      {
        sessionId: randomUUID(),
        runner: 'claude',
        cwd: repo,
        model: 'sonnet',
      },
      { leaseId: randomUUID(), safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
    );
    assert.ok(session.workerLeaseId);
    if (session.processPid) workerTree = new NativeProcessTree(session.processPid);
    const commandId = randomUUID();
    worker = {
      sessionId: session.id,
      generation: session.generation,
      leaseId: session.workerLeaseId,
      executionNodeId: session.executionNodeId,
      ownerPrincipalId: session.ownerPrincipalId,
      commandId,
      acceptedAt: new Date().toISOString(),
    };
    const waitScript = `const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(t);process.exit(0)}},50);setTimeout(()=>process.exit(2),120000).unref()`;
    const acceptance = await native.sendWorker(
      'test-automation',
      worker,
      commandId,
      `Run exactly one shell command: node -e ${shellQuote(waitScript)}. Then reply READY. Do not read or change any files.`,
    );
    const nativeState = async () =>
      (await native.readWorker('test-automation', worker!.sessionId, worker!.leaseId)).session
        .state;
    await waitFor(
      async () => (await nativeState()) === 'running',
      'real native repair remains active',
    );
    const now = new Date().toISOString();
    const run: Run = {
      id: runId,
      familyId: runId,
      parentRunId: null,
      familyRootTicketOrPr: 'PROOF-4129',
      lane: 'validation',
      variant: null,
      flowType: 'dev',
      mode: 'autonomous',
      status: 'fixing',
      project,
      ticketOrPr: 'PROOF-4129',
      slotId,
      branch: 'fixture/source',
      taskFile,
      transport: 'native',
      nativeOwnerPrincipalId: 'test-automation',
      steps: FLOW_STEPS.dev.map((name) => ({ name, status: 'done' })),
      decisions: [
        {
          id: 'continued-fix',
          type: 'engine_human_gate',
          title: 'Publication gate',
          description: '',
          actions: [],
          createdAt: now,
          resolvedAt: now,
          resolvedAction: 'continue-review-fix',
        },
      ],
      metrics: {
        nudgeCount: 0,
        model: 'sonnet',
        runner: 'claude',
        runnerSessionId: session.id,
        runnerSessionPath: null,
      },
      engineState: { generation: 0, publishGate: { publicationStatus: 'not_published' } },
      agentContexts: [
        {
          id: 'primary',
          role: 'primary',
          label: 'Primary fixture',
          status: 'complete',
          runId,
          slotId,
          taskFile: 'tasks/fixture/TASK.md',
          nativeSession: worker,
        },
        {
          id: 'review-fix',
          role: 'review-fix',
          label: 'Active repair fixture',
          status: 'working',
          runId,
          slotId,
          taskFile: 'tasks/fixture/TASK.md',
          nativeSession: worker,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await json(path.join(root, '.runs', `${runId}.json`), run);
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const home = path.join(scratch, 'home');
    const url = `ws://127.0.0.1:${port}`;
    testGatewayIdentity(home, url);
    const env = {
      ...process.env,
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: home,
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/capabilities.json'),
      FARMSLOT_GATEWAY: url,
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_NATIVE_STATE_DIR: native.root,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'test-automation',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
      FARMSLOT_DEMO_POOL: '0',
      NODE_TEST_CONTEXT: '1',
      TMUX: '',
      TMUX_TMPDIR: path.join(scratch, 'tmux'),
      TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
    };
    gateway = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve'],
      { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    gateway.stdout!.on('data', (data) => logs.push(String(data)));
    gateway.stderr!.on('data', (data) => logs.push(String(data)));
    await waitFor(async () => {
      if (gateway!.exitCode !== null) throw new Error('Fixture gateway exited during startup');
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    }, 'disposable gateway ready');
    const rpc = async <T,>(method: string, params: unknown): Promise<T> => {
      const result = await execute(
        process.execPath,
        [
          path.join(source, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: source, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return JSON.parse(result.stdout);
    };
    const current = async () => (await rpc<{ run: Run }>('run.get', { runId })).run;
    const checks: string[] = [];
    for (const stepName of ['finalize', 'ci-watch']) {
      await rpc('run.replayStep', { runId, stepName });
      await waitFor(
        async () => (await current()).status === 'failed',
        `${stepName} refuses unapproved publication`,
      );
      const after = await current();
      assert.match(after.error ?? '', /requires approve-publish/);
      assert.equal(after.engineState?.publishGate?.publicationStatus, 'not_published');
      assert.equal(after.slotId, slotId);
      assert.equal(
        after.agentContexts?.find((context) => context.id === 'review-fix')?.status,
        'working',
      );
      assert.ok(
        after.steps.find((step) => step.name === 'finalize')?.outputs?.gatePrerequisiteRefusal,
      );
      assert.equal(await nativeState(), 'running');
      assert.equal(await readFile(wip, 'utf8'), 'Retained uncommitted source/proof fixture\n');
      await json(path.join(out, `${stepName}-refusal.json`), after);
      checks.push(
        `${stepName}: public replay retains real active repair, uncommitted work and slot without DONE/publication`,
      );
    }
    await json(path.join(out, 'receipt.json'), {
      head: (await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim(),
      runId,
      slotId,
      acceptance,
      checks,
      originalRunsChanged: false,
    });
    await writeFile(finish, 'finish');
    passed = true;
  } catch (error) {
    proofFailure = error;
    await json(path.join(out, 'failure.json'), {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    const failures: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await clean(async () => {
      if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
        gateway.kill('SIGTERM');
        await Promise.race([once(gateway, 'exit'), pause(5_000)]);
        if (gateway.exitCode === null && gateway.signalCode === null) {
          gateway.kill('SIGKILL');
          await once(gateway, 'exit');
        }
      }
    });
    await clean(() => writeFile(path.join(out, 'gateway.log'), logs.join('')));
    if (worker) await clean(() => native.closeWorker('test-automation', worker!));
    await clean(async () => {
      let host: unknown;
      try {
        host = JSON.parse(await readFile(path.join(native.root, 'host.json'), 'utf8'));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
      if (
        host &&
        typeof host === 'object' &&
        'pid' in host &&
        typeof host.pid === 'number' &&
        matchesProcess(host.pid, native.root)
      )
        await stopTree(new NativeProcessTree(host.pid));
    });
    if (workerTree) await clean(() => stopTree(workerTree!));
    if (!failures.length) await clean(() => rm(scratch, { recursive: true, force: true }));
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await json(path.join(out, 'cleanup.json'), {
      stopped: !failures.length,
      fixtureRemoved: !failures.length,
      failures: failures.map((error) => (error instanceof Error ? error.message : String(error))),
    });
    if (failures.length)
      throw new AggregateError(
        proofFailure ? [proofFailure, ...failures] : failures,
        'Fixture cleanup failed',
      );
  }
  if (passed) process.stdout.write(JSON.stringify({ pass: true, out }) + '\n');
}
