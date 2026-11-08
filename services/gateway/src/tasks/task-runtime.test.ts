import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { projectWorkerTemplateSource, selectExecutionTemplate } from '@farmslot/agent-runtime';
import {
  parseTaskRuntimeRequest,
  runTaskRuntime,
  type TaskRuntimeRequest,
} from '@farmslot/slot-config/task-runtime';

const repo = path.resolve(import.meta.dirname, '../../../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const distribution = path.join(root, 'installation');
const cli = path.join(distribution, 'packages/cli');
fs.mkdirSync(cli, { recursive: true });
fs.writeFileSync(path.join(distribution, 'yarn.lock'), '');
fs.writeFileSync(path.join(distribution, 'DEPLOYED-REVISION.json'), '{}');
fs.mkdirSync(path.join(distribution, 'packages/agent-runtime'), { recursive: true });
fs.copyFileSync(
  path.join(repo, 'packages/agent-runtime/package.json'),
  path.join(distribution, 'packages/agent-runtime/package.json'),
);
for (const directory of ['src', 'scripts', 'bin'])
  fs.cpSync(
    path.join(repo, 'packages/agent-runtime', directory),
    path.join(distribution, 'packages/agent-runtime', directory),
    { recursive: true, filter: (file) => !file.endsWith('.test.ts') },
  );
fs.cpSync(path.join(repo, 'packages/cli/src'), path.join(cli, 'src'), {
  recursive: true,
  filter: (file) => !file.endsWith('.test.ts'),
});
fs.cpSync(path.join(repo, 'packages/cli/bin'), path.join(cli, 'bin'), { recursive: true });
fs.writeFileSync(
  path.join(cli, 'package.json'),
  JSON.stringify({ name: '@farmslot/cli', version: '1.0.0', type: 'module' }),
);
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
const config = JSON.parse(fs.readFileSync(path.join(repo, 'packages/cli/tsconfig.json'), 'utf8'));
config.extends = path.join(repo, 'apps/command-center/tsconfig.base.json');
for (const key of Object.keys(config.compilerOptions.paths))
  config.compilerOptions.paths[key] = config.compilerOptions.paths[key].map((entry: string) =>
    path.resolve(repo, 'packages/cli', entry),
  );
config.compilerOptions.paths['@farmslot/agent-runtime'] = [
  path.join(distribution, 'packages/agent-runtime/src/index.ts'),
];
config.compilerOptions.paths['@farmslot/agent-runtime/*'] = [
  path.join(distribution, 'packages/agent-runtime/src/*'),
];
fs.writeFileSync(path.join(cli, 'tsconfig.json'), JSON.stringify(config));
const checkout = path.join(root, 'checkout');
const project = path.join(root, 'projects/fixture');
fs.mkdirSync(checkout);
fs.mkdirSync(path.join(root, 'pool'));
fs.mkdirSync(path.join(project, 'templates/worker'), { recursive: true });
fs.writeFileSync(
  path.join(project, 'project.json'),
  JSON.stringify({ name: 'fixture', task_dir: 'tasks', execution_templates: { sources: [] } }),
);
fs.writeFileSync(path.join(project, 'templates/worker/dev.md'), '# Task\n\n- [ ] Observe\n');
fs.writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    project: 'fixture',
    platform: 'cli',
    slots: [{ id: 'fixture-1', repo: checkout }],
  }),
);
const selected = selectExecutionTemplate({
  sources: [projectWorkerTemplateSource('fixture', path.join(project, 'templates'))],
  flow: 'dev',
  platform: 'cli',
});
const taskDir = path.join(checkout, 'tasks/dev/task');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_CLI: path.join(cli, 'bin/farmslot.mjs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
};
delete env.FARMSLOT_ROOT;
const request: TaskRuntimeRequest = {
  action: 'verify',
  taskPath: taskDir,
  supportDir: root,
  env: {},
};
function wireRequest() {
  const file = path.join(taskDir, '.task-init-00000000-0000-4000-8000-000000000000.json');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      slotId: 'fixture-1',
      binding: 'static',
      task: {
        taskDir,
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Thread parity', sourceKind: 'text', acceptanceCriteria: ['Keep bytes'] },
        handoff: {
          surface: 'farmslot',
          project: 'fixture',
          attemptId: 'attempt',
          startedAt: '2026-11-08T00:00:00Z',
        },
      },
      template: {
        sourceId: selected.entry.sourceId,
        id: selected.entry.id,
        sha256: selected.entry.sha256,
        selectionReason: selected.reason,
      },
    }),
  );
  return file;
}
function cliRun(args: string[], environment: NodeJS.ProcessEnv = env) {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [path.join(cli, 'bin/farmslot.mjs'), '--json', ...args],
    {
      env: environment,
      cwd: checkout,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    ms: performance.now() - started,
  };
}
function snapshot() {
  return fs
    .readdirSync(taskDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(taskDir, file),
        fs.readFileSync(file).toString('base64'),
        fs.statSync(file).mode & 0o777,
      ];
    })
    .sort();
}

