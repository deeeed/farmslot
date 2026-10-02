import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FLOW_STEPS, Methods } from '@farmslot/protocol';

import { alive, matchesProcess } from '../../../packages/agent-runtime/src/native/storage.ts';
import { taskInit } from '../../../packages/agent-runtime/src/task-init/index.ts';

import {
  prepareCleanupGuards,
  prepareGoneContext,
  proveCleanupGuards,
} from './native-cleanup-guards.mjs';
import {
  prepareBusyWorkerView,
  proveBusySteering,
  proveHeldWorkspace,
  proveRecoveryHint,
  proveSharedCleanup,
} from './native-coherence-browser.mjs';
import { proveParkOccupiedClaim } from './native-park-claim.mjs';
import { proveProviderRecovery } from './native-provider-recovery.mjs';
import { proveQueuedLeaseOwnership } from './native-queued-lease.mjs';
import { prepareRealAdoption, proveRealAdoption } from './native-real-adoption.mjs';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'native-run-coherence-')));
const root = path.join(temporary, 'root');
const project = 'native-coherence-fixture';
const slotId = `coherence-${randomUUID()}`;
const cancelSlot = `coherence-cancel-${randomUUID()}`;
const cancelRunId = randomUUID();
const forceRunId = randomUUID();
const providerRunId = randomUUID();
const forceSlot = `coherence-force-${randomUUID()}`;
const emptySlot = `coherence-empty-${randomUUID()}`;
const emptyRunId = randomUUID();
const runtimeSlot = `coherence-runtime-${randomUUID()}`;
let runtimeRunId;
const externalSession = `coherence-adopt-${randomUUID()}`;
const wrongSession = `coherence-wrong-${randomUUID()}`;
const foreignSession = `coherence-foreign-${randomUUID()}`;
const parkSession = `coherence-park-${randomUUID()}`;
const repo = path.join(temporary, 'repo');
const cancelRepo = path.join(temporary, 'cancel-repo');
const emptyRepo = path.join(temporary, 'empty-repo');
const runtimeRepo = path.join(temporary, 'runtime-repo');
const runtimeTaskDir = path.join(root, 'projects', project, 'tasks/dev/COHERENCE-2');
const configFile = path.join(temporary, 'mode.json');
const bin = path.join(temporary, 'bin');
let gateway;
let ui;
let kernelForeign;
let logFd;
let runId;
let env;
let runtimeOriginal;
let uiRoute;
const withUi = process.argv.includes('--ui');
const legacy = process.argv.includes('--legacy');
const kernelReuse = process.argv.includes('--kernel-reuse');
const realAdoption = process.argv.includes('--real-adoption');
const providerRecovery = process.argv.includes('--provider-recovery');
const reconcileHeld = process.argv.includes('--reconcile-held');
const queuedClose = process.argv.includes('--queued-close');
const parkClaim = process.argv.includes('--park-claim');
const missingContract = process.argv.includes('--missing-contract');
const generationGuard = process.argv.includes('--generation-guard');
const guardsOnly = process.argv.includes('--guards-only') || providerRecovery;
const providersOnly =
  process.argv.includes('--providers-only') || realAdoption || guardsOnly || reconcileHeld;
let realFixture;
let cleanupGuards = [];
let taskParams;
const controlIndex = process.argv.indexOf('--negative-control');
const control = controlIndex < 0 ? undefined : process.argv[controlIndex + 1];
assert.ok(controlIndex < 0 || control, '--negative-control needs a name');
const outDir =
  process.env.FARMSLOT_COHERENCE_OUT ?? path.join(sourceRoot, 'temp/native-coherence-evidence');
const checks = [];
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (method, params = {}) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(sourceRoot, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: sourceRoot, env, encoding: 'utf8', timeout: 105000, maxBuffer: 8 * 1024 * 1024 },
    ),
  );
const cdp = (...args) => {
  const output = execFileSync(
    process.execPath,
    [path.join(sourceRoot, 'apps/command-center/scripts/cdp.mjs'), ...args],
    { cwd: sourceRoot, env, encoding: 'utf8', timeout: 60000 },
  );
  if (!output.trim()) return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    // The committed helper prints evaluated strings as plain text.
    if (!(error instanceof SyntaxError)) throw error;
    return output.trim();
  }
};
const wait = async (read, predicate, label, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const value = read();
    last = value;
    if (predicate(value)) return value;
    await delay(250);
  }
  if (last?.steps)
    console.error(
      JSON.stringify(
        {
          status: last.status,
          error: last.error,
          steps: last.steps.map((step) => ({
            name: step.name,
            status: step.status,
            detail: step.detail,
          })),
          pendingDecisions: last.decisions
            .filter((decision) => !decision.resolvedAt)
            .map((decision) => ({
              id: decision.id,
              type: decision.type,
              description: decision.description,
              actions: decision.actions,
            })),
        },
        null,
        2,
      ),
    );
  if (last?.session) {
    const session = last.session;
    console.error(
      JSON.stringify({
        label,
        state: session.state,
        pid: session.processPid,
        stopped: session.processStopped,
        error: session.error,
        signal: session.signal,
        exitCode: session.exitCode,
      }),
    );
  }
  throw new Error(`Timed out: ${label}`);
};
const mode = (value) =>
  writeJson(configFile, { ...JSON.parse(readFileSync(configFile, 'utf8')), ...value });
