// Manual public-RPC proof over copied retained task bytes. Originals stay read-only.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run } from '@farmslot/protocol';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const json = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function hashes(root: string) {
  const result: Record<string, string> = {};
  for (const file of (await fs.readdir(root, { recursive: true })).sort()) {
    if (!(await fs.stat(path.join(root, file))).isFile()) continue;
    result[file] = createHash('sha256')
      .update(await fs.readFile(path.join(root, file)))
      .digest('hex');
  }
  return result;
}

if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/runtime/mock-pty.test-support.js');
  await import('../../../services/gateway/src/index.js');
} else {
  assert.ok(process.env.FARMSLOT_WORKER_CONTRACT_PROOF_INPUT, 'Provide a retained-task receipt.');
  const input = JSON.parse(
    await fs.readFile(process.env.FARMSLOT_WORKER_CONTRACT_PROOF_INPUT, 'utf8'),
  ) as {
    runSnapshot: string;
    workerTask: string;
    dispatchTask: string;
    repo: string;
    checker?: string;
  };
  const snapshot = JSON.parse(await fs.readFile(input.runSnapshot, 'utf8')) as { run: Run };
  const original = snapshot.run;
  const before = await hashes(input.workerTask);
  const dispatchBefore = await hashes(input.dispatchTask);
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'worker-contract-proof-'));
  const root = path.join(scratch, 'root');
  const repo = path.join(root, 'checkout');
  const project = 'worker-contract-proof',
    slotId = 'worker-contract-proof-slot';
  const taskRel = 'retained';
  const workerTask = path.join(repo, 'tasks', taskRel);
  const dispatchTask = path.join(root, 'projects', project, 'tasks', taskRel);
  const out = path.resolve(
    process.env.FARMSLOT_WORKER_CONTRACT_PROOF_OUT ?? 'temp/worker-contract-proof',
  );
  let child: ChildProcess | undefined;
  const checks: string[] = [];
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FARMSLOT_|GATEWAY_|TMUX)/u.test(key)) delete env[key];
  Object.assign(env, {
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_LOCAL_HEALTH_POLL: '0',
    NODE_TEST_CONTEXT: '1',
    GATEWAY_HOST: '127.0.0.1',
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  });
  const checker =
    input.checker ??
    path.join(source, 'packages/agent-runtime/scripts/check-task-artifact-contract.mjs');
  const check = () =>
    spawnSync(
      process.execPath,
      [
        checker,
        workerTask,
        '--contract',
        path.join(workerTask, 'inputs/worker-terminal-contract.json'),
        '--terminal',
        'complete',
      ],
      { cwd: repo, encoding: 'utf8', timeout: 60_000 },
    );
  try {
    for (const name of [
      'scripts',
      'services',
      'packages',
      'node_modules',
      'schemas',
      'CLAUDE.md',
      'package.json',
    ]) {
      await fs.mkdir(root, { recursive: true });
      await fs.symlink(path.join(source, name), path.join(root, name));
    }
    execFileSync('git', [
      'clone',
      '--quiet',
      '--shared',
      '--bare',
      source,
      path.join(root, '.git'),
    ]);
    execFileSync('git', ['--git-dir', path.join(root, '.git'), 'config', 'core.bare', 'false']);
    const productHead = execFileSync('git', ['-C', input.repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', input.repo, repo]);
    execFileSync('git', ['-C', repo, 'checkout', '--quiet', '--detach', productHead]);
    await fs.cp(input.workerTask, workerTask, { recursive: true });
    await fs.cp(input.dispatchTask, dispatchTask, { recursive: true });
    await json(path.join(root, 'projects', project, 'project.json'), {
      name: project,
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
          session: 'proof',
          enabled: true,
          mode: 'dispatch',
        },
      ],
    });
    const frozen = await fs.readFile(
      path.join(dispatchTask, 'inputs/worker-terminal-contract.json'),
      'utf8',
    );
    assert.equal(JSON.parse(frozen).claimReviewGate, true);
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(workerTask, 'inputs/worker-terminal-contract.json'), 'utf8'),
      ).claimReviewGate,
      undefined,
    );
    const handoff = JSON.parse(
      await fs.readFile(path.join(dispatchTask, 'inputs/handoff.json'), 'utf8'),
    );
    const run: Run = {
      ...original,
      id: randomUUID(),
      project,
      status: 'failed',
      transport: undefined,
      taskFile: path.join(dispatchTask, 'TASK.md'),
      slotId,
      agentContexts: [],
      decisions: [],
      engineState: { generation: 0 },
      recoveryAttempts: [],
    };
    await json(path.join(dispatchTask, 'inputs/handoff.json'), {
      ...handoff,
      attemptId: run.id,
      project,
    });
    await json(path.join(root, 'runs', `${run.id}.json`), run);
    const artifactsBefore = await hashes(path.join(workerTask, 'artifacts'));
    const failed = check();
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr + failed.stdout, /awaiting-review/);
    checks.push('Copied retained task reproduces the visual completion refusal before recovery.');

    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    env.GATEWAY_PORT = String(address.port);
    await fs.mkdir(out, { recursive: true });
    const log = await fs.open(path.join(out, 'gateway.log'), 'w');
    child = spawn(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        'serve',
      ],
      { cwd: source, env, stdio: ['ignore', log.fd, log.fd] },
    );
    await log.close();
    const { GatewayClient, GatewayConnectionError } =
      await import('../../../packages/cli/src/gateway-client.js');
    const client = new GatewayClient({ url: `ws://127.0.0.1:${address.port}`, timeout: 30_000 });
    const deadline = Date.now() + 90_000;
    while (true) {
      try {
        await client.call('run.get', { runId: run.id });
        break;
      } catch (error) {
        if (
          !(error instanceof GatewayConnectionError) ||
          Date.now() >= deadline ||
          child.exitCode !== null
        )
          throw error;
        await pause(100);
      }
    }
    await client.call('run.replayStep', {
      runId: run.id,
      stepName: 'complete',
      triggeredBy: 'operator',
    });
    assert.equal(
      await fs.readFile(path.join(workerTask, 'inputs/worker-terminal-contract.json'), 'utf8'),
      frozen,
    );
    const passed = check();
    assert.equal(passed.status, 0, passed.stderr + passed.stdout);
    checks.push(
      'Public retained replay restores exact frozen dispatch bytes; the public checker then admits pending visual claims.',
    );
    assert.deepEqual(await hashes(path.join(workerTask, 'artifacts')), artifactsBefore);
    checks.push(
      'Every retained package, registration and task-projection artifact stays byte-identical.',
    );
    await json(path.join(dispatchTask, 'inputs/handoff.json'), {
      ...handoff,
      attemptId: 'wrong-run',
      project,
    });
    await assert.rejects(
      client.call('run.replayStep', { runId: run.id, stepName: 'complete' }),
      /does not belong to this run/,
    );
    checks.push('A foreign dispatch identity refuses recovery through the same RPC.');
    await fs.writeFile(
      path.join(workerTask, 'inputs/worker-terminal-contract.json'),
      frozen.replace('"claimReviewGate": true', '"claimReviewGate": false'),
    );
    const noGate = check();
    assert.equal(noGate.status, 1);
    assert.match(noGate.stderr + noGate.stdout, /awaiting-review/);
    checks.push('A contract without review authority still refuses unresolved visual claims.');
    assert.deepEqual(await hashes(input.workerTask), before);
    assert.deepEqual(await hashes(input.dispatchTask), dispatchBefore);
    await json(path.join(out, 'receipt.json'), {
      status: 'pass',
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
      }).trim(),
      originalRunId: original.id,
      proofRunId: run.id,
      checks,
      isolation:
        'Copied retained tasks, isolated Run store and pool; engine launch disabled and PTY forbidden. No original run/task/source/registration/claim changes.',
    });
    console.log(JSON.stringify({ status: 'pass', checks }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([done, pause(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await done;
      }
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