function normalizeOutput(text: string, result: string): string {
  const data = JSON.parse(result).data;
  return text
    .replaceAll(data.executionProvenance.pin, '<pin>')
    .replace(/"resolvedAt": "[^"]+"/g, '"resolvedAt": "<resolvedAt>"')
    .replaceAll(data.executionProvenance.recordedAt, '<recordedAt>');
}
function taskBytes() {
  return fs
    .readdirSync(taskDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(taskDir, file),
        fs.readFileSync(file, 'utf8'),
        fs.statSync(file).mode & 0o777,
      ];
    })
    .sort();
}

function parityCase<Fixture>(
  name: string,
  baseline: () => Fixture | Promise<Fixture>,
  verify: (t: import('node:test').TestContext, fixture: Fixture) => Promise<void>,
) {
  let fixture: { value: Fixture } | undefined;
  test(`${name}: CLI baseline`, { timeout: 5000 }, async () => {
    fixture = { value: await baseline() };
  });
  test(`${name}: thread parity`, { timeout: 5000 }, async (t) => {
    assert(fixture, 'CLI baseline completed');
    await verify(t, fixture.value);
  });
}

parityCase(
  'fresh init preserves task bytes, modes and provenance',
  () => {
    const before = cliRun(['internal', 'task-init', wireRequest()]);
    assert.equal(before.exitCode, 0, before.stdout + before.stderr);
    return { before, files: taskBytes() };
  },
  async (t, { before, files }) => {
    fs.rmSync(taskDir, { recursive: true });
    const started = performance.now();
    const actual = await runTaskRuntime(
      { ...request, action: 'init', taskPath: wireRequest() },
      root,
      env,
    );
    t.diagnostic(
      `CLI fresh init ${before.ms.toFixed(1)} ms; thread fresh init ${(performance.now() - started).toFixed(1)} ms`,
    );
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.deepEqual(
      JSON.parse(normalizeOutput(actual.stdout, actual.stdout)),
      JSON.parse(normalizeOutput(before.stdout, before.stdout)),
    );
    assert.deepEqual(
      taskBytes().map(([file, text, mode]) => [
        file,
        normalizeOutput(String(text), actual.stdout),
        mode,
      ]),
      files.map(([file, text, mode]) => [file, normalizeOutput(String(text), before.stdout), mode]),
    );
  },
);

parityCase(
  'retained init preserves every byte and exact result',
  () => {
    const files = snapshot();
    return { files, before: cliRun(['internal', 'task-init', wireRequest()]) };
  },
  async (_t, { files, before }) => {
    const actual = await runTaskRuntime(
      { ...request, action: 'init', taskPath: wireRequest() },
      root,
      env,
    );
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.equal(actual.stdout, before.stdout);
    assert.deepEqual(snapshot(), files);
  },
);

parityCase(
  'receipt verification preserves stdout, code and task files',
  () => {
    const files = snapshot();
    const before = cliRun(['task', 'verify', taskDir]);
    assert.equal(before.exitCode, 0, before.stdout + before.stderr);
    return { files, before };
  },
  async (t, { files, before }) => {
    const started = performance.now();
    const actual = await runTaskRuntime(request, root, env);
    t.diagnostic(
      `CLI verify ${before.ms.toFixed(1)} ms; thread verify ${(performance.now() - started).toFixed(1)} ms`,
    );
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.equal(actual.stdout, before.stdout);
    assert.deepEqual(snapshot(), files);
  },
);

