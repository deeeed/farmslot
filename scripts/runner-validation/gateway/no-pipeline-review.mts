// Live proof on an isolated gateway: an artifact-only dev run created through the CLI keeps its
// pipeline review off, dispatch.preview echoes it, and run.create and dispatch.preview refuse it on
// a flow that pushes, without artifact-only, and for an unknown value. Engine start is disabled, so
// no worker or reviewer launches; the REVIEW step's recorded skip is the unit test's part.
import {
  testGatewayIdentity,
  testGatewayProfile,
} from '../../lib/test-gateway-identity-source.mjs';
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GatewayClient,
  GatewayConnectionError,
  type GatewayConnection,
} from '../../../packages/cli/src/gateway-client.js';
import type { Run, RunCreateResult } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'farmslot-no-pipeline-review-'));
// The gateway's tmux calls reach only this proof's (unstarted) server.
const tmuxDir = await mkdtemp('/tmp/npr-');
const log = path.join(fixture, 'gateway.log');
// Outside the fixture root, which the gateway refuses as a shared fleet status store.
const statusFile = path.join(fixture, 'status', 'farm-status.json');
let token = '';
let gateway: ChildProcess | undefined;
let connection: GatewayConnection | undefined;

let cleaning: Promise<void> | undefined;
/** Stop the gateway's process group and remove the proof's files: once, on every exit path. */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    connection?.close();
    if (gateway && gateway.exitCode === null && gateway.pid) {
      const exited = once(gateway, 'exit');
      process.kill(-gateway.pid, 'SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      clearTimeout(timer);
      if (!stopped) {
        process.kill(-gateway.pid, 'SIGKILL');
        await exited;
      }
    }
    await rm(fixture, { recursive: true, force: true });
    await rm(tmuxDir, { recursive: true, force: true });
  })();
  return cleaning;
}
// A cancelled or timed-out recipe signals this process; the detached gateway is in its own group.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    process.stderr.write(`${signal}: stopping the isolated gateway\n`);
    void cleanup().finally(() => process.exit(1));
  });

