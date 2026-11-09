import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import {
  projectWorkerTemplateSource,
  selectExecutionTemplate,
  taskInit,
} from '@farmslot/agent-runtime';
import type { ExecResult, NodeLinkOperation } from '@farmslot/protocol';
import {
  TASK_RUNTIME_CLOSEOUT_MS,
  TASK_RUNTIME_TIMEOUT_MS,
  type TaskRuntimeRequest,
} from '@farmslot/slot-config/task-runtime';

import type { SlotVars } from '../core/config.js';
import * as realExec from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import * as registry from '../fleet/machine-registry.js';
import * as nodeLinkProcess from '../fleet/node-link-process.js';
import * as realRpc from '../fleet/node-rpc.js';
import * as remoteCommands from '../node-support/remote-command.js';

import * as runtimeScript from './agent-runtime-script.js';
import * as sidecars from './sidecars.js';

let fixtureFarm = '';
let executionCount = 0;
let cliCommand: string | undefined;
let cliOptions: realExec.ExecOnSlotOptions | undefined;
let advertisedRuntime: 1 | undefined = 1;
let advertisedOperations: NodeLinkOperation[] | undefined = ['task.runtime'];
let runtimeError: Error | undefined;
const runtimeResult: ExecResult = { exitCode: 5, stdout: 'TASK_INPUT_CHANGED', stderr: '' };
const runtimeRequests: TaskRuntimeRequest[] = [];
let inheritedEnvironment: NodeJS.ProcessEnv | undefined;
let initialize: (() => Promise<ExecResult>) | undefined;
const transfers: string[] = [];
mock.module('./sidecars.js', {
  namedExports: {
    ...sidecars,
    copyPreparedTaskRootSidecars: async (params: sidecars.CopyPreparedTaskRootSidecarsParams) => {
      transfers.push('root');
      return sidecars.copyPreparedTaskRootSidecars(params);
    },
    copyTaskDirSubdirectories: async (params: sidecars.CopyTaskDirSubdirectoriesParams) => {
      transfers.push('directories');
      return sidecars.copyTaskDirSubdirectories(params);
    },
  },
});
mock.module('@farmslot/slot-config/task-runtime', {
  namedExports: {
    TASK_RUNTIME_TIMEOUT_MS,
    TASK_RUNTIME_CLOSEOUT_MS,
    runTaskRuntime: async (
      request: TaskRuntimeRequest,
      _farm: string,
      environment?: NodeJS.ProcessEnv,
    ) => {
      runtimeRequests.push(request);
      if (runtimeError) throw runtimeError;
      inheritedEnvironment = environment;
      if (initialize) return initialize();
      return { exitCode: 2, stdout: 'TASK_INIT_PARTIAL', stderr: '' };
    },
  },
});
function fixtureSlot(root: string): SlotVars {
  return {
    slotId: 'fixture-1',
    host: 'localhost',
    machine: 'local',
    platform: 'cli',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: root,
    remoteRepo: root,
    session: 'fixture-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'fixture',
    resourceVars: {},
  };
}
mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    execOnSlot: async (_slot: SlotVars, command: string, options?: realExec.ExecOnSlotOptions) => {
      executionCount += 1;
      cliCommand = command;
      cliOptions = options;
      return { exitCode: 2, stdout: 'TASK_INIT_PARTIAL', stderr: '' };
    },
  },
});
mock.module('./agent-runtime-script.js', {
  namedExports: { ...runtimeScript, farmslotDirectoryForSlot: async () => '/node/install' },
});
mock.module('../fleet/machine-registry.js', {
  namedExports: {
    ...registry,
    getNode: () => ({
      taskRuntime: advertisedRuntime,
      nodeLink: { operations: advertisedOperations },
    }),
  },
});
let remoteRequest: TaskRuntimeRequest | undefined;
let linked = false;
let linkedRequest: TaskRuntimeRequest | undefined;
let supportPending = false;
let supportBudget: number | undefined;
mock.module('../fleet/node-link-policy.js', {
  namedExports: { usesNodeLink: () => linked },
});
mock.module('../fleet/node-link-process.js', {
  namedExports: {
    ...nodeLinkProcess,
    taskRuntimeThroughNodeLink: async (_slot: SlotVars, request: TaskRuntimeRequest) => {
      linkedRequest = request;
      if (runtimeError) throw runtimeError;
      return runtimeResult;
    },
  },
});
mock.module('../node-support/remote-command.js', {
  namedExports: {
    ...remoteCommands,
    resolveRemoteFarmCommand: async (
      _slot: SlotVars,
      support: string,
      options?: Parameters<typeof remoteCommands.resolveRemoteFarmCommand>[2],
    ) => {
      supportBudget = options?.budgetMs;
      if (supportPending)
        throw new remoteCommands.NodeSupportPendingError('support delivery exceeded its budget');
      return path.isAbsolute(support) ? support : '/captured/support';
    },
  },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    ...realRpc,
    nodeTaskRuntime: async (_machine: string, request: TaskRuntimeRequest) => {
      remoteRequest = request;
      if (runtimeError) throw runtimeError;
      return runtimeResult;
    },
  },
});
const fresh: string = './hosted-task-init.js?partial-preservation';
const {
  initializeHostedTaskOnSlot,
  verifyHostedTaskOnSlot,
  hostedTaskRequest,
  syncHostedTaskSidecars,
} = (await import(fresh)) as typeof import('./hosted-task-init.js');