for (const mutation of ['binding', 'receipt', 'tooling', 'partial'] as const) {
  parityCase(
    `${mutation} refusal preserves envelope and code`,
    () => {
      const file =
        mutation === 'tooling'
          ? JSON.parse(
              fs.readFileSync(path.join(taskDir, 'artifacts/harness-provenance.json'), 'utf8'),
            ).resolvedExecutable
          : path.join(
              taskDir,
              mutation === 'binding'
                ? 'inputs/recipe-binding.json'
                : 'artifacts/harness-provenance.json',
            );
      const original = fs.readFileSync(file);
      if (mutation === 'partial') fs.unlinkSync(file);
      else if (mutation === 'binding') fs.writeFileSync(file, '{"identity":17}');
      else if (mutation === 'receipt') fs.writeFileSync(file, '{}');
      else fs.appendFileSync(file, '\n// changed');
      try {
        const before = cliRun(
          mutation === 'partial'
            ? ['internal', 'task-init', wireRequest()]
            : ['task', 'verify', taskDir],
        );
        assert.notEqual(before.exitCode, 0);
        return { before, file, original };
      } catch (error) {
        fs.writeFileSync(file, original);
        throw error;
      }
    },
    async (_t, { before, file, original }) => {
      try {
        const actual = await runTaskRuntime(
          mutation === 'partial'
            ? { ...request, action: 'init', taskPath: wireRequest() }
            : request,
          root,
          env,
        );
        assert.notEqual(actual.exitCode, 0);
        assert.equal(actual.exitCode, before.exitCode, actual.stdout + actual.stderr);
        assert.equal(actual.stdout, before.stdout);
      } finally {
        fs.writeFileSync(file, original);
      }
    },
  );
}

test('runtime transport rejects malformed actions, paths and environments', () => {
  assert.deepEqual(parseTaskRuntimeRequest(request), request);
  for (const invalid of [
    { action: 'mark' },
    { taskPath: '../task' },
    { env: { PATH: 17 } },
    { env: { 'bad key': 'value' } },
  ])
    assert.throws(
      () => parseTaskRuntimeRequest({ ...request, ...invalid }),
      /Invalid task runtime/,
    );
});

