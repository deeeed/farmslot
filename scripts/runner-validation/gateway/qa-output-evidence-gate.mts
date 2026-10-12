// Manual public-RPC regression proof from a retained QA receipt. Originals are read-only.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NativeSessionClient, type NativeWorkerTarget } from '@farmslot/agent-runtime/native';
import { matchesProcess } from '@farmslot/agent-runtime/native/storage';
import type { NativeWorkerSessionBinding, Run } from '@farmslot/protocol';

const source = fileURLToPath(new URL('../../../', import.meta.url));
type ProofWorker = NativeWorkerSessionBinding & NativeWorkerTarget;
const json = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), pause(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/index.js');
} else {
  assert.ok(
    process.env.FARMSLOT_QA_OUTPUT_PROOF_INPUT,
    'Provide a JSON receipt with runSnapshot, taskDir and repo paths.',
  );
  const input = JSON.parse(readFileSync(process.env.FARMSLOT_QA_OUTPUT_PROOF_INPUT, 'utf8')) as {
    runSnapshot: string;
    taskDir: string;
    repo: string;
  };
  const snapshot = JSON.parse(readFileSync(input.runSnapshot, 'utf8'));
  const original: Run = snapshot.run ?? snapshot;
  assert.equal(original.flowType, 'qa');
  assert.equal(original.completionPolicy, 'artifact-only');
  const scratch = mkdtempSync(path.join(tmpdir(), 'qa-output-gate-proof-'));
  const root = path.join(scratch, 'root');
  const repo = path.join(root, 'checkout');
  const project = 'qa-output-gate-proof';
  const slotId = `qa-output-${randomUUID()}`;
  const taskRelative = 'qa/retained';
  const workerDir = path.join(repo, 'tasks', taskRelative);
  const retained = path.join(root, 'projects', project, 'tasks', taskRelative);
  const out = path.resolve(
    process.env.FARMSLOT_QA_OUTPUT_PROOF_OUT ?? 'temp/qa-output-gate',
    randomUUID(),
  );
  const native = new NativeSessionClient(path.join(scratch, 'native'));
  const sourceFiles = [
    'services/gateway/src/run-engine/gate-prerequisites.ts',
    'services/gateway/src/run-engine/recorded-evidence-sources.ts',
    'services/gateway/src/run-completion/output.ts',
    'services/gateway/src/run-completion/artifact-mirror.ts',
    'services/gateway/src/qa/completion.ts',
    'scripts/runner-validation/gateway/qa-output-evidence-gate.mts',
  ];
  const hashes = Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(source, file)))
        .digest('hex'),
    ]),
  );
  let gateway: ChildProcess | undefined;
  let binding: ProofWorker | undefined;
  let env = { ...process.env };
  const logs: string[] = [];
  const checks: string[] = [];
  const rpc = <Response = unknown,>(method: string, params: unknown): Response =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(source, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: source, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      ),
    );
  const readRun = (): Run => rpc<{ run: Run }>('run.get', { runId: original.id }).run;
  const replay = async () => {
    rpc('run.replayStep', { runId: original.id, stepName: 'complete' });
    await waitFor(
      () => readRun().steps.some((step) => step.name === 'complete' && step.status === 'failed'),
      'completion guard reaches its retained result',
    );
    const result = readRun();
    json(path.join(out, `run-${checks.length}.json`), result);
    return result;
  };
  const barrier = 'QA_OUTPUT_GATE_PROOF_PASSED';
  try {
    mkdirSync(out, { recursive: true });
    execFileSync('git', ['clone', '--quiet', '--shared', '--sparse', source, root]);
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', input.repo, repo]);
    const qaResult = JSON.parse(
      readFileSync(path.join(input.taskDir, 'artifacts/qa-result.json'), 'utf8'),
    );
    execFileSync('git', ['checkout', '--quiet', '--detach', qaResult.source.headSha], {
      cwd: repo,
    });
    cpSync(input.taskDir, workerDir, { recursive: true });
    cpSync(input.taskDir, retained, { recursive: true });
    symlinkSync(path.join(source, 'scripts'), path.join(root, 'scripts'), 'dir');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable retained QA regression\n');
    json(path.join(root, 'services/gateway/package.json'), { name: 'fixture', version: '0.0.0' });
    json(path.join(root, 'projects', project, 'project.json'), {
      name: project,
      runtime_dir: 'tasks',
      task_dir: 'tasks',
      hooks: {},
    });
    json(path.join(root, 'pool/local.json'), {
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
    json(path.join(root, 'pool/status-local.json'), {
      slots: [{ slot: slotId, lifecycle: 'held', phase: 'occupied', current_run_id: original.id }],
    });
    json(path.join(repo, '.farm-status'), {
      lifecycle: 'held',
      phase: 'occupied',
      current_run_id: original.id,
      slot_id: slotId,
    });
    const session = await native.ensureWorker(
      'legacy-env',
      { sessionId: randomUUID(), runner: 'claude', cwd: repo, model: 'sonnet' },
      { leaseId: randomUUID(), safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
    );
    const commandId = randomUUID();
    const worker: ProofWorker = {
      sessionId: session.id,
      generation: session.generation,
      leaseId: session.workerLeaseId!,
      executionNodeId: session.executionNodeId,
      ownerPrincipalId: session.ownerPrincipalId,
      commandId,
      acceptedAt: new Date().toISOString(),
    };
    binding = worker;
    await native.sendWorker(
      'legacy-env',
      worker,
      commandId,
      'Reply READY. Do not use tools or change files.',
    );
    await waitFor(
      async () =>
        (await native.readWorker('legacy-env', binding!.sessionId, binding!.leaseId)).session
          .state === 'idle',
      'real native turn becomes idle',
    );
    const run: Run = {
      ...original,
      project,
      slotId,
      ticketOrPr: 'QA-101',
      taskFile: path.join(retained, 'TASK.md'),
      nativeOwnerPrincipalId: 'legacy-env',
      transport: 'native',
      status: 'blocked',
      agentContexts: [
        {
          id: 'primary',
          role: 'primary',
          label: 'Retained QA worker',
          runId: original.id,
          slotId,
          status: 'complete',
          runner: 'claude',
          model: 'sonnet',
          taskFile: `tasks/${taskRelative}/TASK.md`,
          nativeSession: worker,
        },
      ],
      engineState: { ...original.engineState, generation: 0 },
    };
    json(path.join(root, '.runs', `${run.id}.json`), run);
    const loader = path.join(scratch, 'proof-loader.mjs');
    const register = path.join(scratch, 'proof-register.mjs');
    // Stop only after the unmodified production gate and QA completion guards
    // pass. This proves admission without publishing or releasing resources.
    const negative = process.env.FARMSLOT_QA_OUTPUT_NEGATIVE ?? '';
    assert.ok(['', 'reader', 'applicability', 'binding', 'mirror'].includes(negative));
    json(path.join(out, 'input-receipt.json'), {
      originalRunId: original.id,
      sourceHead: qaResult.source.headSha,
      hashes,
      negative,
    });
    writeFileSync(
      loader,
      `import {writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
      export async function load(url, context, nextLoad) {
      const result = await nextLoad(url, context);
      if (url.endsWith('/run-engine/post-dispatch-steps.ts')) {
        const text = String(result.source);
        const target = "if (current.flowType === 'qa') await assertQaCompletion(current);";
        if (!text.includes(target)) throw new Error('Completion proof barrier target changed');
        return {...result, source: text.replace(target, target + " throw new Error('${barrier}');")};
      }
      if (${JSON.stringify(negative)} !== '' && (url.endsWith('/run-engine/gate-prerequisites.ts') ||
          url.endsWith('/run-completion/artifact-mirror.ts'))) {
        const text = String(result.source);
        const mode = ${JSON.stringify(negative)};
        if ((mode === 'mirror') !== url.endsWith('/run-completion/artifact-mirror.ts')) return result;
        const target = mode === 'reader' ? 'if (preparedPackage || !isArtifactOnlyRun(run))' :
          mode === 'mirror' ? "run.flowType === 'qa' &&" : mode === 'binding' ?
          'acceptance.ledger?.schemaVersion === 1' : 'return applicable.map';
        const replacement = mode === 'reader' ? 'if (true)' : mode === 'mirror' ? 'false &&' :
          mode === 'binding' ? 'false' : 'return sources.map';
        if (!text.includes(target)) throw new Error('Negative-control target changed');
        const changed = text.replace(target, replacement);
        writeFileSync(${JSON.stringify(path.join(out, 'source-mutation.json'))}, JSON.stringify({mode,url,
          beforeHash:createHash('sha256').update(text).digest('hex'),
          loadedHash:createHash('sha256').update(changed).digest('hex')}));
        return {...result, source: changed};
      }
      return result;
    }\n`,
    );
    writeFileSync(
      register,
      `import {register} from 'node:module'; register(${JSON.stringify(loader)}, import.meta.url);\n`,
    );
    const port = await freePort();
    mkdirSync(path.join(scratch, 'tmux'));
    env = {
      ...env,
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(scratch, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/capabilities.json'),
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
      FARMSLOT_GATEWAY_TOKEN: randomUUID(),
      FARMSLOT_GATEWAY_PASSWORD: '',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_NATIVE_STATE_DIR: native.root,
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
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
      ['--import', 'tsx', '--import', register, fileURLToPath(import.meta.url), 'serve'],
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
    }, 'production gateway startup');
    const stale = await replay();
    assert.match(
      stale.error ?? '',
      negative === 'reader' ? /A prepared evidence package/ : /Run output changed/,
    );
    checks.push(
      'original captured inventory refuses changed output without fabricating a publication package',
    );
    assert.equal(rpc<{ ok: boolean }>('run.refreshMirror', { runId: run.id }).ok, true);
    const refreshed = readRun();
    assert.notEqual(refreshed.output?.manifestDigest, original.output?.manifestDigest);
    assert.equal(refreshed.decisions.at(-1)?.payload?.kind, 'output-review');
    checks.push(
      'public refreshMirror captures current retained output with a new output-review identity',
    );
    const ready = await replay();
    assert.equal(
      ready.error,
      barrier,
      'real gate and canonical QA checker must pass before the teardown barrier',
    );
    checks.push(
      'headless task state ACs and canonical QA cases pass with retained failed attempt preserved',
    );
    const report = path.join(retained, ready.output!.reportPath!);
    writeFileSync(report, readFileSync(report, 'utf8') + '\n');
    assert.match((await replay()).error ?? '', /Run output changed/);
    checks.push('changed report bytes refuse admission');
    assert.equal(rpc<{ ok: boolean }>('run.refreshMirror', { runId: run.id }).ok, true);
    assert.equal((await replay()).error, barrier);
    checks.push('supported mirror recapture restores checked admission');
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      qaResult.source.headSha,
    );
    json(path.join(out, 'receipt.json'), {
      hashes,
      checks,
      originalRunId: original.id,
      sourceHead: qaResult.source.headSha,
      limits: [
        'Copied retained QA only. The real run/task/evidence are unchanged. Real public RPC, frozen SDK reader, canonical QA checker and native idle authority. A load barrier throws after both completion guards pass, before publication/teardown. No UI or recording claim; HUD not applicable.',
      ],
    });
    process.stdout.write(JSON.stringify({ pass: true, out }) + '\n');
  } finally {
    const failures: unknown[] = [];
    try {
      await stop(gateway);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (binding) await native.closeWorker('legacy-env', binding);
      const hostFile = path.join(native.root, 'host.json');
      if (existsSync(hostFile)) {
        const host = JSON.parse(readFileSync(hostFile, 'utf8'));
        if (matchesProcess(host.pid, native.root)) process.kill(host.pid, 'SIGTERM');
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      writeFileSync(path.join(out, 'gateway.log'), logs.join(''));
      rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'QA output proof cleanup failed');
  }
}