test('partial initialization refuses before any gateway sidecar replaces retained files', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'partial-hosted-task-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixtureFarm = root;
  const gateway = path.join(root, 'gateway');
  const worker = path.join(root, 'worker');
  const templates = path.join(root, 'templates');
  fs.mkdirSync(path.join(templates, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(templates, 'worker/dev.md'), '# Task\n- [ ] Observe\n');
  const selected = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('fixture', templates)],
    flow: 'dev',
    platform: 'cli',
  });
  for (const directory of [gateway, worker]) {
    fs.mkdirSync(path.join(directory, 'inputs'), { recursive: true });
    for (const file of ['mark', 'CHECKLIST.md', 'inputs/handoff.json'])
      fs.writeFileSync(
        path.join(directory, file),
        directory === worker ? 'keep-owned' : 'old-gateway',
      );
  }
  fs.writeFileSync(
    path.join(worker, 'checklist-target.json'),
    '{"checklist":"REVIEW.md","signal":"REVIEW-SIGNAL.json"}',
  );
  fs.writeFileSync(path.join(worker, 'inputs/recipe-binding.json'), '{}');
  const files = [
    'mark',
    'CHECKLIST.md',
    'inputs/handoff.json',
    'checklist-target.json',
    'inputs/recipe-binding.json',
  ];
  const before = files.map((file) => fs.readFileSync(path.join(worker, file), 'utf8'));
  const slot = fixtureSlot(root);
  executionCount = 0;
  await assert.rejects(
    initializeHostedTaskOnSlot(slot, gateway, {
      binding: 'static',
      template: selected,
      task: {
        taskDir: worker,
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Partial task', sourceKind: 'text' },
        handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'original' },
      },
    }),
    /TASK_INIT_PARTIAL/,
  );
  assert.equal(executionCount, 0, 'local task initialization must not start a CLI process');
  assert.equal(runtimeRequests.length, 1, 'a refused partial initialization must not be retried');
  assert.equal(runtimeRequests[0].action, 'init');
  assert.deepEqual(
    files.map((file) => fs.readFileSync(path.join(worker, file), 'utf8')),
    before,
  );
  assert.equal(
    fs.readdirSync(worker).some((file) => file.startsWith('.task-init-')),
    false,
  );
});

test('retained verification imports the verifier without a CLI and preserves its refusal', async () => {
  runtimeRequests.length = 0;
  executionCount = 0;
  await assert.rejects(verifyHostedTaskOnSlot(fixtureSlot(fixtureFarm), '/retained/task'), {
    message: 'Retained task verification refused: TASK_INIT_PARTIAL',
  });
  assert.equal(executionCount, 0, 'retained verification must not start a CLI process');
  assert.equal(runtimeRequests.length, 1);
  assert.equal(runtimeRequests[0].action, 'verify');
  assert.equal(runtimeRequests[0].taskPath, '/retained/task');
});