test('task threads keep machine providers, pack roots and module environment isolated', async () => {
  const fakeCli = path.join(root, 'environment-cli');
  fs.mkdirSync(path.join(fakeCli, 'src/commands'), { recursive: true });
  fs.mkdirSync(path.join(fakeCli, 'bin'));
  fs.writeFileSync(path.join(fakeCli, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(fakeCli, 'bin/farmslot.mjs'), '');
  fs.writeFileSync(path.join(fakeCli, 'tsconfig.json'), '{}');
  fs.mkdirSync(path.join(fakeCli, 'src/onboarding'));
  fs.writeFileSync(
    path.join(fakeCli, 'src/onboarding/env-file.ts'),
    'export function loadCheckoutEnv() {}',
  );
  fs.writeFileSync(
    path.join(fakeCli, 'src/onboarding/workspace.ts'),
    'export const repoRoot = "/fixture"; export function bootstrapFarmslotHome() {}',
  );
  fs.copyFileSync(
    path.join(repo, 'packages/cli/src/envelope.ts'),
    path.join(fakeCli, 'src/envelope.ts'),
  );
  fs.writeFileSync(
    path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
    `
    const provider = process.env.MM_HARNESS_PACKAGE_ROOT;
    export async function runHostedTaskInit() {
      process.env.MM_HARNESS_PACKAGE_ROOT = 'provider-loaded';
      return { pid: process.pid, provider, pool: process.env.FARMSLOT_POOL_DIR,
        projects: process.env.FARMSLOT_PROJECTS_DIR, root: process.env.FARMSLOT_ROOT ?? null,
        forceColor: process.env.FORCE_COLOR ?? null };
    }
  `,
  );
  const inherited: NodeJS.ProcessEnv = {
    ...process.env,
    FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
    FARMSLOT_ROOT: '/wrong-root',
    MM_HARNESS_PACKAGE_ROOT: 'stale',
    FORCE_COLOR: '1',
  };
  delete inherited.FARMSLOT_POOL_DIR;
  delete inherited.FARMSLOT_PROJECTS_DIR;
  const parentProvider = process.env.MM_HARNESS_PACKAGE_ROOT;
  const results = await Promise.all(
    ['one', 'two'].map((provider) =>
      runTaskRuntime(
        {
          ...request,
          action: 'init',
          supportDir: '~/captured',
          env: {
            MM_HARNESS_PACKAGE_ROOT: provider,
            ...(provider === 'one' ? { FORCE_COLOR: '0' } : {}),
          },
        },
        root,
        inherited,
      ),
    ),
  );
  assert.deepEqual(
    results.map((result) => JSON.parse(result.stdout).data),
    ['one', 'two'].map((provider) => ({
      pid: process.pid,
      provider,
      pool: path.join(root, 'pool'),
      projects: path.join(inherited.HOME || os.homedir(), 'captured/projects'),
      root: null,
      forceColor: provider === 'one' ? '0' : null,
    })),
  );
  assert.equal(process.env.MM_HARNESS_PACKAGE_ROOT, parentProvider);
  assert.equal(inherited.MM_HARNESS_PACKAGE_ROOT, 'stale');
});

let providerDirectory = '';
let providerReceipt: unknown;
test('project-bound init records its selected provider receipt', { timeout: 5000 }, async () => {
  const pack = path.join(root, 'projects/provider');
  fs.mkdirSync(path.join(pack, 'templates/worker'), { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'package.json'),
    '{"type":"module","files":["provider.mjs","project.json","templates"]}',
  );
  fs.writeFileSync(
    path.join(pack, 'project.json'),
    JSON.stringify({
      name: 'provider',
      task_dir: 'tasks',
      execution_templates: { sources: [] },
      paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
      recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
    }),
  );
  fs.writeFileSync(
    path.join(pack, 'provider.mjs'),
    `
    export function createProvider() {
      return {
        runtime: { id: 'headless', sdkVersion: 1, headless: true,
          runtimeStatus: async () => ({decision:'ready', reasons:[]}), resolveSlotPorts() {},
          logSources: () => [], appLogSource: () => null, devServer: {}, hints: {}, runtimeContext: {},
          harness: { verify: async () => ({ok:true}) },
          launch: async () => { throw new Error('unexpected launch'); },
          actions: {manifestPath: () => '', semantic: [], cdpTarget: {transport:'none'}},
        }, commandOptions: {task: {stepGates: []}},
      };
    }
  `,
  );
  fs.writeFileSync(path.join(pack, 'templates/worker/dev.md'), '# Task\n\n- [ ] Observe\n');
  const selectedProvider = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('provider', path.join(pack, 'templates'))],
    flow: 'dev',
    platform: 'cli',
  });
  fs.writeFileSync(
    path.join(root, 'pool/provider.json'),
    JSON.stringify({
      machine: 'local',
      host: 'localhost',
      project: 'provider',
      platform: 'cli',
      slots: [{ id: 'provider-1', repo: checkout }],
    }),
  );
  const directory = path.join(checkout, 'tasks/dev/provider');
  fs.mkdirSync(directory, { recursive: true });
  const inputFile = path.join(directory, '.task-init-00000000-0000-4000-8000-000000000000.json');
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      version: 1,
      slotId: 'provider-1',
      binding: 'project',
      task: {
        taskDir: directory,
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Provider parity', sourceKind: 'text' },
        handoff: { surface: 'farmslot', project: 'provider', attemptId: 'provider' },
      },
      template: {
        sourceId: selectedProvider.entry.sourceId,
        id: selectedProvider.entry.id,
        sha256: selectedProvider.entry.sha256,
        selectionReason: selectedProvider.reason,
      },
    }),
  );
  const initialized = await runTaskRuntime(
    { ...request, action: 'init', taskPath: inputFile },
    root,
    env,
  );
  assert.equal(initialized.exitCode, 0, initialized.stdout + initialized.stderr);
  const receipt = JSON.parse(initialized.stdout).data.executionProvenance;
  assert.equal(receipt.bindingIdentity.project, 'provider');
  assert.equal(receipt.bindingIdentity.adapter, 'headless');
  providerDirectory = directory;
  providerReceipt = receipt;
});