const check = (name, data = {}) => {
  checks.push({ name, ...data });
  console.log(`Proved: ${name}`);
};
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function restartGateway(mutate) {
  const exited = once(gateway, 'exit');
  gateway.kill('SIGTERM');
  await exited;
  await mutate?.();
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: sourceRoot,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  const deadline = Date.now() + 120000;
  while (true) {
    assert.equal(gateway.exitCode, null, 'isolated gateway exited during recovery restart');
    try {
      if ((await fetch(env.FARMSLOT_GATEWAY.replace('ws://', 'http://') + '/health')).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    assert.ok(Date.now() < deadline, 'restarted isolated gateway must start');
    await delay(250);
  }
}
function gitInit(directory) {
  mkdirSync(directory, { recursive: true });
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', [
    '-C',
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
}

try {
  for (const directory of [root, repo, cancelRepo, emptyRepo, runtimeRepo]) gitInit(directory);
  writeFileSync(path.join(temporary, '.coherence-fixture'), 'disposable\n');
  mkdirSync(bin);
  const executable = path.join(bin, 'claude');
  writeFileSync(
    executable,
    readFileSync(path.join(sourceRoot, 'scripts/runner-validation/fixtures/native-coherence.cjs')),
  );
  chmodSync(executable, 0o700);
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable native coherence proof\n');
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  mkdirSync(path.join(root, 'packages/agent-runtime'), { recursive: true });
  symlinkSync(
    path.join(sourceRoot, 'packages/agent-runtime/scripts'),
    path.join(root, 'packages/agent-runtime/scripts'),
    'dir',
  );
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  const taskDir = path.join(root, 'projects', project, 'tasks/dev/COHERENCE-1');
  const taskFile = path.join(taskDir, 'TASK.md');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(taskFile, '# Manual fixture task\n- [ ] Complete isolated proof\n');
  mkdirSync(path.join(root, 'projects', project, 'templates/worker'), { recursive: true });
  for (const name of ['dev.md', 'dev-interactive.md'])
    writeFileSync(
      path.join(root, 'projects', project, 'templates/worker', name),
      '# Fixture task\nRun ./mark start.\n- [ ] Complete isolated proof\nRun ./mark complete --mark-last.\n',
    );
  mkdirSync(path.join(root, 'projects', project, 'templates/prompts'), { recursive: true });
  writeFileSync(
    path.join(root, 'projects', project, 'templates/prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}} first. Follow {{TASK_DIR}}/CHECKLIST.md and use {{TASK_DIR}}/mark for progress.\n',
  );
  writeJson(configFile, {
    mode: 'crash',
    taskDir: path.join(repo, '.task/dev/COHERENCE-1'),
    inputs: path.join(temporary, 'inputs.jsonl'),
    crashObserved: path.join(temporary, 'crash-started'),
    externalReady: path.join(temporary, 'external-ready.json'),
  });
  const providerActions = {};
  const providers = {};
  for (const name of ['app', 'dep', 'warm', 'contender']) {
    const actions = {};
    for (const action of ['acquire', 'health', 'release']) {
      const id = `${name}-${action}`;
      providerActions[id] = {
        label: id,
        command: `NATIVE_COHERENCE_CONFIG='${configFile}' '${executable}' --provider ${name} ${action}`,
      };
      actions[action] = { kind: 'slot-action', action_id: id };
    }
    providers[name] = {
      label: name,
      version: '1',
      share_policy: ['app', 'dep'].includes(name) ? 'shared' : 'exclusive',
      dependencies: name === 'app' ? ['dep'] : [],
      keep_warm_ms: name === 'warm' ? 60000 : 0,
      cost: {
        class: 'low',
        resources: ['warm', 'contender'].includes(name)
          ? [{ id: 'fixture-exclusive', access: 'exclusive' }]
          : [],
      },
      actions,
      release_effects: [],
    };
  }
  providers['owned-server'] = {
    label: 'Owned dev server',
    version: '1',
    share_policy: 'exclusive',
    keep_warm_ms: 60000,
    cost: { class: 'low', resources: [] },
    release_effects: ['stop owned dev server'],
    actions: {
      acquire: { kind: 'resource', resource_id: 'owned-server', action: 'boot' },
      health: { kind: 'resource', resource_id: 'owned-server', action: 'health' },
      release: { kind: 'resource', resource_id: 'owned-server', action: 'shutdown' },
    },
  };
  providers['rollback-parent'] = { ...providers['owned-server'], dependencies: ['app'] };
  const serverCommand = (action) =>
    `NATIVE_COHERENCE_CONFIG='${configFile}' '${executable}' --server-${action} owned-server.pid`;
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    repo,
    repo_url: repo,
    default_branch: 'main',
    runtime_dir: '.task',
    task_dir_name: '.task',
    command_env: {
      set: {
        NATIVE_COHERENCE_CONFIG: configFile,
        CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'),
      },
    },
    vars: {
      mark_cmd: `node ${path.join(sourceRoot, 'packages/agent-runtime/scripts/mark-checklist-step.cjs')}`,
    },
    hooks: {},
    slot_actions: providerActions,
    runtime_capabilities: { providers },
    resources: {
      'owned-server': {
        type: 'service',
        label: 'Owned dev server',
        streamable: false,
        controllable: true,
        watch: { type: 'pid-file', path: 'owned-server.pid' },
        hooks: {
          boot: serverCommand('boot'),
          health: serverCommand('health'),
          shutdown: serverCommand('stop'),
        },
      },
    },
    worker_terminal: {
      flows: {
        dev: {
          complete: {
            report: 'artifacts/configured-report.md',
            artifacts: ['artifacts/configured-report.md', 'artifacts/learnings.md'],
          },
        },
      },
    },
  });
  writeJson(path.join(root, 'pool/fixture.json'), {
    schema_version: 2,
    machine: hostname(),
    claude_path: executable,
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
      {
        id: cancelSlot,
        project,
        platform: 'cli',
        repo: cancelRepo,
        session: foreignSession,
        enabled: true,
        mode: 'dispatch',
      },
    ],
  });
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      { slot: slotId, lifecycle: 'ready', phase: 'idle', current_run_id: null },
      { slot: cancelSlot, lifecycle: 'busy', phase: 'working', current_run_id: cancelRunId },
      { slot: forceSlot, lifecycle: 'busy', phase: 'working', current_run_id: forceRunId },
    ],
  });
  const now = new Date().toISOString();
  writeJson(path.join(root, '.runs', `${cancelRunId}.json`), {
    id: cancelRunId,
    project,
    ticketOrPr: 'COHERENCE-CANCEL',
    flowType: 'dev',
    mode: 'interactive',
    transport: 'tmux',
    status: 'paused',
    slotId: cancelSlot,
    taskFile: null,
    createdAt: now,
    updatedAt: now,
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    steps: [{ name: 'monitor', status: 'running' }],
  });
  writeJson(path.join(root, '.runs', `${providerRunId}.json`), {
    id: providerRunId,
    project,
    ticketOrPr: 'COHERENCE-PROVIDERS',
    flowType: 'dev',
    mode: 'interactive',
    transport: 'tmux',
    status: 'blocked',
    prNumber: 1,
    slotId: cancelSlot,
    taskFile: null,
    createdAt: now,
    updatedAt: now,
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    steps: [],
  });
  const poolFile = path.join(root, 'pool/fixture.json');
  const pool = JSON.parse(readFileSync(poolFile, 'utf8'));
  pool.slots.push({
    id: forceSlot,
    project,
    platform: 'cli',
    repo: cancelRepo,
    session: forceSlot,
    enabled: true,
    mode: 'dispatch',
  });
  for (const [id, directory] of [
    [emptySlot, emptyRepo],
    [runtimeSlot, runtimeRepo],
  ])
    pool.slots.push({
      id,
      project,
      platform: 'cli',
      repo: directory,
      ...(id === emptySlot ? { resources: { 'owned-server': {} } } : {}),
      session: id,
      enabled: true,
      mode: 'dispatch',
    });
  writeJson(poolFile, pool);
  const statusFile = path.join(root, '.farm-status.json');
  const status = JSON.parse(readFileSync(statusFile, 'utf8'));
  status.slots.push(
    { slot: emptySlot, lifecycle: 'busy', phase: 'working', current_run_id: emptyRunId },
    { slot: runtimeSlot, lifecycle: 'ready', phase: 'idle', current_run_id: null },
  );
  writeJson(statusFile, status);
  const storedFixture = (id, slot, task, steps) => ({
    id,
    project,
    ticketOrPr: 'COHERENCE-2',
    flowType: 'dev',
    mode: 'interactive',
    transport: 'tmux',
    safetyTier: 'full-auto',
    status: 'blocked',
    slotId: slot,
    taskFile: task,
    createdAt: now,
    updatedAt: now,
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    steps,
  });
  writeJson(
    path.join(root, '.runs', `${emptyRunId}.json`),
    storedFixture(emptyRunId, emptySlot, null, [{ name: 'monitor', status: 'running' }]),
  );
  const templateRoot = path.join(temporary, 'authored-templates');
  mkdirSync(path.join(templateRoot, 'dev'), { recursive: true });
  writeFileSync(
    path.join(templateRoot, 'dev/interactive.cli.md'),
    '---\nplatforms: [cli]\ndescription: Authored task proof\n---\n# Authored checklist\n- [x] Prior checkpoint\n',
  );
  await taskInit({
    taskDir: runtimeTaskDir,
    flow: 'dev',
    domain: 'authored-domain',
    runMode: 'interactive',
    platform: 'cli',
    template: {
      sources: [{ id: 'authored', kind: 'package', root: templateRoot, layout: 'flow-tree' }],
      explicitId: 'dev/interactive.cli',
    },
    task: {
      title: 'Authored runtime task',
      sourceKind: 'text',
      ticket: 'COHERENCE-22',
      acceptanceCriteria: ['Preserve authored task criteria'],
    },
    handoff: { surface: 'fixture', project },
  });
  runtimeOriginal = Object.fromEntries(
    ['TASK.md', 'CHECKLIST.md', 'inputs/handoff.json', 'inputs/worker-terminal-contract.json'].map(
      (file) => [file, readFileSync(path.join(runtimeTaskDir, file), 'utf8')],
    ),
  );
  if (missingContract) {
    rmSync(path.join(runtimeTaskDir, 'inputs/worker-terminal-contract.json'));
    delete runtimeOriginal['inputs/worker-terminal-contract.json'];
  }
  writeJson(path.join(root, '.runs', `${forceRunId}.json`), {
    id: forceRunId,
    project,
    ticketOrPr: 'COHERENCE-FORCE',
    flowType: 'dev',
    mode: 'interactive',
    transport: 'tmux',
    status: 'failed',
    slotId: forceSlot,
    taskFile: null,
    createdAt: now,
    updatedAt: now,
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'opus' },
    steps: [{ name: 'monitor', status: 'running' }],
  });
  const oldWorkerRun = JSON.parse(
    readFileSync(path.join(root, '.runs', `${emptyRunId}.json`), 'utf8'),
  );
  oldWorkerRun.agentContexts = [prepareGoneContext(emptyRepo)];
  writeJson(path.join(root, '.runs', `${emptyRunId}.json`), oldWorkerRun);
  cleanupGuards = prepareCleanupGuards({ temporary, project, gitInit });
  const guardPool = JSON.parse(readFileSync(poolFile, 'utf8'));
  const guardStatus = JSON.parse(readFileSync(statusFile, 'utf8'));
  for (const fixture of cleanupGuards) {
    guardPool.slots.push(fixture.slot);
    guardStatus.slots.push(fixture.status);
    writeJson(path.join(root, '.runs', `${fixture.runId}.json`), fixture.run);
  }
  writeJson(poolFile, guardPool);
  writeJson(statusFile, guardStatus);
  if (realAdoption) {
    realFixture = await prepareRealAdoption({
      temporary,
      root,
      project,
      sourceRoot,
      gitInit,
      writeJson,
    });
    const realPool = JSON.parse(readFileSync(poolFile, 'utf8'));
    realPool.claude_path = realFixture.cli;
    realPool.slots.push({
      id: realFixture.slotId,
      project,
      platform: 'cli',
      repo: realFixture.repo,
      session: realFixture.session,
      enabled: true,
      mode: 'dispatch',
    });
    writeJson(poolFile, realPool);
    const realStatus = JSON.parse(readFileSync(statusFile, 'utf8'));
    realStatus.slots.push({
      slot: realFixture.slotId,
      lifecycle: 'busy',
      phase: 'working',
      current_run_id: realFixture.runId,
      task_file: realFixture.taskDir + '/TASK.md',
    });
    writeJson(statusFile, realStatus);
  }
  const port = await freePort();
  const token = randomUUID();
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(temporary, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/capabilities.json'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(temporary, 'native'),
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
    FARMSLOT_GATEWAY_TOKEN: token,
    FARMSLOT_GATEWAY_PASSWORD: '',
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    GW_URL: `ws://127.0.0.1:${port}`,
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_RPC_TIMEOUT_MS: '90000',
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
    FARMSLOT_DEMO_POOL: '0',
    NODE_TEST_CONTEXT: '1',
    CLAUDE_CONFIG_DIR: path.join(temporary, 'claude'),
    NATIVE_COHERENCE_CONFIG: configFile,
    TSX_TSCONFIG_PATH: path.join(sourceRoot, 'services/gateway/tsconfig.json'),
    FARMSLOT_COHERENCE_FIXTURE: temporary,
    FARMSLOT_COHERENCE_FAULTS: JSON.stringify(cleanupGuards.filter((fixture) => fixture.fault)),
    FARMSLOT_COHERENCE_GENERATION_RUN_ID: generationGuard ? realFixture?.runId : '',
    NODE_OPTIONS: `--import ${path.join(sourceRoot, 'scripts/runner-validation/gateway/native-cleanup-faults.mjs')}`,
  };
  delete env.CODEX_LB_API_KEY;
  if (control)
    Object.assign(env, {
      FARMSLOT_COHERENCE_CONTROL: control,
      FARMSLOT_COHERENCE_FIXTURE: temporary,
      FARMSLOT_COHERENCE_CONTROL_RECEIPT: path.join(temporary, 'control-applied'),
      NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${path.join(sourceRoot, 'scripts/runner-validation/gateway/native-coherence-control.mjs')}`,
    });
  writeJson(path.join(temporary, 'home/llm-config.json'), {
    defaultProvider: 'codex-lb',
    intelligenceModel: 'gpt-6-astra',
  });
  logFd = openSync(path.join(temporary, 'gateway.log'), 'w');
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: sourceRoot,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  const startupDeadline = Date.now() + 120000;
  while (true) {
    assert.equal(gateway.exitCode, null, 'isolated gateway exited during startup');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    assert.ok(Date.now() < startupDeadline, 'isolated gateway must start');
    await delay(250);
  }
  if (!guardsOnly) {
    if (!providersOnly) {
      assert.throws(() => {
        const rejected = rpc('run.createNative', {
          flowType: 'dev',
          project,
          ticketOrPr: 'COHERENCE-0',
          taskFile: path.relative(sourceRoot, taskFile),
          slotId,
          allowedSlots: [slotId],
          runner: 'claude',
          model: 'opus',
          mode: 'interactive',
          skipPrepare: true,
          safetyTier: 'full-auto',
        });
        runId = rejected.run.id;
      }, /Upgrade.*CLI/);
      check('relative task rejection includes upgrade order');
      taskParams = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--import',
            fileURLToPath(import.meta.resolve('tsx')),
            '--input-type=module',
            '--eval',
            `import { buildRunCreateParams } from ${JSON.stringify(path.join(sourceRoot, 'packages/cli/src/commands/run.ts'))}; console.log(JSON.stringify(buildRunCreateParams({task: ${JSON.stringify(path.relative(root, taskFile))}})));`,
          ],
          {
            cwd: root,
            env: { ...env, TSX_TSCONFIG_PATH: path.join(sourceRoot, 'packages/cli/tsconfig.json') },
            encoding: 'utf8',
            timeout: 30000,
          },
        ),
      );
      assert.equal(taskParams.taskFile, taskFile, 'CLI resolves the caller task path');
      check('CLI resolves relative task against the caller cwd');
      const created = rpc('run.createNative', {
        ...taskParams,
        flowType: 'dev',
        project,
        ticketOrPr: 'COHERENCE-1',
        slotId,
        allowedSlots: [slotId],
        runner: 'claude',
        model: 'opus',
        mode: 'interactive',
        skipPrepare: true,
        safetyTier: 'full-auto',
      });
      runId = created.run.id;
      const get = () => rpc('run.get', { runId }).run;
      let run = await wait(
        get,
        (value) => {
          assert.notEqual(value.status, 'failed', value.error);
          const accepted = value.agentContexts?.some(
            (context) => context.nativeSession?.acceptedAt,
          );
          if (!accepted) assert.notEqual(value.status, 'blocked', value.error);
          return accepted;
        },
        'native task accepted',
      );
      let context = run.agentContexts.find((context) => context.role === 'dev');
      let binding = context.nativeSession;
      const target = () => ({
        sessionId: binding.sessionId,
        executionNodeId: binding.executionNodeId,
        worker: {
          runId,
          contextId: context.id,
          generation: binding.generation,
          leaseId: binding.leaseId,
        },
      });
      let snapshot = await wait(
        () => rpc('native.session.read', target()),
        (value) => value.session.processStopped,
        'native crash closure',
      );
      assert.equal(
        snapshot.session.executable,
        executable,
        'Replay must use the isolated protocol peer',
      );
      assert.equal(snapshot.session.signal, 'SIGTERM');
      assert.equal(snapshot.session.exitCode, null);
      assert.equal(snapshot.session.stderrTail.length, 50);
      assert.ok(!JSON.stringify(snapshot.session.stderrTail).includes('synthetic-secret'));
      assert.ok(!JSON.stringify(snapshot.session.stderrTail).includes('synthetic-cookie'));
      assert.ok(!JSON.stringify(snapshot.session.stderrTail).includes('synthetic-header'));
      check('crash diagnostics', {
        signal: snapshot.session.signal,
        stderrLines: snapshot.session.stderrTail.length,
      });
      run = await wait(
        get,
        (value) =>
          value.status === 'blocked' &&
          value.decisions.some(
            (decision) =>
              !decision.resolvedAt &&
              decision.actions.some((action) => action.id === 'resume-native-worker'),
          ),
        'native recovery decision',
      );
      assert.match(run.error, /Native runner exited/);
      assert.match(rpc('run.get', { runId }).recoveryHints.join(' '), /farmslot decision resolve/);
      if (legacy || kernelReuse) {
        if (kernelReuse) {
          await delay(2100);
          kernelForeign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            cwd: temporary,
            detached: true,
            stdio: 'ignore',
          });
          assert.ok(kernelForeign.pid);
        }
        const host = JSON.parse(readFileSync(path.join(temporary, 'native/host.json'), 'utf8'));
        assert.ok(
          matchesProcess(host.pid, path.join(temporary, 'native')),
          'fixture host must match before legacy replay',
        );
        process.kill(host.pid, 'SIGTERM');
        await wait(
          () => alive(host.pid),
          (value) => !value,
          'fixture host stops before legacy reload',
          30000,
        );
        const journal = path.join(temporary, 'native/sessions', `${binding.sessionId}.journal`);
        const entries = readFileSync(journal, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const entry = JSON.parse(line);
            if (kernelReuse) {
              for (const key of ['processes', 'processesAdded'])
                for (const frame of entry[key] ?? []) {
                  if (frame.pid === snapshot.session.processPid) frame.pid = kernelForeign.pid;
                  if (frame.parent === snapshot.session.processPid)
                    frame.parent = kernelForeign.pid;
                  if (frame.group === snapshot.session.processPid) frame.group = kernelForeign.pid;
                }
            } else {
              delete entry.processes;
              delete entry.processesAdded;
            }
            if (entry.info) {
              entry.info.state = 'failed';
              entry.info.processStopped = false;
              if (kernelReuse) entry.info.processPid = kernelForeign.pid;
              delete entry.info.processStopReason;
            }
            return entry;
          });
        writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        assert.equal(
          rpc('native.session.read', target()).session.processStopped,
          kernelReuse,
          kernelReuse
            ? 'Kernel birth evidence must distinguish the reused process group'
            : 'legacy cleanup remains unconfirmed without operator attestation',
        );
        if (kernelReuse) {
          assert.ok(alive(kernelForeign.pid), 'The foreign reused group must remain alive');
          check(
            'recorded kernel birth distinguishes a reused group without signalling its current owner',
          );
        } else {
          assert.throws(() => rpc('run.resume', { runId }), /cleanup is unconfirmed/);
          check('legacy cleanup requires explicit descendant confirmation');
        }
      }
      if (withUi) {
        mkdirSync(outDir, { recursive: true });
        const uiPort = await freePort();
        env.FARMSLOT_UI_URL = `http://127.0.0.1:${uiPort}`;
        env.FARMSLOT_CDP_PORT = process.env.FARMSLOT_CDP_PORT ?? '19223';
        ui = spawn(
          process.execPath,
          [
            path.join(sourceRoot, 'node_modules/vite/bin/vite.js'),
            '--host',
            '127.0.0.1',
            '--port',
            String(uiPort),
            '--strictPort',
          ],
          {
            cwd: path.join(sourceRoot, 'apps/command-center/ui'),
            env: { ...env, VITE_FARMSLOT_GATEWAY_URL: env.FARMSLOT_GATEWAY },
            stdio: ['ignore', logFd, logFd],
          },
        );
        const uiDeadline = Date.now() + 120000;
        while (true) {
          try {
            if ((await fetch(env.FARMSLOT_UI_URL)).ok) break;
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
          }
          assert.equal(ui.exitCode, null, 'isolated UI exited');
          assert.ok(Date.now() < uiDeadline, 'isolated UI must start');
          await delay(300);
        }
        uiRoute = `runs?run=${runId}`;
        const proved = await proveRecoveryHint({ cdp, runId, outDir });
        check('recovery hint visible through CDP', proved);
      }
      mode({ mode: 'recover' });
      rpc('run.resume', { runId, ...(legacy ? { confirmStopped: true } : {}) });
      run = await wait(
        get,
        (value) =>
          value.status === 'monitoring' &&
          value.agentContexts.find((item) => item.id === context.id).nativeSession.generation !==
            binding.generation,
        'blocked resume',
      );
      context = run.agentContexts.find((item) => item.id === context.id);
      binding = context.nativeSession;
      snapshot = rpc('native.session.read', target());
      assert.equal(snapshot.session.nativeSessionId, context.runnerSessionId);
      check('blocked resume preserves conversation');
      const workerView = withUi
        ? await prepareBusyWorkerView({
            cdp,
            runId,
            onNavigate: (route) => {
              uiRoute = route;
            },
          })
        : null;
      if (withUi) mode({ holdMs: 45000 });
      rpc('native.session.send', { ...target(), commandId: 'coherence-hold', text: 'hold-turn' });
      if (withUi) {
        const receipt = await proveBusySteering({ cdp, rpc, target, view: workerView, outDir });
        check('busy steering queued through CDP', { commandId: receipt.commandId });
      }
      const queued = rpc('native.session.send', {
        ...target(),
        commandId: 'coherence-queued',
        text: 'queued-steering',
      });
      assert.equal(queued.queued, true);
      assert.equal(queued.submitted, false);
      snapshot = await wait(
        () => rpc('native.session.read', target()),
        (value) =>
          value.commands.some(
            (command) => command.commandId === 'coherence-queued' && command.state === 'completed',
          ),
        'queued steering delivered',
      );
      assert.equal(
        readFileSync(path.join(temporary, 'inputs.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line && JSON.parse(line).text === 'queued-steering').length,
        1,
      );
      check('busy send queues and delivers once');
      if (parkClaim) {
        await proveParkOccupiedClaim({
          rpc,
          runId,
          slotId,
          repo,
          temporary,
          root,
          statusFile,
          session: parkSession,
          restartGateway,
          check,
        });
      } else if (queuedClose) {
        mode({ holdMs: 45000 });
        rpc('native.session.send', { ...target(), commandId: 'receipt-hold', text: 'hold-turn' });
        const pending = rpc('native.session.send', {
          ...target(),
          commandId: 'receipt-cancelled',
          text: 'unsubmitted steering',
        });
        assert.equal(pending.queued, true);
        rpc('native.session.close', target());
        const closed = rpc('native.session.read', target());
        const receipt = closed.commands.find(
          (command) => command.commandId === 'receipt-cancelled',
        );
        assert.equal(
          receipt?.outcome,
          'interrupted',
          'Cancelled queued receipt must remain visible to its task lease',
        );
        assert.equal(receipt.submitted, false);
        check('cancelled unsubmitted steering remains visible in task-scoped gateway reads');
        rpc('run.cancel', { runId });
        await proveQueuedLeaseOwnership({ env, repo, configFile, mode, check });
      } else {
        rpc('run.pause', { runId });
        assert.throws(
          () => rpc('run.adopt', { runId, tmux: externalSession }),
          /Another live native worker owns/,
        );
        check('adoption refuses a live native owner');
        snapshot = rpc('native.session.read', target());
        assert.ok(
          matchesProcess(snapshot.session.processPid, executable),
          'fixture process identity must match before signalling',
        );
        process.kill(snapshot.session.processPid, 'SIGTERM');
        await wait(
          () => rpc('native.session.read', target()),
          (value) => value.session.processStopped,
          'crashed worker stopped before adoption',
        );
        assert.ok(
          !get().agentContexts.find((item) => item.id === context.id).nativeSession.closedAt,
          'adoption starts from a crashed, unclosed gateway binding',
        );
        mode({ mode: 'external-hold' });
        execFileSync('tmux', [
          'new-session',
          '-d',
          '-s',
          wrongSession,
          '-c',
          repo,
          `env CLAUDE_CONFIG_DIR='${env.CLAUDE_CONFIG_DIR}' NATIVE_COHERENCE_CONFIG='${configFile}' '${executable}' --resume '${randomUUID()}' --append-system-prompt '--resume ${context.runnerSessionId}'`,
        ]);
        await wait(
          () => existsSync(path.join(temporary, 'external-ready.json')),
          Boolean,
          'wrong-conversation worker ready',
        );
        assert.throws(
          () => rpc('run.adopt', { runId, tmux: wrongSession }),
          /Adoption requires one live worker/,
        );
        check('adoption refuses a different conversation with a misleading prompt argument');
        execFileSync('tmux', ['kill-session', '-t', `=${wrongSession}`]);
        rmSync(path.join(temporary, 'external-ready.json'));
        execFileSync('tmux', [
          'new-session',
          '-d',
          '-s',
          externalSession,
          '-c',
          repo,
          `env CLAUDE_CONFIG_DIR='${env.CLAUDE_CONFIG_DIR}' NATIVE_COHERENCE_CONFIG='${configFile}' '${executable}' --resume '${context.runnerSessionId}'`,
        ]);
        await wait(
          () => existsSync(path.join(temporary, 'external-ready.json')),
          Boolean,
          'external worker ready',
        );
        const external = JSON.parse(
          readFileSync(path.join(temporary, 'external-ready.json'), 'utf8'),
        );
        const openFiles = execFileSync('lsof', ['-a', '-p', String(external.pid), '-Fn'], {
          encoding: 'utf8',
        });
        assert.ok(
          !openFiles.split('\n').includes(`n${external.transcript}`),
          'resumed worker must not require an open transcript handle',
        );
        rpc('run.adopt', { runId, tmux: externalSession });
        run = get();
        assert.equal(run.transport, 'tmux');
        assert.equal(run.status, 'monitoring');
        assert.equal(
          run.agentContexts.find((item) => item.id === context.id).runnerSessionId,
          context.runnerSessionId,
        );
        check('external recovery adopted');
        mode({ mode: 'external-complete' });
        run = await wait(
          get,
          (value) =>
            value.steps.find((step) => step.name === 'monitor')?.outputs?.awaitingOperator ===
              true ||
            value.agentContexts.find((item) => item.id === context.id).status === 'done' ||
            value.status === 'human-gating' ||
            value.status === 'done',
          'adopted signal completion',
        );
        assert.equal(
          JSON.parse(readFileSync(path.join(repo, '.task/dev/COHERENCE-1/SIGNAL.json'), 'utf8'))
            .outcome,
          'success',
        );
        check('adopted task completes through mark and SIGNAL');
        const completed = rpc(Methods.RUN_INTERACTIVE_DEV_RESOLVE, {
          runId,
          action: 'done-no-pr',
          reason: 'Isolated task completion proof',
        });
        assert.equal(completed.ok, true);
        assert.equal(get().status, 'done');
        check('adopted task closes through the normal operator action');
      }
    }
    execFileSync('tmux', [
      'new-session',
      '-d',
      '-s',
      foreignSession,
      '-c',
      cancelRepo,
      'sleep 600',
    ]);
    const acquireProvider = (capabilityId, ownerRunId) =>
      rpc('runtime.capability.acquire', {
        slotId: cancelSlot,
        capabilityId,
        ownerRunId,
        proofRequirement: { capabilityId, reason: 'Disposable ownership proof', mode: 'state' },
      });
    for (const owner of [cancelRunId, providerRunId, `${providerRunId}-foreign`]) {
      const acquired = acquireProvider('app', owner);
      assert.equal(acquired.ok, true, JSON.stringify(acquired));
    }
    assert.equal(acquireProvider('warm', cancelRunId).ok, true);
    assert.equal(
      rpc('runtime.capability.release', {
        slotId: cancelSlot,
        capabilityId: 'warm',
        ownerRunId: cancelRunId,
      }).ok,
      true,
    );
    const providerDirectory = path.join(temporary, 'providers');
    if (control !== 'teardown-force') {
      const cancelled = rpc('run.cancel', { runId: cancelRunId });
      assert.equal(cancelled.run.status, 'cancelled');
      assert.ok(cancelled.run.slotTeardownSkipped, 'cancel reports skipped foreign slot teardown');
      execFileSync('tmux', ['has-session', '-t', `=${foreignSession}`]);
      check('cancel preserves foreign tmux session');
    }
    const forced = rpc('run.forceComplete', { runId: forceRunId });
    assert.equal(forced.run.status, 'done');
    assert.ok(
      forced.run.slotTeardownSkipped,
      'force-complete reports skipped foreign slot teardown',
    );
    execFileSync('tmux', ['has-session', '-t', `=${foreignSession}`]);
    check('force-complete preserves foreign tmux session');
    assert.equal(
      JSON.parse(readFileSync(statusFile, 'utf8')).slots.find((slot) => slot.slot === forceSlot)
        .current_run_id,
      null,
      'terminal ownership is removed from an occupied slot',
    );
    if (withUi) {
      uiRoute = `runs?run=${forceRunId}`;
      check(
        'foreign cleanup is visible through CDP',
        await proveSharedCleanup({ cdp, runId: forceRunId, outDir }),
      );
      uiRoute = `slot/${forceSlot}`;
      check(
        'occupied workspace reason is visible through CDP',
        await proveHeldWorkspace({ cdp, slotId: forceSlot, outDir }),
      );
    }
    if (control !== 'teardown-force') {
      const beforeRelease = rpc('runtime.capability.status', { slotId: cancelSlot });
      const warm = beforeRelease.leases.find((lease) => lease.capabilityId === 'warm');
      assert.ok(warm.providerCleanupDeferred, 'Already warm provider cleanup is deferred');
      assert.equal(warm.keepWarmUntil, undefined, 'Deferred cleanup has no automatic expiry');
      assert.equal(
        acquireProvider('contender', providerRunId).ok,
        false,
        'Deferred exclusive claim remains held',
      );
      assert.equal(
        rpc('runtime.capability.release', {
          slotId: cancelSlot,
          ownerRunId: `${providerRunId}-foreign`,
          keepWarm: false,
        }).ok,
        true,
      );
      for (const name of ['app', 'dep', 'warm'])
        assert.ok(
          existsSync(path.join(providerDirectory, name)),
          'Foreign release must preserve deferred providers',
        );
      assert.equal(
        acquireProvider('app', `${providerRunId}-new`).ok,
        false,
        'Deferred provider cannot restart dependencies',
      );
      assert.equal(
        acquireProvider('app', providerRunId).ok,
        true,
        'Surviving shared holder remains idempotent',
      );
      check('foreign release preserves deferred providers and exclusive claims');
      // Give both shared lease records an explicit deferred disposition before cleanup.
      rpc('run.forceComplete', { runId: providerRunId });
      for (const name of ['app', 'dep', 'warm'])
        assert.equal(
          rpc('runtime.capability.stopWarm', { slotId: cancelSlot, capabilityId: name }).ok,
          true,
        );
      assert.deepEqual(
        readFileSync(path.join(providerDirectory, 'releases'), 'utf8').trim().split('\n'),
        ['app', 'dep', 'warm'],
        'Shared providers stop once in dependency order',
      );
      check('explicit retained provider cleanup runs once in dependency order');
    }
    const owned = rpc('runtime.capability.acquire', {
      slotId: emptySlot,
      capabilityId: 'owned-server',
      ownerRunId: emptyRunId,
      proofRequirement: {
        capabilityId: 'owned-server',
        reason: 'Real owned-provider proof',
        mode: 'state',
      },
    });
    assert.equal(owned.ok, true, JSON.stringify(owned));
    const providerPid = Number(readFileSync(path.join(emptyRepo, 'owned-server.pid'), 'utf8'));
    assert.ok(
      owned.lease.providerProcesses?.some((frame) => frame.pid === providerPid),
      'Owned server must record its kernel identity',
    );
    assert.equal(
      await (
        await fetch(
          `http://127.0.0.1:${readFileSync(path.join(emptyRepo, 'owned-server.pid.port'), 'utf8')}`,
        )
      ).text(),
      'coherence-server',
    );
    rpc('runtime.capability.release', {
      slotId: emptySlot,
      ownerRunId: emptyRunId,
      keepWarm: true,
    });
    assert.ok(alive(providerPid), 'The owned dev server is warm before cancellation');
    const empty = rpc('run.cancel', { runId: emptyRunId });
    assert.equal(empty.run.status, 'cancelled');
    assert.ok(!empty.run.slotTeardownSkipped, 'an empty owned slot can be released');
    assert.equal(
      JSON.parse(readFileSync(statusFile, 'utf8')).slots.find((slot) => slot.slot === emptySlot)
        .current_run_id,
      null,
      'safe cancellation resets only its owned slot',
    );
    await wait(
      () => alive(providerPid),
      (value) => !value,
      'owned provider really stopped',
    );
    check('owned dev-server cleanup releases the slot without classifying it as foreign');
    check('historical missing pane with incomplete identity does not block cleanup');
    check('empty owned slot releases without counting its census process');
    if (!providersOnly) {
      mode({ mode: 'external-hold' });
      const runtime = rpc('run.create', {
        ...taskParams,
        taskFile: path.join(runtimeTaskDir, 'TASK.md'),
        ticketOrPr: 'COHERENCE-2',
        domain: 'configured-domain',
        slotId: runtimeSlot,
        allowedSlots: [runtimeSlot],
        transport: 'tmux',
        mode: 'interactive',
        runner: 'claude',
        model: 'opus',
        safetyTier: 'full-auto',
        skipPrepare: true,
      });
      runtimeRunId = runtime.run.id;
      await wait(
        () => rpc('run.get', { runId: runtimeRunId }).run,
        (value) => value.steps.some((step) => step.name === 'write-task' && step.status === 'done'),
        'tmux pre-written task runtime',
      );
      assert.ok(
        existsSync(path.join(runtimeTaskDir, 'mark')),
        'tmux pre-written task runtime must be initialized',
      );
      for (const [file, contents] of Object.entries(runtimeOriginal))
        assert.equal(
          readFileSync(path.join(runtimeTaskDir, file), 'utf8'),
          contents,
          `Authored ${file} must survive runtime initialization`,
        );
      if (missingContract) {
        const handoff = JSON.parse(runtimeOriginal['inputs/handoff.json']);
        const contract = JSON.parse(
          readFileSync(path.join(runtimeTaskDir, 'inputs/worker-terminal-contract.json'), 'utf8'),
        );
        assert.equal(
          contract.commands.complete.report,
          handoff.report,
          'Missing contract must retain the authored handoff report path',
        );
        assert.ok(contract.commands.complete.artifacts.includes(handoff.learnings));
        check('authored handoff report survives reconstruction of a missing terminal contract');
      }
      rpc('run.cancel', { runId: runtimeRunId });
      check('tmux pre-written runtime preserves the authored task and checklist');
      assert.ok(
        existsSync(path.join(taskDir, 'mark')),
        'pre-written task runtime must be initialized',
      );
      check('pre-written task uses shared runtime');
    }
  }
  proveCleanupGuards({
    fixtures: cleanupGuards,
    rpc,
    readStatus: () => JSON.parse(readFileSync(statusFile, 'utf8')),
    check,
    executable,
    configFile,
    temporary,
  });
  if (providerRecovery)
    await proveProviderRecovery({
      fixtures: cleanupGuards,
      rpc,
      restartGateway,
      capabilityFile: env.FARMSLOT_CAPABILITY_STORE_FILE,
      readStatus: () => JSON.parse(readFileSync(statusFile, 'utf8')),
      wait,
      check,
      executable,
      configFile,
      temporary,
    });
  if (reconcileHeld) {
    const held = JSON.parse(readFileSync(statusFile, 'utf8')).slots.filter(
      (slot) => slot.lifecycle === 'held' && slot.phase === 'occupied',
    );
    assert.ok(held.length, 'Occupied fixtures must exist before reconciliation');
    env.FARMSLOT_DISABLE_ORCHESTRATION = '0';
    env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
    await restartGateway();
    await delay(65000);
    const after = JSON.parse(readFileSync(statusFile, 'utf8')).slots;
    for (const before of held) {
      const slot = after.find((row) => row.slot === before.slot);
      assert.equal(slot.lifecycle, 'held', 'Reconciliation must preserve occupied holds');
      assert.equal(slot.phase, 'occupied');
      assert.equal(slot.held_reason, before.held_reason);
    }
    const log = readFileSync(path.join(temporary, 'gateway.log'), 'utf8');
    assert.ok(
      log.split(`${held[0].slot} remains held for workspace occupants`).length >= 3,
      'Startup and periodic reconciliation must both inspect the hold',
    );
    execFileSync('tmux', ['has-session', '-t', `=${foreignSession}`]);
    check('occupied workspace protection survives gateway restart and a real reconciliation tick');
    const occupied = after.find((row) => row.slot === held[0].slot);
    const claimRunId = randomUUID();
    env.FARMSLOT_DISABLE_RUN_ENGINE_START = '0';
    await restartGateway(() => {
      writeJson(path.join(root, '.runs', `${claimRunId}.json`), {
        id: claimRunId,
        project,
        ticketOrPr: `COHERENCE-HELD-${claimRunId}`,
        flowType: 'dev',
        mode: 'interactive',
        transport: 'tmux',
        status: 'slot-finding',
        slotId: occupied.slot,
        taskFile: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        decisions: [],
        metrics: { nudgeCount: 0, runner: 'claude', model: 'fixture' },
        engineState: {
          generation: randomUUID(),
          flags: { warmSessionReuse: true, skipPrepare: true },
        },
        steps: FLOW_STEPS.dev.map((name, index) => ({
          name,
          status:
            name === 'find-slot'
              ? 'running'
              : index < FLOW_STEPS.dev.indexOf('find-slot')
                ? 'done'
                : 'pending',
        })),
      });
    });
    const claimRun = await wait(
      () => rpc('run.get', { runId: claimRunId }).run,
      (run) =>
        !['pending', 'running'].includes(
          run.steps.find((step) => step.name === 'find-slot').status,
        ),
      'warm binding claim refusal',
    );
    assert.match(
      JSON.stringify(claimRun),
      /Warm-session reuse slot.*slot remains occupied/,
      'Occupied hold must refuse warm binding',
    );
    const stillOccupied = JSON.parse(readFileSync(statusFile, 'utf8')).slots.find(
      (row) => row.slot === occupied.slot,
    );
    for (const key of [
      'lifecycle',
      'phase',
      'current_run_id',
      'handoff_run_id',
      'held_reason',
      'slot_epoch',
    ])
      assert.equal(stillOccupied[key], occupied[key], `Refused warm binding preserves ${key}`);
    check('warm binding refuses occupied holds without changing their ownership or cleanup fence');
  }
  if (realFixture)
    await proveRealAdoption({ fixture: realFixture, rpc, wait, check, generationGuard, temporary });
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
  if (withUi) writeJson(path.join(outDir, 'browser-proof.json'), { passed: true, checks });
} catch (error) {
  if (existsSync(path.join(temporary, 'control-applied')))
    console.error(
      `Applied control: ${readFileSync(path.join(temporary, 'control-applied'), 'utf8')}`,
    );
  if (existsSync(path.join(temporary, 'gateway.log'))) {
    let log = readFileSync(path.join(temporary, 'gateway.log'), 'utf8').slice(-6000);
    for (const [key, value] of Object.entries(env ?? {}))
      if (value && /token|key|secret|password|credential/i.test(key))
        log = log.replaceAll(value, '[redacted]');
    console.error(log);
  }
  throw error;
} finally {
  await cleanupFixture();
}