test('hosted requests keep the installed request shape for ordinary runners', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-request-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(root, 'worker/dev.md'), '# Task\n- [ ] Observe\n');
  const template = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('fixture', root)],
    flow: 'dev',
    platform: 'cli',
  });
  for (const runner of [undefined, 'claude', 'codex', 'pi', 'scripted']) {
    const request = JSON.parse(
      hostedTaskRequest('fixture-1', {
        runner,
        binding: 'static',
        template,
        task: {
          taskDir: '/fixture/task',
          flow: 'dev',
          platform: 'cli',
          task: { title: 'Task', sourceKind: 'text' },
          handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'attempt' },
        },
      }),
    );
    assert.equal(Object.hasOwn(request, 'runner'), runner === 'scripted');
    if (runner === 'scripted') assert.equal(request.runner, 'scripted');
    assert.equal(Object.hasOwn(request, 'scriptedCommand'), false);
  }
  // An artifact-only scripted command run asks the node for the command-result contract.
  const scripted = JSON.parse(
    hostedTaskRequest('fixture-1', {
      runner: 'scripted',
      scriptedCommand: true,
      binding: 'static',
      template,
      task: {
        taskDir: '/fixture/task',
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Task', sourceKind: 'text' },
        handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'attempt' },
      },
    }),
  );
  assert.equal(scripted.scriptedCommand, true);
});

test('remote verification stays on its node with the selected provider and captured pack', async () => {
  runtimeRequests.length = 0;
  const slot = {
    ...fixtureSlot(fixtureFarm),
    host: 'remote.invalid',
    machine: 'remote-node',
    machineEnv: { MM_HARNESS_PACKAGE_ROOT: '/node/provider' },
  };
  await assert.rejects(verifyHostedTaskOnSlot(slot, '/node/task'), {
    message: 'Retained task verification refused: TASK_INPUT_CHANGED',
  });
  assert.equal(runtimeRequests.length, 0);
  assert.deepEqual(remoteRequest, {
    action: 'verify',
    taskPath: '/node/task',
    supportDir: '/captured/support',
    env: { MM_HARNESS_PACKAGE_ROOT: '/node/provider' },
  });
});

test('written task stages sidecars once after QA inputs and mirrors all producer bytes', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-staging-')));
  t.after(() => {
    initialize = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const gateway = path.join(root, 'gateway');
  const worker = path.join(root, 'worker');
  const templates = path.join(root, 'templates');
  fs.mkdirSync(path.join(templates, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(templates, 'worker/dev.md'), '# Task\n- [ ] Observe\n');
  const template = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('fixture', templates)],
    flow: 'dev',
    platform: 'cli',
  });
  const task = {
    taskDir: worker,
    flow: 'dev',
    platform: 'cli',
    task: { title: 'Sidecars', sourceKind: 'text' as const },
    handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'sidecars' },
  };
  const sidecarFiles = [
    'assets/image.png',
    'inputs/context.json',
    'artifacts/recipe.json',
    'subtasks/index.json',
    'task-actions/index.json',
  ];
  for (const file of sidecarFiles) {
    fs.mkdirSync(path.dirname(path.join(gateway, file)), { recursive: true });
    fs.writeFileSync(path.join(gateway, file), Buffer.from([0, 1, 128, 255]));
  }
  fs.writeFileSync(path.join(gateway, 'inputs/context.json.worker'), 'stale mirror');
  fs.writeFileSync(path.join(gateway, '.task-init.json'), 'private gateway input');
  initialize = async () => {
    const result = await taskInit({ ...task, template: { sources: [], selection: template } });
    fs.mkdirSync(path.join(worker, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(worker, 'inputs/recipe-binding.json'), '{"identity":null}\n');
    fs.writeFileSync(
      path.join(worker, 'artifacts/harness-provenance.json'),
      '{"node":"receipt"}\n',
    );
    return { exitCode: 0, stdout: JSON.stringify({ status: 'ok', data: result }), stderr: '' };
  };
  transfers.length = 0;
  const reference = await initializeHostedTaskOnSlot(
    fixtureSlot(root),
    gateway,
    { task, template, binding: 'static' },
    undefined,
    { deferSidecars: true },
  );
  assert.deepEqual(transfers, []);
  const produced = [
    'TASK.md',
    'CHECKLIST.md',
    'mark',
    'inputs/handoff.json',
    'inputs/worker-terminal-contract.json',
    'inputs/recipe-binding.json',
    'artifacts/harness-provenance.json',
  ];
  for (const file of produced)
    assert.deepEqual(
      fs.readFileSync(path.join(gateway, file)),
      fs.readFileSync(path.join(worker, file)),
    );
  fs.writeFileSync(
    path.join(gateway, 'inputs/qa.json'),
    JSON.stringify({ executionTemplate: reference }),
  );
  await syncHostedTaskSidecars(fixtureSlot(root), gateway, worker);
  assert.deepEqual(transfers, ['root', 'directories']);
  for (const file of [...sidecarFiles, ...produced, 'inputs/qa.json'])
    assert.deepEqual(
      fs.readFileSync(path.join(worker, file)),
      fs.readFileSync(path.join(gateway, file)),
      file,
    );
  assert.equal(fs.statSync(path.join(worker, 'mark')).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(worker, '.task-init.json')), false);
  assert.equal(fs.existsSync(path.join(worker, 'inputs/context.json.worker')), false);
});

