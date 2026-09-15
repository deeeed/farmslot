#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
} from '../packages/cli/src/gateway-client.js';
import type {
  ConfigProjectResult,
  DispatchPreviewResult,
  DispatchQueueAddResult,
  RunCreateResult,
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
      name: 'Direct workflow defaults validation',
    },
  });
  const result = await runner.run({
    recipeDocument: JSON.parse(
      await readFile(
        path.join(root, 'docs/examples/recipes/farmslot/direct-workflow-defaults.recipe.json'),
        'utf8',
      ),
    ),
    artifactsDir: path.resolve(
      root,
      process.argv[3] ?? `temp/direct-workflow-defaults/${Date.now()}`,
    ),
    projectRoot: root,
    source: { kind: 'operator', trust: 'trusted', name: 'Direct workflow defaults validation' },
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'pass' ? 0 : 1);
}
assert(scenario === 'direct', 'Expected direct');
const fixture = await mkdtemp(path.join(tmpdir(), 'farmslot-workflow-defaults-'));
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
const execution = {
  workspacePolicy: { kind: 'pool', allowedMachines: ['review-node', 'review-other'] },
  transport: 'native',
  models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
};
const workflowDefaults = {
  'review-pr': {
    execution,
    review: { sessionIntent: 'reset', scope: 'full', validationDepth: 'static-code' },
  },
};
await json(path.join(project, 'project.json'), {
  name: 'review',
  repo_url: 'https://github.com/example/app.git',
  ci: { repo: 'example/app' },
  default_branch: 'main',
  paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  static_review: { template_id: 'review-pr/shared' },
  workflow_defaults: workflowDefaults,
  execution_templates: {
    sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    defaults: [
      {
        when: { flow: 'review-pr', platform: 'cli', runMode: 'autonomous' },
        templateId: 'review-pr/runtime',
      },
    ],
  },
});
const poolFiles: string[] = [];
for (const [machine, capacity] of [
  ['review-node', 1],
  ['review-other', 1],
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
await writeFile(
  path.join(project, 'shared/review-pr/runtime.md'),
  '---\nplatforms: [cli]\nrunMode: autonomous\n---\n\n- [ ] Run the selected validation.\n',
);
await mkdir(path.join(fixture, 'repo'));
const runtimePool = path.join(fixture, 'pool/runtime.json');
poolFiles.push(runtimePool);
await json(runtimePool, {
  machine: 'runtime-host',
  host: 'localhost',
  project: 'review',
  platform: 'cli',
  slots: [
    {
      id: 'runtime',
      enabled: true,
      repo: path.join(fixture, 'repo'),
      session: 'fixture-runtime',
      resources: {},
    },
  ],
});
await json(path.join(fixture, '.farm-status.json'), {
  checked_at: new Date().toISOString(),
  slots: [
    {
      slot: 'runtime',
      machine: 'runtime-host',
      project: 'review',
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
const originalPools = await Promise.all(poolFiles.map((file) => readFile(file, 'utf8')));
// Provider fixture only: the gateway still executes its real gh transport, parsing,
// account validation, preview, durable intake and authorization paths. Unknown gh
// commands fail, so this fixture cannot publish or silently call a real provider.
await mkdir(path.join(fixture, 'bin'));
await writeFile(
  path.join(fixture, 'bin', 'gh'),
  String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'token') { process.stdout.write('fixture-provider-token\n'); process.exit(0); }
let body;
if (args[0] === 'api' && args.includes('user')) body = { login: 'fixture-reviewer' };
else if (args[0] === 'api' && args.includes('graphql')) {
  const query = args.find(arg => arg.startsWith('query=')) || '';
  if (!query.startsWith('query=query(') || !query.includes('pullRequest') && !query.includes('... on PullRequest')) throw new Error('Unsupported fixture GraphQL operation');
  const pr = { id:'fixture-pr',number:42,title:'Fixture change',state:'OPEN',isDraft:false,
    headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',headRefName:'fixture-change',
    author:{login:'fixture-author'},repository:{nameWithOwner:'example/app'},
    reviewDecision:'REVIEW_REQUIRED', viewerLatestReview:null,viewerLatestReviewRequest:null,
    labels:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}} };
  body = {data:{...(query.includes('node(id:') ? {node:pr} : {repository:query.includes('pullRequests(')
    ? {pullRequests:{nodes:[pr],pageInfo:{hasNextPage:false,endCursor:null}}} : {pullRequest:pr}}),
    rateLimit:{cost:1,remaining:4999,resetAt:'2099-01-01T00:00:00Z'}}};
} else throw new Error('Unsupported fixture gh command');
if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
`,
  { mode: 0o700 },
);

const output = openSync(log, 'w', 0o600);
const gateway = spawn('yarn', ['workspace', '@farmslot/gateway', 'start'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', output, output],
  env: {
    ...process.env,
    PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
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
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_TEST_STATUS_FILE: path.join(fixture, '.farm-status.json'),
    FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
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
    timeout: 10000,
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
  const configured = await connection.call<ConfigProjectResult>('config.project', {
    project: 'review',
  });
  assert.deepEqual(configured.project.workflowDefaults, workflowDefaults);
  const base = {
    flowType: 'review-pr',
    project: 'review',
    ticketOrPr: 'example/app#100',
  };
  function cli(args: string[]) {
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
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          FARMSLOT_HOME: path.join(fixture, 'cli-home'),
          FARMSLOT_GATEWAY_TOKEN: token,
        },
      },
    );
    const result = JSON.parse(raw);
    assert.equal(result.status, 'ok');
    return result.data;
  }
  const cliPreview = cli([
    'dispatch',
    'preview',
    '--project',
    'review',
    '--flow-type',
    'review-pr',
    '--ticket',
    'example/app#99',
    '--review-machine',
    'review-other',
    '--runner',
    'codex',
    '--model',
    'gpt-6-astra',
    '--effort',
    'high',
    '--transport',
    'native',
  ]);
  assert.equal(cliPreview.preview.reviewWorkspace.machine, 'review-other');
  const cliRun = cli([
    'run',
    'create',
    '--project',
    'review',
    '--flow-type',
    'review-pr',
    '--ticket',
    'example/app#99',
    '--review-machine',
    'review-other',
    '--runner',
    'codex',
    '--model',
    'gpt-6-astra',
    '--effort',
    'high',
    '--transport',
    'native',
  ]);
  assert.equal(cliRun.run.slotId, null);
  assert.equal(cliRun.run.reviewWorkspaceTarget.machine, 'review-other');
  assert.equal(cliRun.run.effort, 'high');
  await connection.call('run.cancel', { runId: cliRun.run.id });
  const preferredPool = path.join(fixture, 'pool/review-node.json');
  const originalPreferredPool = await readFile(preferredPool, 'utf8');
  const { principal: offlinePrincipal } = await connection.call<{ principal: { id: string } }>(
    'principal.create',
    {
      subject: { type: 'node', displayName: 'Offline preferred reviewer', machine: 'review-node' },
      roles: [],
    },
  );
  await connection.call('principal.bindNativeOwner', {
    nodePrincipalId: offlinePrincipal.id,
    ownerPrincipalId: 'legacy-env',
  });
  const offlineCredential = await connection.call<{ credential: { id: string } }>(
    'credential.issue',
    { principalId: offlinePrincipal.id, displayName: 'Offline review fixture' },
  );
  try {
    await json(preferredPool, { ...JSON.parse(originalPreferredPool), host: 'offline.invalid' });
    const preview = await connection.call<DispatchPreviewResult>('dispatch.preview', {
      ...base,
      ticketOrPr: 'example/app#90',
    });
    assert.equal(
      preview.preview.reviewWorkspace?.machine,
      'review-other',
      'Preview must skip an authorized offline alternative',
    );
    const direct = await connection.call<RunCreateResult>('run.create', {
      ...base,
      ticketOrPr: 'example/app#90',
    });
    assert.equal(direct.run.reviewWorkspaceTarget?.machine, 'review-other');
    await connection.call('run.cancel', { runId: direct.run.id });
    const queued = await connection.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      ticketOrPr: 'example/app#91',
    });
    assert.equal(queued.item.reviewWorkspaceTarget?.machine, 'review-other');
    let dispatched;
    const deadline = Date.now() + 15_000;
    do {
      const result = await connection.call<{
        runs: import('../packages/protocol/src/index.js').Run[];
      }>('run.list');
      dispatched = result.runs.find((run) => run.ticketOrPr === 'example/app#91');
      if (!dispatched) await delay(100);
    } while (!dispatched && Date.now() < deadline);
    assert(dispatched, 'Queue must dispatch through a healthy alternate machine');
    assert.equal(dispatched.reviewWorkspaceTarget?.machine, 'review-other');
    await connection.call('run.cancel', { runId: dispatched.id });
  } finally {
    await writeFile(preferredPool, originalPreferredPool);
    await connection.call('credential.revoke', { credentialId: offlineCredential.credential.id });
  }
  const created = await connection.call<RunCreateResult>('run.create', base);
  assert.equal(created.run.mode, 'autonomous');
  assert.equal(created.run.slotId, null);
  assert.equal(created.run.reviewWorkspaceTarget?.machine, 'review-node');
  assert.equal(created.run.transport, 'native');
  assert.equal(created.run.metrics.model, 'gpt-6-astra');
  assert.deepEqual(created.run.workflowExecution, execution);
  const preview = await connection.call<DispatchPreviewResult>('dispatch.preview', {
    ...base,
    ticketOrPr: 'example/app#101',
  });
  assert.equal(preview.preview.slotId, null);
  assert.equal(
    preview.preview.reviewWorkspace?.machine,
    'review-other',
    'Preview did not skip the full host',
  );
  const second = await connection.call<RunCreateResult>('run.create', {
    ...base,
    ticketOrPr: 'example/app#101',
  });
  assert.equal(second.run.reviewWorkspaceTarget?.machine, 'review-other');
  const queued = await connection.call<DispatchQueueAddResult>('dispatch.queue.add', {
    ...base,
    ticketOrPr: 'example/app#102',
  });
  assert.equal(queued.item.mode, 'autonomous');
  assert.deepEqual(queued.item.workflowExecution, execution);
  // Candidate selection temporarily claims the row. Wait for the capacity refusal
  // to return it to the public queued list before checking its retained policy.
  let listedItem;
  const listDeadline = Date.now() + 10_000;
  do {
    const listed = await connection.call<DispatchQueueListResult>('dispatch.queue.list');
    listedItem = listed.items.find((item) => item.id === queued.item.id);
    if (!listedItem) await delay(100);
  } while (!listedItem && Date.now() < listDeadline);
  assert.deepEqual(listedItem?.workflowExecution, execution);
  const fallbackPool = path.join(fixture, 'pool/review-other.json');
  const originalFallbackPool = await readFile(fallbackPool, 'utf8');
  try {
    const invalidFallback = JSON.parse(originalFallbackPool);
    delete invalidFallback.review_workspaces;
    await json(fallbackPool, invalidFallback);
    await assert.rejects(
      connection.call('run.create', { ...base, ticketOrPr: 'example/app#103' }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          'REVIEW_WORKSPACE_CAPACITY',
          'Eligible machine capacity must outrank an invalid fallback',
        );
        return true;
      },
    );
    const waiting = await connection.call<DispatchQueueAddResult>('dispatch.queue.add', {
      ...base,
      ticketOrPr: 'example/app#104',
    });
    assert.equal(waiting.item.reviewWorkspaceTarget?.machine, 'review-node');
    let reason: string | undefined;
    const deadline = Date.now() + 15_000;
    do {
      const list = await connection.call<DispatchQueueListResult>('dispatch.queue.list');
      reason = list.items.find((item) => item.id === waiting.item.id)?.waitingReason;
      if (!reason) await delay(100);
    } while (!reason && Date.now() < deadline);
    assert.match(
      reason ?? '',
      /Review capacity is full on review-node/,
      'Queue must retain the eligible machine capacity reason',
    );
    await connection.call('dispatch.queue.remove', { itemId: waiting.item.id });
  } finally {
    await writeFile(fallbackPool, originalFallbackPool);
  }

  for (const patch of [
    { slotId: 'runtime' },
    { model: 'not-allowed' },
    { effort: 'low' },
    { transport: 'tmux' },
    { reviewWorkspaceTarget: { machine: 'no-capacity' } },
  ]) {
    await assert.rejects(connection.call('dispatch.preview', { ...base, ...patch }));
  }
  await assert.rejects(connection.call('run.create', { ...base, workflowExecution: execution }));
  await assert.rejects(
    connection.call('dispatch.queue.add', { ...base, workflowExecution: execution }),
  );
  for (const method of ['dispatch.preview', 'dispatch.queue.add', 'run.create']) {
    await assert.rejects(
      connection.call(method, { ...base, executionTemplateId: 'review-pr/other' }),
      /configured static-review template/,
    );
  }
  const legacy = await connection.call<DispatchPreviewResult>('dispatch.preview', {
    ...base,
    ticketOrPr: '42',
    reviewValidationDepth: 'full-live',
    mode: 'autonomous',
    slotId: 'runtime',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
  });
  assert.equal(legacy.preview.flowType, 'review-pr');
  assert.equal(legacy.preview.taskId, 'example/app#42');
  assert.equal(legacy.preview.slotId, 'runtime');
  assert.equal(legacy.preview.model, 'gpt-6-astra');
  assert.equal(legacy.preview.executionTemplate?.id, 'review-pr/runtime');
  assert.equal(legacy.preview.reviewWorkspace, undefined);
  const runtimeRequest = {
    ...base,
    mode: 'autonomous',
    ticketOrPr: 'example/app#200',
    reviewValidationDepth: 'full-live',
    slotId: 'runtime',
    runner: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
  };
  const runtimeRun = await connection.call<RunCreateResult>('run.create', runtimeRequest);
  assert.equal(runtimeRun.run.flowType, 'review-pr');
  assert.equal(runtimeRun.run.reviewValidationDepth, 'full-live');
  assert.equal(runtimeRun.run.slotId, 'runtime');
  assert.equal(runtimeRun.run.reviewWorkspaceTarget, undefined);
  assert.equal(runtimeRun.run.executionTemplate?.id, 'review-pr/runtime');
  assert.equal(runtimeRun.run.metrics.model, 'gpt-6-astra');
  const runtimeQueue = await connection.call<DispatchQueueAddResult>('dispatch.queue.add', {
    ...runtimeRequest,
    ticketOrPr: 'example/app#201',
  });
  assert.equal(runtimeQueue.item.flowType, 'review-pr');
  assert.equal(runtimeQueue.item.reviewValidationDepth, 'full-live');
  assert.equal(runtimeQueue.item.slotId, 'runtime');
  assert.equal(runtimeQueue.item.reviewWorkspaceTarget, undefined);
  assert.equal(runtimeQueue.item.executionTemplate?.id, 'review-pr/runtime');
  await connection.call('dispatch.queue.remove', { itemId: runtimeQueue.item.id });
  await connection.call('run.cancel', { runId: runtimeRun.run.id });
  await connection.call('dispatch.queue.remove', { itemId: queued.item.id });
  for (const run of [created.run, second.run])
    await connection.call('run.cancel', { runId: run.id });
  assert.equal(
    (await connection.call<DispatchQueueListResult>('dispatch.queue.list')).items.length,
    0,
  );
  assert.deepEqual(
    await Promise.all(poolFiles.map((file) => readFile(file, 'utf8'))),
    originalPools,
  );
  assert.deepEqual(
    (
      await connection.call<{
        fleet: { slots: Array<{ slot: string; currentRunId: string | null }> };
      }>('fleet.status')
    ).fleet.slots.map((slot) => ({ slot: slot.slot, currentRunId: slot.currentRunId })),
    [{ slot: 'runtime', currentRunId: null }],
  );
  console.log(
    JSON.stringify({
      passed: true,
      scenario,
      endpoint: 'isolated production gateway',
      workerExecution: false,
      staticSlotsCreated: 0,
      engineStartDisabled: true,
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
  if (process.argv[3])
    await json(path.join(path.resolve(process.argv[3]), 'outcome.json'), {
      cleanupComplete: true,
      fixture,
    });
}
