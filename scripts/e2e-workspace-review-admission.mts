#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
  GatewayRpcError,
  type GatewayConnection,
} from '../packages/cli/src/gateway-client.js';
import type {
  DispatchPreviewResult,
  DispatchQueueListResult,
} from '../packages/protocol/src/index.js';
import {
  createRecipeRunner,
  createStandardCoreAdapters,
} from '../packages/recipe-harness/src/index.js';

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
      name: 'Workspace review admission validation',
    },
  });
  const result = await runner.run({
    recipeDocument: JSON.parse(
      await readFile(
        path.join(root, 'docs/examples/recipes/farmslot/workspace-review-admission.recipe.json'),
        'utf8',
      ),
    ),
    artifactsDir: path.resolve(
      root,
      process.argv[3] ?? `temp/workspace-review-admission/${Date.now()}`,
    ),
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'Workspace review admission validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
assert(
  ['preview', 'rejections', 'missing-owner'].includes(scenario),
  'Expected preview, rejections or missing-owner',
);
const fixture = await mkdtemp(path.join(tmpdir(), 'farmslot-workspace-admission-'));
execFileSync('git', ['clone', '--shared', '--no-checkout', root, fixture], { stdio: 'pipe' });
const log = path.join(fixture, 'gateway.log');
const token = randomBytes(32).toString('hex');
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
for (const name of ['scripts', 'services', 'packages'])
  await symlink(path.join(root, name), path.join(fixture, name));
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Isolated workspace admission validation\n');
const project = path.join(fixture, 'projects', 'review');
await mkdir(path.join(project, 'shared', 'review-pr'), { recursive: true });
await writeFile(
  path.join(project, 'shared/review-pr/shared.md'),
  '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n# Shared static review\n\n- [ ] Inspect the frozen changes.\n',
);
await json(path.join(project, 'project.json'), {
  name: 'review',
  repo_url: 'https://github.com/example/app.git',
  ci: { repo: 'example/app' },
  default_branch: 'main',
  paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  static_review: { template_id: 'review-pr/shared' },
  execution_templates: {
    sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
  },
});
const poolFiles: string[] = [];
for (const [machine, capacity] of [
  ['review-node', 3],
  ['no-capacity', 0],
] as const) {
  const file = path.join(fixture, 'pool', `${machine}.json`);
  poolFiles.push(file);
  await json(file, {
    machine,
    host: 'localhost',
    project: 'review',
    platform: 'cli',
    os: process.platform,
    slots: [],
    ...(capacity ? { review_workspaces: { max_concurrent: capacity } } : {}),
  });
}
const originalPools = await Promise.all(poolFiles.map((file) => readFile(file, 'utf8')));
const output = openSync(log, 'w', 0o600);
const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', output, output],
  env: {
    ...process.env,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_HOME: path.join(fixture, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
    FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY_TOKEN: token,
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: scenario === 'missing-owner' ? '' : 'legacy-env',
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
let connection: GatewayConnection | undefined;
try {
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    timeout: 1000,
    credential: { token },
  });
  const deadline = Date.now() + 30_000;
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
  const base = {
    project: 'review',
    flowType: 'review-pr',
    mode: 'autonomous',
    ticketOrPr: 'example/app#42',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    transport: 'native',
    reviewWorkspaceTarget: { machine: 'review-node' },
  };
  const rejected = (code: string, pattern?: RegExp) => (error: unknown) => {
    assert(error instanceof GatewayRpcError);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
  if (scenario === 'preview') {
    const result = await connection.call<DispatchPreviewResult>('dispatch.preview', base);
    assert.equal(result.preview.slotId, null);
    assert.deepEqual(result.preview.reviewWorkspace, {
      machine: 'review-node',
      executionNodeId: 'local',
      active: 0,
      limit: 3,
    });
    assert.equal(result.preview.runner, base.runner);
    assert.equal(result.preview.model, base.model);
    assert.equal(result.preview.executionTemplate?.id, 'review-pr/shared');
    const canonical = await readFile(path.join(project, 'shared/review-pr/shared.md'));
    assert.equal(
      result.preview.executionTemplate?.sha256,
      createHash('sha256').update(canonical).digest('hex'),
    );
  } else if (scenario === 'missing-owner') {
    await assert.rejects(
      connection.call('dispatch.preview', base),
      rejected('AUTH_FORBIDDEN', /own/),
    );
  } else {
    for (const change of [
      { transport: undefined },
      { transport: 'tmux' },
      { runner: 'claude', model: 'sonnet' },
      { model: 'unknown' },
      { effort: 'unsupported' },
    ])
      await assert.rejects(
        connection.call('dispatch.preview', { ...base, ...change }),
        rejected('REVIEW_WORKSPACE_UNSUPPORTED'),
      );
    for (const change of [
      { reviewWorkspaceTarget: undefined, slotId: 'unowned-device' },
      { slotId: 'unowned-device' },
      { allowedSlots: ['unowned-device'] },
      { reviewWorkspaceTarget: { machine: 'no-capacity' } },
      { reviewWorkspaceTarget: { machine: 'missing-machine' } },
      { reviewWorkspaceTarget: { machine: ' review-node' } },
    ])
      await assert.rejects(
        connection.call('dispatch.preview', { ...base, ...change }),
        rejected('REVIEW_WORKSPACE_NEEDS_CONFIGURATION'),
      );
  }
  assert.equal(
    (await connection.call<DispatchQueueListResult>('dispatch.queue.list')).items.length,
    0,
  );
  assert.deepEqual(
    await Promise.all(poolFiles.map((file) => readFile(file, 'utf8'))),
    originalPools,
  );
  assert.deepEqual(
    (await connection.call<{ fleet: { slots: unknown[] } }>('fleet.status')).fleet.slots,
    [],
  );
  console.log(
    JSON.stringify({
      passed: true,
      scenario,
      endpoint: 'isolated production gateway',
      workerExecution: false,
      slotsCreated: 0,
    }),
  );
} catch (error) {
  const details = (await readFile(log, 'utf8'))
    .replaceAll(token, '[redacted]')
    .split('\n')
    .slice(-15)
    .join('\n');
  throw new Error(`${String(error)}\n${details}`, { cause: error });
} finally {
  connection?.close();
  if (gateway.exitCode === null && gateway.pid) {
    const exited = once(gateway, 'exit');
    process.kill(-gateway.pid, 'SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
    if (!stopped) {
      process.kill(-gateway.pid, 'SIGKILL');
      await exited;
    }
  }
  await rm(fixture, { recursive: true, force: true });
  process.removeListener('exit', terminate);
}