test('remote task calls retain the machine-selected workspace root', async () => {
  const slot = {
    ...fixtureSlot(fixtureFarm),
    host: 'remote.invalid',
    machine: 'remote-node',
    machineEnv: { FARMSLOT_WORKSPACE: '/node/selected-workspace' },
  };
  await assert.rejects(verifyHostedTaskOnSlot(slot, '/node/task'), /TASK_INPUT_CHANGED/);
  assert.equal(remoteRequest?.supportDir, '/node/selected-workspace');
});

test('a local node-link pilot uses its fenced task operation and local support root', async (t) => {
  linked = true;
  t.after(() => {
    linked = false;
  });
  remoteRequest = undefined;
  runtimeRequests.length = 0;
  await assert.rejects(
    verifyHostedTaskOnSlot(fixtureSlot(fixtureFarm), '/node/task'),
    /TASK_INPUT_CHANGED/,
  );
  assert.equal(remoteRequest, undefined, 'node-link must not use the classic task RPC');
  assert.equal(
    runtimeRequests.length,
    0,
    'node-link must not initialize through gateway-local authority',
  );
  assert.equal(linkedRequest?.action, 'verify');
  assert.equal(linkedRequest?.supportDir, path.resolve(import.meta.dirname, '../../../..'));
});

test('remote support delivery retains its verification budget and timeout refusal', async (t) => {
  supportPending = true;
  t.after(() => {
    supportPending = false;
  });
  remoteRequest = undefined;
  const slot = { ...fixtureSlot(fixtureFarm), host: 'remote.invalid', machine: 'remote-node' };
  await assert.rejects(verifyHostedTaskOnSlot(slot, '/node/task'), {
    message: 'Retained task verification refused: support delivery exceeded its budget',
  });
  assert.equal(supportBudget, TASK_RUNTIME_TIMEOUT_MS.verify);
  assert.equal(remoteRequest, undefined);
});

test('local task libraries retain the command environment captured at gateway boot', async (t) => {
  const previous = process.env.F416_TRANSIENT_PROVIDER_ENV;
  const captured = realExec.localCommandEnvironment().F416_TRANSIENT_PROVIDER_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.F416_TRANSIENT_PROVIDER_ENV;
    else process.env.F416_TRANSIENT_PROVIDER_ENV = previous;
  });
  process.env.F416_TRANSIENT_PROVIDER_ENV = 'another invocation';
  await assert.rejects(
    verifyHostedTaskOnSlot(fixtureSlot(fixtureFarm), '/node/task'),
    /TASK_INIT_PARTIAL/,
  );
  assert.equal(inheritedEnvironment?.F416_TRANSIENT_PROVIDER_ENV, captured);
});