async function cleanupFixture() {
  if (kernelForeign && kernelForeign.exitCode === null) {
    const exited = once(kernelForeign, 'exit');
    kernelForeign.kill('SIGTERM');
    await exited;
  }
  if (withUi && env?.FARMSLOT_UI_URL && runId) {
    try {
      cdp('close', uiRoute);
    } catch (error) {
      console.error(
        `Fixture tab cleanup failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      );
    }
  }
  if (runId && gateway?.exitCode === null) {
    try {
      const run = rpc('run.get', { runId }).run;
      if (!['done', 'cancelled', 'failed'].includes(run.status)) rpc('run.cancel', { runId });
    } catch (error) {
      console.error(
        `Fixture run cleanup failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
      );
    }
  }
  for (const session of [
    externalSession,
    wrongSession,
    foreignSession,
    parkSession,
    `${parkSession}-owner`,
    runtimeSlot,
    ...(realFixture ? [realFixture.session] : []),
    ...cleanupGuards.flatMap((fixture) => (fixture.session ? [fixture.session] : [])),
  ]) {
    try {
      execFileSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' });
      execFileSync('tmux', ['kill-session', '-t', `=${session}`]);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  for (const directory of [
    emptyRepo,
    ...cleanupGuards.filter((fixture) => fixture.fault).map((fixture) => fixture.repo),
  ]) {
    for (const name of ['owned-server.pid', 'owned-server.original.pid']) {
      const serverPidFile = path.join(directory, name);
      if (existsSync(serverPidFile)) {
        const providerPid = Number(readFileSync(serverPidFile, 'utf8'));
        if (Number.isSafeInteger(providerPid) && providerPid > 0 && alive(providerPid)) {
          assert.ok(
            matchesProcess(providerPid, path.join(bin, 'claude')),
            'Fixture provider identity changed',
          );
          process.kill(providerPid, 'SIGTERM');
          await wait(
            () => alive(providerPid),
            (value) => !value,
            'fixture provider shutdown',
            20000,
          );
        }
      }
    }
  }
  if (gateway && gateway.exitCode === null) {
    const stopped = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    const force = setTimeout(() => gateway.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(force);
  }
  if (ui && ui.exitCode === null) {
    const stopped = once(ui, 'exit');
    ui.kill('SIGTERM');
    const force = setTimeout(() => ui.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(force);
  }
  const hostFile = path.join(temporary, 'native/host.json');
  if (existsSync(hostFile)) {
    const host = JSON.parse(readFileSync(hostFile, 'utf8'));
    if (alive(host.pid)) {
      assert.ok(
        matchesProcess(host.pid, path.join(temporary, 'native')),
        'fixture supervisor identity changed',
      );
      process.kill(host.pid, 'SIGTERM');
      await wait(
        () => alive(host.pid),
        (value) => !value,
        'fixture supervisor shutdown',
        20000,
      );
    }
  }
  if (logFd !== undefined) closeSync(logFd);
  // Native host shutdown is owned by its supervisor. Keep failed fixture state
  // available for diagnostics rather than deleting it under a surviving host.
  if (process.env.FARMSLOT_KEEP_COHERENCE_FIXTURE !== '1')
    rmSync(temporary, { recursive: true, force: true });
}