try {
  // FARMSLOT_ROOT must be a Farmslot checkout: a shared clone with this checkout's sources.
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
  for (const name of ['scripts', 'services', 'packages'])
    await symlink(path.join(root, name), path.join(fixture, name));
  await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated pipeline review validation\n');
  token = testGatewayIdentity(path.join(fixture, 'home'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  async function json(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  }
  await json(path.join(fixture, 'projects', 'proof', 'project.json'), {
    name: 'proof',
    repo_url: 'https://github.com/example/app.git',
    ci: { repo: 'example/app' },
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  });
  // run.create renders the project's dev worker template; the example pack's is enough here.
  await mkdir(path.join(fixture, 'projects', 'proof', 'templates', 'worker'), { recursive: true });
  await writeFile(
    path.join(fixture, 'projects', 'proof', 'templates', 'worker', 'dev.md'),
    await readFile(
      path.join(root, 'packs/example-app/projects/example-app-farm/templates/worker/dev.md'),
    ),
  );
  await mkdir(path.join(fixture, 'repo'));
  await json(path.join(fixture, 'pool', 'proof-host.json'), {
    machine: 'proof-host',
    host: 'localhost',
    project: 'proof',
    platform: 'cli',
    slots: [
      {
        id: 'proof-1',
        enabled: true,
        repo: path.join(fixture, 'repo'),
        session: 'npr-proof',
        resources: {},
      },
    ],
  });
  await json(statusFile, {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'proof-1',
        machine: 'proof-host',
        project: 'proof',
        platform: 'cli',
        enabled: true,
        lifecycle: 'ready',
        agent: 'idle',
        branch: 'main',
        runner: 'claude',
        model: 'sonnet',
      },
    ],
  });

  const output = openSync(log, 'w', 0o600);
  testGatewayProfile(path.join(fixture, 'home'), `ws://127.0.0.1:${port}`, token);
  const env = {
    ...process.env,
    TMUX: '',
    TMUX_TMPDIR: tmuxDir,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: path.join(fixture, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    FARMSLOT_GATEWAY_PROFILE: 'proof',
  };
  gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', output, output],
    env: {
      ...env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      FARMSLOT_TEST_STATUS_FILE: statusFile,
      FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'test-automation',
    },
  });
  closeSync(output);

  /** The checkout-local CLI against the isolated gateway; a refusal returns its error text. */
  function cli(args: string[]): { ok: true; data: any } | { ok: false; error: string } {
    try {
      const raw = execFileSync(
        'yarn',
        [
          'workspace',
          '@farmslot/cli',
          'farmslot',
          '--url',
          `ws://127.0.0.1:${port}`,
          '--json',
          ...args,
        ],
        { cwd: root, encoding: 'utf8', timeout: 60_000, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const result = JSON.parse(raw);
      return result.status === 'ok' ? { ok: true, data: result.data } : { ok: false, error: raw };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return { ok: false, error: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
    }
  }

  const evidence: Record<string, unknown> = {};
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 15000,
    credential: { token },
  });
  const deadline = Date.now() + 60_000;
  while (!connection && Date.now() < deadline) {
    if (gateway.exitCode !== null)
      throw new Error(`Isolated gateway exited with ${gateway.exitCode}`);
    try {
      connection = await client.connect();
    } catch (error) {
      if (!(error instanceof GatewayConnectionError)) throw error;
      await delay(200);
    }
  }
  assert(connection, 'Isolated gateway did not become ready');
  const dev = ['--project', 'proof', '--flow-type', 'dev', '--ticket', 'no pipeline review proof'];

  const preview = cli(['dispatch', 'preview', ...dev, '--no-pipeline-review']);
  assert(preview.ok, `preview: ${!preview.ok && preview.error}`);
  assert.deepEqual(preview.data.preview.pipelineReview, {
    policy: 'none',
    reason: 'Pipeline review is off for this artifact-only run (pipelineReview none).',
  });
  evidence.preview = preview.data.preview.pipelineReview;

  const created = cli(['run', 'create', ...dev, '--no-pipeline-review']);
  assert(created.ok, `run create: ${!created.ok && created.error}`);
  const { run } = await connection.call<{ run: Run }>('run.get', { runId: created.data.run.id });
  assert.equal(run.pipelineReview, 'none');
  assert.equal(run.completionPolicy, 'artifact-only');
  evidence.readback = {
    runId: run.id,
    pipelineReview: run.pipelineReview,
    completionPolicy: run.completionPolicy,
  };
  await connection.call('run.cancel', { runId: run.id });

  const before = (await connection.call<{ runs: Run[] }>('run.list')).runs.length;
  const refusals: Record<string, string> = {};
  for (const [label, params, expected] of [
    [
      'update-branch',
      { flowType: 'update-branch', ticketOrPr: 'example/app#7', completionPolicy: 'artifact-only' },
      /only for dev and fix-bug runs; update-branch runs/,
    ],
    [
      'no artifact-only',
      { flowType: 'dev', ticketOrPr: 'proof refusal' },
      /only for artifact-only runs/,
    ],
    [
      'unknown value',
      {
        flowType: 'dev',
        ticketOrPr: 'proof refusal',
        completionPolicy: 'artifact-only',
        pipelineReview: 'off',
      },
      /must be 'default' or 'none', not "off"/,
    ],
  ] as const) {
    for (const method of ['dispatch.preview', 'run.create'] as const) {
      const refused = await connection
        .call(method, { project: 'proof', pipelineReview: 'none', ...params })
        .then(
          () => null,
          (error: Error) => error.message,
        );
      assert(refused && expected.test(refused), `${method} ${label}: ${refused ?? 'accepted'}`);
      refusals[`${method} ${label}`] = refused;
    }
  }
  assert.equal(
    (await connection.call<{ runs: Run[] }>('run.list')).runs.length,
    before,
    'a refusal creates nothing',
  );
  evidence.refusals = refusals;
  // The CLI flag on the dispatch preview of a flow that pushes is refused the same way.
  const cliRefusal = cli([
    'dispatch',
    'preview',
    '--project',
    'proof',
    '--flow-type',
    'update-branch',
    '--ticket',
    'example/app#7',
    '--no-pipeline-review',
  ]);
  assert(
    !cliRefusal.ok && /only for dev and fix-bug runs/.test(cliRefusal.error),
    'CLI update-branch preview',
  );
  console.log(
    JSON.stringify(
      {
        pass: true,
        endpoint: 'isolated gateway, checkout-local CLI and RPC',
        engineStartDisabled: true,
        ...evidence,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const details = (await readFile(log, 'utf8'))
    .replaceAll(token, '[redacted]')
    .split('\n')
    .slice(-20)
    .join('\n');
  throw new Error(`${String(error)}\n${details}`, { cause: error });
} finally {
  await cleanup();
}