parityCase(
  'project-bound verification preserves its provider receipt',
  () => {
    assert(providerDirectory);
    return cliRun(['task', 'verify', providerDirectory]);
  },
  async (_t, before) => {
    const actual = await runTaskRuntime({ ...request, taskPath: providerDirectory }, root, env);
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.equal(actual.stdout, before.stdout);
    assert.deepEqual(JSON.parse(actual.stdout), providerReceipt);
  },
);

test('early cancellation returns confirmed exit 130', async () => {
  const controller = new AbortController();
  const pending = runTaskRuntime(request, root, env, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 130);
  assert.match(result.stderr, /cancelled/);
});

for (const source of ['state', 'env-file'] as const) {
  parityCase(
    `CLI home bootstrap from ${source} selects the same pin store`,
    () => {
      const customHome = path.join(root, `custom-home-${source}`);
      const environment: NodeJS.ProcessEnv = { ...env };
      delete environment.FARMSLOT_HOME;
      if (source === 'state') {
        const workspace = path.join(root, 'custom-workspace');
        fs.mkdirSync(workspace);
        fs.writeFileSync(
          path.join(workspace, 'state.json'),
          JSON.stringify({ schema_version: 1, home_dir: customHome }),
        );
        environment.FARMSLOT_WORKSPACE = workspace;
      } else fs.writeFileSync(path.join(distribution, '.env'), `FARMSLOT_HOME=${customHome}\n`);
      const directory = path.join(checkout, `tasks/dev/home-${source}`);
      fs.mkdirSync(directory, { recursive: true });
      const input = JSON.parse(fs.readFileSync(wireRequest(), 'utf8'));
      fs.unlinkSync(path.join(taskDir, '.task-init-00000000-0000-4000-8000-000000000000.json'));
      input.task.taskDir = directory;
      const inputFile = path.join(
        directory,
        '.task-init-00000000-0000-4000-8000-000000000000.json',
      );
      fs.writeFileSync(inputFile, JSON.stringify(input));
      const initialized = cliRun(['internal', 'task-init', inputFile], environment);
      assert.equal(initialized.exitCode, 0, initialized.stdout + initialized.stderr);
      assert.equal(
        path.dirname(JSON.parse(initialized.stdout).data.executionProvenance.pin),
        path.join(customHome, 'task-pins'),
      );
      return { initialized, directory, environment };
    },
    async (_t, { initialized, directory, environment }) => {
      try {
        const verified = await runTaskRuntime(
          { ...request, taskPath: directory },
          root,
          environment,
        );
        assert.equal(verified.exitCode, 0, verified.stdout + verified.stderr);
        assert.deepEqual(
          JSON.parse(verified.stdout),
          JSON.parse(initialized.stdout).data.executionProvenance,
        );
      } finally {
        if (source === 'env-file') fs.unlinkSync(path.join(distribution, '.env'));
      }
    },
  );
}

test(
  'cancellation during provider work closes its subprocess before confirming',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const marker = path.join(root, 'running-child.json');
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: child.pid }));
      await new Promise(() => {});
    }
  `,
    );
    const controller = new AbortController();
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    );
    t.after(async () => {
      controller.abort();
      await pending;
    });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert(fs.existsSync(marker), 'provider reached its running child');
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    controller.abort();
    assert.equal((await pending).exitCode, 130);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test(
  'forced child closeout reaps the process before its thread exits',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const marker = path.join(root, 'term-resistant-child.json');
    const acknowledged = path.join(root, 'stop-acknowledged');
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import { spawn } from 'node:child_process';
    import { parentPort } from 'node:worker_threads';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      parentPort.on('message', () => fs.writeFileSync(${JSON.stringify(acknowledged)}, 'stopping'));
      spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`)}], { stdio: 'ignore' });
      await new Promise(() => {});
    }
  `,
    );
    const delay = globalThis.setTimeout;
    const waitFor = async (file: string) => {
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(file) && Date.now() < deadline)
        await new Promise((resolve) => delay(resolve, 5));
      assert(fs.existsSync(file), file);
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    );
    t.after(async () => {
      controller.abort();
      t.mock.timers.tick(10000);
      await pending;
    });
    await waitFor(marker);
    controller.abort();
    await waitFor(acknowledged);
    await new Promise((resolve) => delay(resolve, 5));
    t.mock.timers.tick(5000);
    assert.equal((await pending).exitCode, 130);
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test(
  'closed child groups are forgotten before a later cancellation',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const marker = path.join(root, 'closed-child.json');
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      await new Promise(resolve => child.once('close', resolve));
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: child.pid }));
      await new Promise(() => {});
    }
  `,
    );
    const controller = new AbortController();
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    );
    t.after(async () => {
      controller.abort();
      await pending;
    });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert(fs.existsSync(marker));
    const { pid } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const kill = process.kill;
    const retiredSignals: Parameters<typeof process.kill>[] = [];
    t.mock.method(process, 'kill', (...args: Parameters<typeof process.kill>) => {
      if (args[0] === -pid && args[1] !== 0) {
        retiredSignals.push(args);
        return true;
      }
      return kill(...args);
    });
    controller.abort();
    assert.equal((await pending).exitCode, 130);
    assert.deepEqual(retiredSignals, [], 'a retired group must never receive a later signal');
  },
);