for (const transport of ['local', 'classic', 'node-link'] as const) {
  const slot = () => ({
    ...fixtureSlot(fixtureFarm),
    ...(transport === 'classic' ? { host: 'remote.invalid', machine: 'remote-node' } : {}),
  });

  test(`${transport} node without task.runtime uses the CLI once and logs the reason`, async (t) => {
    advertisedRuntime = transport === 'node-link' ? 1 : undefined;
    advertisedOperations = transport === 'node-link' ? ['process.run'] : ['task.runtime'];
    linked = transport === 'node-link';
    t.after(() => {
      advertisedRuntime = 1;
      advertisedOperations = ['task.runtime'];
      linked = false;
    });
    const log = t.mock.method(console, 'warn', () => {});
    executionCount = 0;
    runtimeRequests.length = 0;
    remoteRequest = linkedRequest = undefined;
    const taskPath = "/node/task with 'quotes'";
    await assert.rejects(verifyHostedTaskOnSlot(slot(), taskPath), /TASK_INIT_PARTIAL/);
    assert.equal(executionCount, 1);
    assert.ok(cliCommand?.endsWith(`'task' 'verify' ${shellQuote(taskPath)}`));
    assert.deepEqual(cliOptions, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, noRetry: true });
    assert.equal(runtimeRequests.length, 0);
    assert.equal(remoteRequest, undefined);
    assert.equal(linkedRequest, undefined);
    assert.deepEqual(
      log.mock.calls.map((call) => call.arguments),
      [
        [
          `[hosted-task] Node ${slot().machine} does not advertise task.runtime; using CLI for verify.`,
        ],
      ],
    );
  });

  test(`${transport} node advertising task.runtime uses the runtime without CLI fallback on refusal`, async (t) => {
    linked = transport === 'node-link';
    advertisedRuntime = linked ? undefined : 1;
    advertisedOperations = linked ? ['task.runtime'] : ['process.run'];
    t.after(() => {
      linked = false;
      advertisedRuntime = 1;
      advertisedOperations = ['task.runtime'];
    });
    const log = t.mock.method(console, 'warn', () => {});
    executionCount = 0;
    runtimeRequests.length = 0;
    remoteRequest = linkedRequest = undefined;
    await assert.rejects(
      verifyHostedTaskOnSlot(slot(), '/node/task'),
      /TASK_(INIT_PARTIAL|INPUT_CHANGED)/,
    );
    assert.equal(executionCount, 0);
    assert.equal(runtimeRequests.length, transport === 'local' ? 1 : 0);
    assert.equal(Boolean(remoteRequest), transport === 'classic');
    assert.equal(Boolean(linkedRequest), transport === 'node-link');
    assert.equal(log.mock.callCount(), 0);
  });

  test(`${transport} task.runtime transport failure never retries through the CLI`, async (t) => {
    linked = transport === 'node-link';
    runtimeError = new Error('task.runtime connection lost after send');
    t.after(() => {
      linked = false;
      runtimeError = undefined;
    });
    const log = t.mock.method(console, 'warn', () => {});
    executionCount = 0;
    await assert.rejects(verifyHostedTaskOnSlot(slot(), '/node/task'), runtimeError);
    assert.equal(executionCount, 0);
    assert.equal(log.mock.callCount(), 0);
  });
}

test('initialization without task.runtime preserves the CLI command, bounds and no-retry refusal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-cli-fallback-'));
  advertisedRuntime = undefined;
  t.after(() => {
    advertisedRuntime = 1;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const log = t.mock.method(console, 'warn', () => {});
  fs.mkdirSync(path.join(root, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(root, 'worker/dev.md'), '# Task\n- [ ] Observe\n');
  const template = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('fixture', root)],
    flow: 'dev',
    platform: 'cli',
  });
  executionCount = 0;
  runtimeRequests.length = 0;
  await assert.rejects(
    initializeHostedTaskOnSlot(fixtureSlot(root), path.join(root, 'gateway'), {
      binding: 'static',
      template,
      task: {
        taskDir: path.join(root, 'task'),
        flow: 'dev',
        platform: 'cli',
        task: { title: 'CLI fallback', sourceKind: 'text' },
        handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'fallback' },
      },
    }),
    /TASK_INIT_PARTIAL/,
  );
  assert.equal(executionCount, 1);
  assert.match(cliCommand!, /'internal' 'task-init' '[^']*\/\.task-init-[^']+\.json'$/);
  assert.deepEqual(cliOptions, { timeout: 600_000, maxBuffer: 8 * 1024 * 1024, noRetry: true });
  assert.equal(runtimeRequests.length, 0);
  assert.equal(
    fs.readdirSync(path.join(root, 'task')).some((file) => file.startsWith('.task-init-')),
    false,
  );
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [['[hosted-task] Node local does not advertise task.runtime; using CLI for init.']],
  );
});