test(
  'acknowledged closeout has a final bound when an escaped descendant holds a pipe',
  { timeout: 5000 },
  async (t) => {
    const fakeCli = path.join(root, 'environment-cli');
    const ready = path.join(root, 'escaped-descendant.json');
    const acknowledged = path.join(root, 'escaped-stop-ack');
    const exited = path.join(root, 'escaped-root-exited');
    const childCode = `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:['ignore',1,2]});
    child.unref();
    require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,escaped:child.pid}));
  `;
    fs.writeFileSync(
      path.join(fakeCli, 'src/commands/hosted-task-init.ts'),
      `
    import {spawn} from 'node:child_process';
    import {parentPort} from 'node:worker_threads';
    import fs from 'node:fs';
    export async function runHostedTaskInit() {
      parentPort.on('message',()=>fs.writeFileSync(${JSON.stringify(acknowledged)},'stopping'));
      const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}]);
      child.once('exit',()=>fs.writeFileSync(${JSON.stringify(exited)},'exited'));
      await new Promise(()=>{});
    }
  `,
    );
    const delay = globalThis.setTimeout;
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 1000;
      while (!condition() && Date.now() < deadline)
        await new Promise((resolve) => delay(resolve, 5));
      assert(condition(), 'expected closeout progress');
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const killCalls: Parameters<typeof process.kill>[] = [];
    const originalKill = process.kill;
    t.mock.method(process, 'kill', (...args: Parameters<typeof process.kill>) => {
      killCalls.push(args);
      return originalKill(...args);
    });
    const controller = new AbortController();
    let settled = false;
    const pending = runTaskRuntime(
      { ...request, action: 'init', taskPath: '/task' },
      root,
      {
        ...env,
        FARMSLOT_CLI: path.join(fakeCli, 'bin/farmslot.mjs'),
      },
      controller.signal,
    ).then((result) => {
      settled = true;
      return result;
    });
    t.after(async () => {
      controller.abort();
      t.mock.timers.tick(10000);
      if (fs.existsSync(ready)) {
        const { escaped } = JSON.parse(fs.readFileSync(ready, 'utf8'));
        try {
          process.kill(-escaped, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
      }
      await pending;
    });
    await waitFor(() => fs.existsSync(ready));
    await waitFor(() => fs.existsSync(exited));
    const { pid } = JSON.parse(fs.readFileSync(ready, 'utf8'));
    await waitFor(() => killCalls.some(([target, signal]) => target === -pid && signal === 0));
    const beforeAbort = killCalls.length;
    controller.abort();
    await waitFor(() => fs.existsSync(acknowledged));
    t.mock.timers.tick(5000);
    await waitFor(() => fs.existsSync(exited));
    assert.equal(settled, false, 'the child close is still held by its escaped descendant');
    t.mock.timers.tick(5000);
    await waitFor(() => settled);
    assert.equal((await pending).exitCode, 130);
    assert.deepEqual(
      killCalls.slice(beforeAbort).filter(([target]) => target === -pid),
      [],
      'a reaped PID must not be probed or signalled after cancellation',
    );
  },
);
